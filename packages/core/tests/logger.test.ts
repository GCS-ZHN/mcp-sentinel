import { describe, it, expect } from "bun:test";
import { setLogSink, logDebug, logInfo, logWarn, logError } from "../src/logger.js";

type Call = { level: string; message: string; extra?: Record<string, unknown> };

describe("logger", () => {
  it("logDebug calls the sink with debug level", async () => {
    const calls: Call[] = [];
    setLogSink((level, message, extra) => {
      calls.push({ level, message, extra });
    });
    logDebug("test debug", { key: "val" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("debug");
    expect(calls[0]!.message).toBe("test debug");
    expect(calls[0]!.extra).toEqual({ key: "val" });
  });

  it("logInfo calls the sink with info level", async () => {
    const calls: Call[] = [];
    setLogSink((level, message, extra) => {
      calls.push({ level, message, extra });
    });
    logInfo("test info");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("info");
    expect(calls[0]!.message).toBe("test info");
  });

  it("logWarn calls the sink with warn level", async () => {
    const calls: Call[] = [];
    setLogSink((level, message, extra) => {
      calls.push({ level, message, extra });
    });
    logWarn("test warn");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("warn");
  });

  it("logError calls the sink with error level", async () => {
    const calls: Call[] = [];
    setLogSink((level, message, extra) => {
      calls.push({ level, message, extra });
    });
    logError("test error", { detail: "ops" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.level).toBe("error");
    expect(calls[0]!.extra).toEqual({ detail: "ops" });
  });

  it("does not throw when no sink is set", () => {
    setLogSink(null);
    expect(() => logInfo("no sink")).not.toThrow();
  });

  it("does not throw when the sink throws", async () => {
    setLogSink(() => {
      throw new Error("sink failed");
    });
    expect(() => logError("will fail")).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    setLogSink(null);
  });
});
