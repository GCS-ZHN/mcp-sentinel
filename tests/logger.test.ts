import { describe, it, expect } from "bun:test";
import { setLogClient, logDebug, logInfo, logWarn, logError } from "../src/services/logger.js";

function createMockClient() {
  const calls: Array<{
    service: string;
    level: string;
    message: string;
    extra?: Record<string, unknown>;
  }> = [];

  return {
    calls,
    client: {
      app: {
        log: async (opts: {
          body?: {
            service: string;
            level: string;
            message: string;
            extra?: Record<string, unknown>;
          };
        }) => {
          if (opts.body) {
            calls.push(opts.body);
          }
          return {};
        },
      },
    },
  } as const;
}

describe("logger", () => {
  it("logDebug calls client.app.log with debug level", async () => {
    const { client, calls } = createMockClient();
    setLogClient(client as any);
    logDebug("test debug", { key: "val" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("debug");
    expect(calls[0]!.message).toBe("test debug");
    expect(calls[0]!.extra).toEqual({ key: "val" });
    expect(calls[0]!.service).toBe("mcp-sentinel");
  });

  it("logInfo calls client.app.log with info level", async () => {
    const { client, calls } = createMockClient();
    setLogClient(client as any);
    logInfo("test info");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("info");
    expect(calls[0]!.message).toBe("test info");
  });

  it("logWarn calls client.app.log with warn level", async () => {
    const { client, calls } = createMockClient();
    setLogClient(client as any);
    logWarn("test warn");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("warn");
  });

  it("logError calls client.app.log with error level", async () => {
    const { client, calls } = createMockClient();
    setLogClient(client as any);
    logError("test error", { detail: "ops" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("error");
    expect(calls[0]!.extra).toEqual({ detail: "ops" });
  });

  it("does not throw when client is not set", () => {
    setLogClient(null as any);
    expect(() => logInfo("no client")).not.toThrow();
  });

  it("does not throw when client.app.log fails", async () => {
    const failingClient = {
      app: {
        log: async () => {
          throw new Error("log failed");
        },
      },
    };
    setLogClient(failingClient as any);
    expect(() => logError("will fail")).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});
