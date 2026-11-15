import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  getOrCreateClient,
  callTool,
  disconnectAll,
  isConnectionError,
  getConnectionCount,
  parseMcpContent,
  reconcileConnections,
} from "../src/connection-pool.js";
import type { McpRemoteConfig } from "../src/types.js";

const HTTP_PORT = 19879;
const HTTP_URL = `http://localhost:${HTTP_PORT}/mcp`;
const config: McpRemoteConfig = { type: "remote", url: HTTP_URL };

describe("parseMcpContent", () => {
  it("parses a single JSON text block", () => {
    expect(parseMcpContent([{ type: "text", text: '{"status":"completed"}' }])).toEqual({
      status: "completed",
    });
  });

  it("returns a lone non-JSON text block verbatim", () => {
    expect(parseMcpContent([{ type: "text", text: "completed" }])).toBe("completed");
  });

  it("joins multiple text blocks then parses JSON", () => {
    expect(
      parseMcpContent([
        { type: "text", text: '{"a":' },
        { type: "text", text: "1}" },
      ])
    ).toEqual({ a: 1 });
  });

  it("returns the original array when there are no text blocks", () => {
    const content = [{ type: "image", data: "x" }];
    expect(parseMcpContent(content)).toBe(content);
  });

  it("passes through non-array values", () => {
    expect(parseMcpContent("already-parsed")).toBe("already-parsed");
    expect(parseMcpContent(42)).toBe(42);
  });
});

// Global server lifecycle — all test suites share one mock HTTP server
beforeAll(async () => {
  const mockServer = join(import.meta.dir, "mock-mcp-server.ts");
  const proc = Bun.spawn(["bun", mockServer, "--transport=http"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  (globalThis as any).__httpServerProc = proc;
  // Poll until the server is ready
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      await fetch(HTTP_URL, { method: "POST", body: "{}" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

afterAll(async () => {
  const proc = (globalThis as any).__httpServerProc as { kill: () => void } | undefined;
  if (proc) {
    proc.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
  await disconnectAll();
});

// --- Unit: isConnectionError ---
describe("isConnectionError", () => {
  it("detects 404 StreamableHTTPError", () => {
    expect(isConnectionError(Object.assign(new Error("POST failed"), { code: 404 }))).toBe(true);
  });

  it("detects 'Session not found' in message", () => {
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}'
    );
    expect(isConnectionError(err)).toBe(true);
  });

  it("detects 'Not connected' in message (stdio transport died)", () => {
    expect(isConnectionError(new Error("Not connected"))).toBe(true);
  });

  it("returns false for null / undefined", () => {
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError(new Error("Tool not found"))).toBe(false);
    expect(isConnectionError(new Error("Invalid JSON"))).toBe(false);
  });

  it("detects 'Connection closed' (concurrent close race)", () => {
    const err = Object.assign(new Error("MCP error -32000: Connection closed"), { code: -32000 });
    expect(isConnectionError(err)).toBe(true);
  });

  it("detects network errors", () => {
    expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(true);
    expect(isConnectionError(new Error("read ECONNRESET"))).toBe(true);
    expect(isConnectionError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isConnectionError(new Error("fetch failed"))).toBe(true);
  });

  it("detects server errors (5xx) as recoverable", () => {
    expect(isConnectionError(Object.assign(new Error("oops"), { code: 500 }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("oops"), { code: 502 }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("oops"), { code: 503 }))).toBe(true);
  });

  it("returns false for client errors other than 404", () => {
    expect(isConnectionError(Object.assign(new Error("Forbidden"), { code: 403 }))).toBe(false);
    expect(isConnectionError(Object.assign(new Error("Unauthorized"), { code: 401 }))).toBe(false);
  });
});

// --- Integration: session expiry reconnection ---
describe("callTool reconnects on session expiry", () => {
  const EXPIRE_AFTER = 3;

  it("recovers and returns valid result after session expiry", async () => {
    const client = await getOrCreateClient("sentinel-http-test", config);

    for (let i = 1; i <= EXPIRE_AFTER; i++) {
      const r = await callTool(client, "submit_job", { name: `job-${i}` });
      expect(r).toHaveProperty("job_id");
    }

    const r = await callTool(client, "submit_job", { name: "after-expiry" });
    expect(r).toHaveProperty("job_id");
  });

  it("subsequent calls work with the newly cached connection", async () => {
    const client = await getOrCreateClient("sentinel-http-test", config);
    const r = await callTool(client, "get_job_status", { job_id: "any" });
    expect(r).toBeDefined();
  });
});

// --- Edge cases ---
describe("connection manager edge cases", () => {
  it("getConnectionCount reflects cache size", async () => {
    await disconnectAll();
    expect(getConnectionCount()).toBe(0);

    const client = await getOrCreateClient("count-test", config);
    expect(getConnectionCount()).toBe(1);

    const client2 = await getOrCreateClient("count-test", config);
    expect(client2).toBe(client);
    expect(getConnectionCount()).toBe(1);

    await disconnectAll();
    expect(getConnectionCount()).toBe(0);
  });

  it("disconnectAll handles empty cache", async () => {
    await disconnectAll();
    await disconnectAll();
    expect(getConnectionCount()).toBe(0);
  });

  it("reconnects when local cwd or env changes (config fix must not reuse stale client)", async () => {
    await disconnectAll();
    const mockServer = join(import.meta.dir, "mock-mcp-server.ts");
    const base = { type: "local" as const, command: ["bun", mockServer] };

    const baseClient = await getOrCreateClient("key-test", base);
    expect(await getOrCreateClient("key-test", base)).toBe(baseClient);

    const cwdClient = await getOrCreateClient("key-test", { ...base, cwd: import.meta.dir });
    const envClient = await getOrCreateClient("key-test", { ...base, env: { SENTINEL_TEST: "1" } });

    expect(cwdClient).not.toBe(baseClient);
    expect(envClient).not.toBe(baseClient);
    expect(envClient).not.toBe(cwdClient);
    expect(getConnectionCount()).toBe(3);

    // same full config still reuses its cached client
    expect(await getOrCreateClient("key-test", { ...base, cwd: import.meta.dir })).toBe(cwdClient);

    await disconnectAll();
    expect(getConnectionCount()).toBe(0);
  });
});

// --- Reconciliation: host config changes must not leak connections ---
describe("reconcileConnections", () => {
  it("closes connections for servers that were removed", async () => {
    await disconnectAll();
    await getOrCreateClient("rec-keep", config);
    await getOrCreateClient("rec-gone", config);
    expect(getConnectionCount()).toBe(2);

    const result = await reconcileConnections({ servers: { "rec-keep": config } });

    expect(result.closed).toEqual(["rec-gone"]);
    expect(result.kept).toBe(1);
    expect(getConnectionCount()).toBe(1);

    await disconnectAll();
  });

  it("closes the old connection when a server's config changed", async () => {
    await disconnectAll();
    await getOrCreateClient("rec-changed", config);
    expect(getConnectionCount()).toBe(1);

    const moved: McpRemoteConfig = { type: "remote", url: `${HTTP_URL}?v=2` };
    const result = await reconcileConnections({ servers: { "rec-changed": moved } });

    expect(result.closed).toEqual(["rec-changed"]);
    expect(result.kept).toBe(0);
    expect(getConnectionCount()).toBe(0);

    await disconnectAll();
  });

  it("keeps unchanged connections", async () => {
    await disconnectAll();
    const client = await getOrCreateClient("rec-same", config);

    const result = await reconcileConnections({ servers: { "rec-same": config } });

    expect(result.closed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(await getOrCreateClient("rec-same", config)).toBe(client);

    await disconnectAll();
  });

  it("treats a disabled server as removed", async () => {
    await disconnectAll();
    await getOrCreateClient("rec-disabled", config);

    const result = await reconcileConnections({
      servers: { "rec-disabled": { ...config, enabled: false } },
    });

    expect(result.closed).toEqual(["rec-disabled"]);
    expect(getConnectionCount()).toBe(0);

    await disconnectAll();
  });

  it("closes everything for an empty config", async () => {
    await disconnectAll();
    await getOrCreateClient("rec-a", config);
    await getOrCreateClient("rec-b", config);

    const result = await reconcileConnections({ servers: {} });

    expect(result.closed.sort()).toEqual(["rec-a", "rec-b"]);
    expect(result.kept).toBe(0);
    expect(getConnectionCount()).toBe(0);
  });

  it("keeps a server that another scope configures differently", async () => {
    await disconnectAll();
    const mockServer = join(import.meta.dir, "mock-mcp-server.ts");
    const base = { type: "local" as const, command: ["bun", mockServer] };
    const withCwd = { ...base, cwd: import.meta.dir };

    await getOrCreateClient("multi", base);
    await getOrCreateClient("multi", withCwd);
    expect(getConnectionCount()).toBe(2);

    const result = await reconcileConnections([
      { servers: { multi: base } },
      { servers: { multi: withCwd } },
    ]);

    expect(result.closed).toEqual([]);
    expect(result.kept).toBe(2);
    expect(getConnectionCount()).toBe(2);

    await disconnectAll();
  });
});

// --- Concurrency: dual sessions sharing a cached client ---
describe("concurrent reconnection (multiple sessions)", () => {
  it("two callTool on same dead client — both recover via WeakMap fallback", async () => {
    const client = await getOrCreateClient("dual-session-test", config);

    for (let i = 1; i <= 3; i++) {
      await callTool(client, "submit_job", { name: `dual-${i}` });
    }

    const [r1, r2] = await Promise.all([
      callTool(client, "submit_job", { name: "concurrent-A" }),
      callTool(client, "submit_job", { name: "concurrent-B" }),
    ]);

    expect(r1).toHaveProperty("job_id");
    expect(r2).toHaveProperty("job_id");
  });

  it("concurrent getOrCreateClient creates exactly one connection", async () => {
    await disconnectAll();
    expect(getConnectionCount()).toBe(0);

    const clients = await Promise.all([
      getOrCreateClient("dedup-test", config),
      getOrCreateClient("dedup-test", config),
      getOrCreateClient("dedup-test", config),
    ]);

    expect(clients[0]).toBe(clients[1]);
    expect(clients[1]).toBe(clients[2]);
    expect(getConnectionCount()).toBe(1);

    await disconnectAll();
  });
});
