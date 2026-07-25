import { describe, it, expect } from "bun:test";
import { parseMcpConfig, lookupServer } from "../src/services/config-reader.js";

describe("config-reader", () => {
  it("returns empty servers for undefined input", () => {
    const config = parseMcpConfig(undefined);
    expect(config.servers).toEqual({});
  });

  it("returns empty servers for non-object input", () => {
    const config = parseMcpConfig("string");
    expect(config.servers).toEqual({});
  });

  it("returns empty servers for null input", () => {
    const config = parseMcpConfig(null);
    expect(config.servers).toEqual({});
  });

  it("parses local (stdio) server config with command array", () => {
    const config = parseMcpConfig({
      mcp: {
        myserver: {
          type: "local",
          command: ["node", "server.js"],
          env: { NODE_ENV: "production" },
          enabled: true,
        },
      },
    });

    expect(config.servers.myserver).toBeDefined();
    expect(config.servers.myserver!.type).toBe("local");
    const local = config.servers.myserver as { type: "local"; command: string[] };
    expect(local.command).toEqual(["node", "server.js"]);
  });

  it("parses local server with string command + args", () => {
    const config = parseMcpConfig({
      mcp: {
        srv: {
          type: "stdio",
          command: "python",
          args: ["script.py"],
        },
      },
    });

    expect(config.servers.srv).toBeDefined();
    const local = config.servers.srv as { type: "local"; command: string[] };
    expect(local.command).toEqual(["python", "script.py"]);
  });

  it("parses remote server config", () => {
    const config = parseMcpConfig({
      mcp: {
        remote: {
          type: "remote",
          url: "http://localhost:3000",
          headers: { Authorization: "Bearer token" },
        },
      },
    });

    expect(config.servers.remote).toBeDefined();
    expect(config.servers.remote!.type).toBe("remote");
    const remote = config.servers.remote as { type: "remote"; url: string };
    expect(remote.url).toBe("http://localhost:3000");
  });

  it("parses multiple servers", () => {
    const config = parseMcpConfig({
      mcp: {
        s1: { type: "local", command: ["cmd1"] },
        s2: { type: "remote", url: "http://localhost:4000" },
      },
    });

    expect(Object.keys(config.servers)).toHaveLength(2);
  });

  it("handles missing mcp key", () => {
    const config = parseMcpConfig({ other: "stuff" });
    expect(config.servers).toEqual({});
  });

  it("handles empty mcp object", () => {
    const config = parseMcpConfig({ mcp: {} });
    expect(config.servers).toEqual({});
  });

  it("lookupServer finds server by name", () => {
    const config = parseMcpConfig({
      mcp: { test: { type: "remote", url: "http://localhost" } },
    });

    const found = lookupServer(config, "test");
    expect(found).toBeDefined();
    expect(found!.type).toBe("remote");

    const notFound = lookupServer(config, "missing");
    expect(notFound).toBeNull();
  });

  it("lookupServer respects enabled:false", () => {
    const config = parseMcpConfig({
      mcp: {
        enabled_server: { type: "remote", url: "http://localhost", enabled: true },
        disabled_server: { type: "remote", url: "http://localhost", enabled: false },
      },
    });

    expect(lookupServer(config, "enabled_server")).toBeDefined();
    expect(lookupServer(config, "disabled_server")).toBeNull();
  });

  it("skips servers with unsupported types", () => {
    const config = parseMcpConfig({
      mcp: {
        weird: { type: "unknown", foo: "bar" },
      },
    });

    expect(config.servers.weird).toBeUndefined();
  });
});
