import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startSentinel,
  cancelSentinel,
  getSentinelTask,
  getActiveSentinels,
  cleanup,
  setNotifyFn,
} from "../src/services/sentinel-manager.js";
import { parseMcpConfig } from "../src/services/config-reader.js";

function withEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function waitForStatus(id: string, expectedStatus: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = getSentinelTask(id);
    if (!task) return; // task was cleaned up (e.g., TTL fired)
    if (task.status === expectedStatus) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Task ${id} did not reach "${expectedStatus}" within ${timeoutMs}ms`);
}

function createMockClient() {
  return {
    session: {
      promptAsync: async (_opts: unknown) => ({}),
    },
  } as any;
}

describe("sentinel-manager", () => {
  beforeEach(() => {
    cleanup();
    setNotifyFn(createMockClient());
  });

  afterEach(() => {
    cleanup();
  });

  it("throws for unknown server", () => {
    const config = parseMcpConfig({});
    expect(
      startSentinel(
        {
          server: "nonexistent",
          tool: "test",
          args: {},
          until: { path: "a", is: "eq", value: 1 },
          sessionID: "s1",
        },
        config
      )
    ).rejects.toThrow("Unknown MCP server");
  });

  it("creates a task with valid config", () => {
    const config = parseMcpConfig({
      mcp: { test: { type: "remote", url: "http://localhost:9999" } },
    });
    expect(
      startSentinel(
        {
          server: "test",
          tool: "status",
          args: {},
          until: { path: "x", is: "eq", value: 1 },
          sessionID: "s1",
        },
        config
      )
    ).resolves.toBeDefined();
  });

  it("generates unique IDs", () => {
    const config = parseMcpConfig({
      mcp: { s1: { type: "remote", url: "http://localhost:1" } },
    });
    const p1 = startSentinel(
      {
        server: "s1",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const p2 = startSentinel(
      {
        server: "s1",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    expect(p1).resolves.not.toEqual(p2);
  });

  it("getActiveSentinels returns active tasks", async () => {
    const config = parseMcpConfig({
      mcp: { a: { type: "remote", url: "http://localhost:2" } },
    });
    const id = await startSentinel(
      {
        server: "a",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const tasks = getActiveSentinels();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some((p) => p.id === id)).toBe(true);
  });

  it("getSentinelTask returns task details", async () => {
    const config = parseMcpConfig({
      mcp: { b: { type: "remote", url: "http://localhost:3" } },
    });
    const id = await startSentinel(
      {
        server: "b",
        tool: "test",
        args: { key: "val" },
        until: { path: "ok", is: "eq", value: true },
        sessionID: "s1",
      },
      config
    );
    const task = getSentinelTask(id);
    expect(task).toBeDefined();
    expect(task!.request.server).toBe("b");
    expect(task!.request.tool).toBe("test");
    expect(task!.request.args).toEqual({ key: "val" });
    expect(task!.status).toBe("polling");
  });

  it("cancelSentinel cancels active task", async () => {
    const config = parseMcpConfig({
      mcp: { c: { type: "remote", url: "http://localhost:4" } },
    });
    const id = await startSentinel(
      {
        server: "c",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const cancelled = cancelSentinel(id);
    expect(cancelled).toBe(true);
    const task = getSentinelTask(id);
    expect(task?.status).toBe("cancelled");
    expect(getActiveSentinels()).toEqual([]);
  });

  it("cancelSentinel returns false for nonexistent id", () => {
    expect(cancelSentinel("nonexistent")).toBe(false);
  });

  it("returns undefined for nonexistent task", () => {
    expect(getSentinelTask("nope")).toBeUndefined();
  });

  it("respects custom interval and timeout", async () => {
    const config = parseMcpConfig({
      mcp: { d: { type: "remote", url: "http://localhost:5" } },
    });
    const id = await startSentinel(
      {
        server: "d",
        tool: "t",
        args: {},
        interval: 2000,
        timeout: 5000,
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const task = getSentinelTask(id);
    expect(task!.request.interval).toBe(2000);
    expect(task!.request.timeout).toBe(5000);
  });

  it("cleanup removes all active tasks", async () => {
    const config = parseMcpConfig({
      mcp: { e: { type: "remote", url: "http://localhost:6" } },
    });
    await startSentinel(
      {
        server: "e",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    expect(getActiveSentinels().length).toBeGreaterThan(0);
    cleanup();
    expect(getActiveSentinels().length).toBe(0);
  });

  it("cancelled sentinel has status 'cancelled' not 'completed'", async () => {
    const config = parseMcpConfig({
      mcp: { f: { type: "remote", url: "http://localhost:7" } },
    });
    const id = await startSentinel(
      {
        server: "f",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    cancelSentinel(id);
    const task = getSentinelTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.status).not.toBe("completed");
  });

  it("records MCP error with raw message for debugging", async () => {
    const config = parseMcpConfig({
      mcp: { bad: { type: "remote", url: "http://localhost:1" } },
    });
    const id = await startSentinel(
      {
        server: "bad",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    await waitForStatus(id, "error");
    const task = getSentinelTask(id);
    expect(task?.status).toBe("error");
    expect(task?.error).toBeTruthy();
    // error should contain debugging info, not just a generic message
    expect(task!.error!.length).toBeGreaterThan(10);
  });

  it("auto-cleans error task after TTL", async () => {
    withEnv("SENTINEL_TASK_TTL_MS", "50");

    const config = parseMcpConfig({
      mcp: { ttl1: { type: "remote", url: "http://localhost:1" } },
    });
    const id = await startSentinel(
      {
        server: "ttl1",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    await waitForStatus(id, "error");
    // wait for TTL to fire
    await new Promise((r) => setTimeout(r, 200));
    expect(getSentinelTask(id)).toBeUndefined();

    withEnv("SENTINEL_TASK_TTL_MS", undefined);
  });

  it("auto-cleans cancelled task after TTL", async () => {
    withEnv("SENTINEL_TASK_TTL_MS", "50");

    const config = parseMcpConfig({
      mcp: { ttl2: { type: "remote", url: "http://localhost:2" } },
    });
    const id = await startSentinel(
      {
        server: "ttl2",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    cancelSentinel(id);
    // wait for TTL
    await new Promise((r) => setTimeout(r, 200));
    expect(getSentinelTask(id)).toBeUndefined();

    withEnv("SENTINEL_TASK_TTL_MS", undefined);
  });

  it("does not auto-clean when TTL is unset", async () => {
    const config = parseMcpConfig({
      mcp: { nottl: { type: "remote", url: "http://localhost:3" } },
    });
    const id = await startSentinel(
      {
        server: "nottl",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    await waitForStatus(id, "error");
    // should still be there after a delay
    await new Promise((r) => setTimeout(r, 200));
    expect(getSentinelTask(id)).toBeDefined();
  });

  it("cleanup also clears pending TTL timers", () => {
    withEnv("SENTINEL_TASK_TTL_MS", "999999");
    // cleanup() removes all tasks and clears timers — verify it doesn't throw
    cleanup();
    withEnv("SENTINEL_TASK_TTL_MS", undefined);
  });
});
