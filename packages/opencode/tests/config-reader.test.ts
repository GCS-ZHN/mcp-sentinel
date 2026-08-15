import { describe, it, expect } from "bun:test";
import { parseOpencodeMcpConfig } from "../src/config.js";
import { makeServerResolver } from "@gcszhn/mcp-sentinel-core";

describe("config-reader", () => {
  it("returns empty servers for undefined input", () => {
    const config = parseOpencodeMcpConfig(undefined);
    expect(config.servers).toEqual({});
  });

  it("returns empty servers for non-object input", () => {
    const config = parseOpencodeMcpConfig("string");
    expect(config.servers).toEqual({});
  });

  it("returns empty servers for null input", () => {
    const config = parseOpencodeMcpConfig(null);
    expect(config.servers).toEqual({});
  });

  it("parses local (stdio) server config with command array", () => {
    const config = parseOpencodeMcpConfig({
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
    const config = parseOpencodeMcpConfig({
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
    const config = parseOpencodeMcpConfig({
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
    const config = parseOpencodeMcpConfig({
      mcp: {
        s1: { type: "local", command: ["cmd1"] },
        s2: { type: "remote", url: "http://localhost:4000" },
      },
    });

    expect(Object.keys(config.servers)).toHaveLength(2);
  });

  it("handles missing mcp key", () => {
    const config = parseOpencodeMcpConfig({ other: "stuff" });
    expect(config.servers).toEqual({});
  });

  it("handles empty mcp object", () => {
    const config = parseOpencodeMcpConfig({ mcp: {} });
    expect(config.servers).toEqual({});
  });

  it("makeServerResolver resolves a server by name", () => {
    const config = parseOpencodeMcpConfig({
      mcp: { test: { type: "remote", url: "http://localhost" } },
    });

    const resolve = makeServerResolver(config);
    const found = resolve("test");
    expect(found).toBeDefined();
    expect(found!.type).toBe("remote");

    const notFound = resolve("missing");
    expect(notFound).toBeNull();
  });

  it("makeServerResolver respects enabled:false", () => {
    const config = parseOpencodeMcpConfig({
      mcp: {
        enabled_server: { type: "remote", url: "http://localhost", enabled: true },
        disabled_server: { type: "remote", url: "http://localhost", enabled: false },
      },
    });

    const resolve = makeServerResolver(config);
    expect(resolve("enabled_server")).toBeDefined();
    expect(resolve("disabled_server")).toBeNull();
  });

  it("skips servers with unsupported types", () => {
    const config = parseOpencodeMcpConfig({
      mcp: {
        weird: { type: "unknown", foo: "bar" },
      },
    });

    expect(config.servers.weird).toBeUndefined();
  });

  it("infers local transport from command when type is absent", () => {
    const config = parseOpencodeMcpConfig({
      mcp: {
        inferredLocal: {
          command: "bun",
          args: ["run", "server.ts"],
          cwd: "/tmp",
          env: { KEY: "value" },
        },
      },
    });

    expect(config.servers.inferredLocal).toBeDefined();
    const local = config.servers.inferredLocal as {
      type: "local";
      command: string[];
      cwd?: string;
    };
    expect(local.type).toBe("local");
    expect(local.command).toEqual(["bun", "run", "server.ts"]);
    expect(local.cwd).toBe("/tmp");
  });

  it("infers remote transport from url when type is absent", () => {
    const config = parseOpencodeMcpConfig({
      mcp: {
        inferredRemote: {
          url: "https://example.com/mcp",
        },
      },
    });

    expect(config.servers.inferredRemote).toBeDefined();
    expect(config.servers.inferredRemote!.type).toBe("remote");
  });
});
