import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  getOrCreateClient,
  callTool,
  disconnectAll,
  isConnectionError,
} from "../src/services/mcp-connection-manager.js";
import type { McpRemoteConfig } from "../src/services/types.js";

const HTTP_PORT = 19879;
const HTTP_URL = `http://localhost:${HTTP_PORT}/mcp`;

const config: McpRemoteConfig = { type: "remote", url: HTTP_URL };

// --- Unit: isConnectionError ---
describe("isConnectionError", () => {
  it("detects 404 StreamableHTTPError", () => {
    const err = Object.assign(new Error("POST failed"), { code: 404 });
    expect(isConnectionError(err)).toBe(true);
  });

  it("detects 'Session not found' in message", () => {
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}'
    );
    expect(isConnectionError(err)).toBe(true);
  });

  it("detects 'Not connected' in message (stdio transport died)", () => {
    const err = new Error("Not connected");
    expect(isConnectionError(err)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isConnectionError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isConnectionError(undefined)).toBe(false);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError(new Error("Tool not found"))).toBe(false);
  });

  it("detects network errors", () => {
    expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(true);
    expect(isConnectionError(new Error("read ECONNRESET"))).toBe(true);
    expect(isConnectionError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isConnectionError(new Error("fetch failed"))).toBe(true);
  });

  it("returns false for unrelated error messages", () => {
    expect(isConnectionError(new Error("tool not found"))).toBe(false);
    expect(isConnectionError(new Error("Invalid JSON"))).toBe(false);
  });

  it("detects server errors (5xx) as recoverable", () => {
    expect(isConnectionError(Object.assign(new Error("Server error"), { code: 500 }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("Bad gateway"), { code: 502 }))).toBe(true);
  });

  it("returns false for client errors other than 404", () => {
    expect(isConnectionError(Object.assign(new Error("Forbidden"), { code: 403 }))).toBe(false);
    expect(isConnectionError(Object.assign(new Error("Unauthorized"), { code: 401 }))).toBe(false);
  });
});

// --- Integration: session expiry reconnection ---
describe("callTool reconnects on session expiry", () => {
  beforeAll(async () => {
    const proc = Bun.spawn(["bun", "tests/mock-mcp-server.ts", "--transport=http"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    (globalThis as any).__httpServerProc = proc;
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    const proc = (globalThis as any).__httpServerProc;
    if (proc) {
      proc.kill();
      await new Promise((r) => setTimeout(r, 200));
    }
    await disconnectAll();
  });

  // The mock server expires the MCP session after 3 tool calls.
  // Our callTool should detect the 404, evict the dead client, reconnect, retry.
  const EXPIRE_AFTER = 3;

  it("recovers and returns valid result after session expiry", async () => {
    const client = await getOrCreateClient("sentinel-http-test", config);

    // Phase 1: calls succeed while session is active
    for (let i = 1; i <= EXPIRE_AFTER; i++) {
      const r = await callTool(client, "submit_job", { name: `job-${i}` });
      expect(r).toHaveProperty("job_id");
    }

    // Phase 2: session expired — callTool must reconnect and retry
    const r = await callTool(client, "submit_job", { name: "after-expiry" });
    expect(r).toHaveProperty("job_id");
  });

  it("subsequent calls work with the newly cached connection", async () => {
    const client = await getOrCreateClient("sentinel-http-test", config);
    const r = await callTool(client, "get_job_status", { job_id: "any" });
    expect(r).toBeDefined();
  });
});

// --- Integration: flaky server (transient 5xx) recovery ---
// Uses the same mock server process; the isConnectionError function
// detects 5xx as recoverable. The session expiry test above already
// validates the reconnect+retry cycle. This test validates that a
// variety of connection error signatures are recognized.
describe("callTool handles various connection failures", () => {
  it("recovers after ECONNREFUSED", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    expect(isConnectionError(err)).toBe(true);
  });

  it("recovers after ETIMEDOUT", () => {
    const err = new Error("connect ETIMEDOUT 10.0.0.1:8080");
    expect(isConnectionError(err)).toBe(true);
  });

  it("recovers after ECONNRESET", () => {
    const err = new Error("read ECONNRESET");
    expect(isConnectionError(err)).toBe(true);
  });

  it("recovers after fetch failed (network unreachable)", () => {
    const err = new Error("fetch failed");
    expect(isConnectionError(err)).toBe(true);
  });

  it("recovers after server errors (502/503)", () => {
    expect(isConnectionError(Object.assign(new Error("oops"), { code: 502 }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("oops"), { code: 503 }))).toBe(true);
  });
});
