import { describe, it, expect } from "bun:test";
import {
  describeServerProblem,
  findMcpEntry,
  normalizeOpencode2McpConfig,
  serverHasHeaders,
  serverUsesOAuth,
} from "../src/config.js";
import type { Opencode2McpEntry, Opencode2McpServerConfig } from "../src/config.js";
import { makeServerResolver } from "@gcszhn/mcp-sentinel-core";

function entries(map: Record<string, Opencode2McpServerConfig>): Opencode2McpEntry[] {
  return Object.entries(map);
}

describe("normalizeOpencode2McpConfig", () => {
  it("returns an empty server map for undefined/null/empty input", () => {
    expect(normalizeOpencode2McpConfig(undefined).servers).toEqual({});
    expect(normalizeOpencode2McpConfig(null).servers).toEqual({});
    expect(normalizeOpencode2McpConfig([]).servers).toEqual({});
  });

  it("normalizes a V2 local server (environment, disabled inverse)", () => {
    const config = normalizeOpencode2McpConfig(
      entries({
        docs: {
          type: "local",
          command: ["bun", "run", "server.ts"],
          cwd: "/tmp/work",
          environment: { TOKEN: "abc" },
          disabled: false,
        },
      })
    );

    const server = config.servers.docs;
    expect(server).toBeDefined();
    expect(server!.type).toBe("local");
    const local = server as {
      type: "local";
      command: string[];
      cwd?: string;
      env?: Record<string, string>;
      enabled?: boolean;
    };
    expect(local.command).toEqual(["bun", "run", "server.ts"]);
    expect(local.cwd).toBe("/tmp/work");
    expect(local.env).toEqual({ TOKEN: "abc" });
    expect(local.enabled).toBe(true);
  });

  it("maps disabled:true to enabled:false so the core resolver excludes it", () => {
    const config = normalizeOpencode2McpConfig(
      entries({ off: { type: "local", command: ["node"], disabled: true } })
    );
    expect(config.servers.off!.enabled).toBe(false);
    expect(makeServerResolver(config)("off")).toBeNull();
  });

  it("normalizes a V2 remote server with headers", () => {
    const config = normalizeOpencode2McpConfig(
      entries({
        remote: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      })
    );

    const server = config.servers.remote;
    expect(server).toBeDefined();
    expect(server!.type).toBe("remote");
    const remote = server as { type: "remote"; url: string; headers?: Record<string, string> };
    expect(remote.url).toBe("https://example.com/mcp");
    expect(remote.headers).toEqual({ Authorization: "Bearer token" });
  });

  it("skips malformed entries instead of producing unusable configs", () => {
    const config = normalizeOpencode2McpConfig(
      entries({
        noCommand: { type: "local" },
        emptyCommand: { type: "local", command: [] },
        nonStringCommand: { type: "local", command: ["node", 42] },
        emptyUrl: { type: "remote", url: "" },
        unknownType: { type: "sse", url: "https://example.com" },
      })
    );

    expect(config.servers).toEqual({});
  });

  it("does not mistake a `servers` wrapper for a server", () => {
    // If a caller ever passes the raw `mcp` object instead of `editor.list()`,
    // the `servers` wrapper has no type/command/url and must be skipped rather
    // than treated as a server named "servers".
    const config = normalizeOpencode2McpConfig(
      entries({ servers: { docs: { type: "local", command: ["node"] } } })
    );
    expect(config.servers.servers).toBeUndefined();
  });

  it("keeps a server literally named __proto__ without polluting prototypes", () => {
    const parsed = JSON.parse('{"__proto__":{"type":"local","command":["node"]}}') as Record<
      string,
      Opencode2McpServerConfig
    >;
    const config = normalizeOpencode2McpConfig(Object.entries(parsed));

    expect(Object.hasOwn(config.servers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(config.servers)).toBeNull();
    expect(makeServerResolver(config)("__proto__")).not.toBeNull();
  });
});

describe("findMcpEntry / auth helpers", () => {
  const list = entries({
    local: { type: "local", command: ["node"] },
    oauth: { type: "remote", url: "https://example.com", oauth: { scope: "read" } },
    headers: { type: "remote", url: "https://example.com", headers: { Authorization: "x" } },
    plain: { type: "remote", url: "https://example.com", oauth: false },
  });

  it("finds entries by exact name only", () => {
    expect(findMcpEntry(list, "oauth")?.[1].type).toBe("remote");
    expect(findMcpEntry(list, "missing")).toBeUndefined();
    expect(findMcpEntry(list, "__proto__")).toBeUndefined();
  });

  it("detects OAuth only when oauth is not false", () => {
    expect(serverUsesOAuth(findMcpEntry(list, "oauth"))).toBe(true);
    expect(serverUsesOAuth(findMcpEntry(list, "plain"))).toBe(false);
    expect(serverUsesOAuth(findMcpEntry(list, "local"))).toBe(false);
  });

  it("detects non-empty static headers", () => {
    expect(serverHasHeaders(findMcpEntry(list, "headers"))).toBe(true);
    expect(serverHasHeaders(findMcpEntry(list, "plain"))).toBe(false);
  });
});

describe("describeServerProblem", () => {
  const list = entries({
    ok: { type: "local", command: ["node", "server.js"] },
    disabled: { type: "local", command: ["node"], disabled: true },
    broken: { type: "local" },
    oauth: { type: "remote", url: "https://example.com/mcp", oauth: {} },
    oauthWithHeaders: {
      type: "remote",
      url: "https://example.com/mcp",
      oauth: {},
      headers: { Authorization: "Bearer token" },
    },
  });

  it("lets the core report empty server names", () => {
    expect(describeServerProblem(list, "")).toBeUndefined();
    expect(describeServerProblem(list, "   ")).toBeUndefined();
  });

  it("reports unknown servers", () => {
    expect(describeServerProblem(list, "nope")).toBe("Error: Unknown MCP server: nope");
  });

  it("reports disabled servers explicitly", () => {
    expect(describeServerProblem(list, "disabled")).toContain("is disabled");
  });

  it("reports malformed server configs", () => {
    expect(describeServerProblem(list, "broken")).toContain("unsupported configuration");
  });

  it("reports a needs_auth server that has no static headers", () => {
    const problem = describeServerProblem(list, "oauth", { status: "needs_auth" });
    expect(problem).toContain("requires OAuth authentication");
    expect(problem).toContain("cannot reuse");
  });

  it("allows a needs_auth server when static headers are configured", () => {
    expect(
      describeServerProblem(list, "oauthWithHeaders", { status: "needs_auth" })
    ).toBeUndefined();
  });

  it("allows usable servers", () => {
    expect(describeServerProblem(list, "ok", { status: "connected" })).toBeUndefined();
  });
});
