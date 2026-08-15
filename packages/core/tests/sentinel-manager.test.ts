import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startSentinel,
  cancelSentinel,
  getSentinelTask,
  getActiveSentinels,
  cleanup,
  setNotifier,
} from "../src/engine.js";
import { makeServerResolver } from "../src/resolver.js";
import { makeConnectionInvoker } from "../src/connection-pool.js";
import { handleRead } from "../src/tools.js";
import type { McpConfig } from "../src/types.js";

/** Build a connection-pool-mode invoker for tests that register MCP config. */
function invoker(config: McpConfig) {
  return makeConnectionInvoker(makeServerResolver(config));
}

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

describe("sentinel-manager", () => {
  beforeEach(() => {
    cleanup();
    setNotifier(() => {});
  });

  afterEach(() => {
    cleanup();
    setNotifier(null);
  });

  it("records error for unknown server", async () => {
    const config = { servers: {} };
    const id = await startSentinel(
      {
        server: "nonexistent",
        tool: "test",
        args: {},
        until: { path: "a", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    await waitForStatus(id, "error");
    const task = getSentinelTask(id);
    expect(task?.status).toBe("error");
    expect(task?.error).toContain("Unknown MCP server");
  });

  it("creates a task with valid config", () => {
    const config = {
      servers: { test: { type: "remote", url: "http://localhost:9999" } },
    };
    expect(
      startSentinel(
        {
          server: "test",
          tool: "status",
          args: {},
          until: { path: "x", is: "eq", value: 1 },
          sessionID: "s1",
        },
        invoker(config)
      )
    ).resolves.toBeDefined();
  });

  it("generates unique IDs", () => {
    const config = {
      servers: { s1: { type: "remote", url: "http://localhost:1" } },
    };
    const p1 = startSentinel(
      {
        server: "s1",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    const p2 = startSentinel(
      {
        server: "s1",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    expect(p1).resolves.not.toEqual(p2);
  });

  it("getActiveSentinels returns active tasks", async () => {
    const config = {
      servers: { a: { type: "remote", url: "http://localhost:2" } },
    };
    const id = await startSentinel(
      {
        server: "a",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    const tasks = getActiveSentinels();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some((p) => p.id === id)).toBe(true);
  });

  it("getSentinelTask returns task details", async () => {
    const config = {
      servers: { b: { type: "remote", url: "http://localhost:3" } },
    };
    const id = await startSentinel(
      {
        server: "b",
        tool: "test",
        args: { key: "val" },
        until: { path: "ok", is: "eq", value: true },
        sessionID: "s1",
      },
      invoker(config)
    );
    const task = getSentinelTask(id);
    expect(task).toBeDefined();
    expect(task!.request.server).toBe("b");
    expect(task!.request.tool).toBe("test");
    expect(task!.request.args).toEqual({ key: "val" });
    expect(task!.status).toBe("polling");
  });

  it("cancelSentinel cancels active task", async () => {
    const config = {
      servers: { c: { type: "remote", url: "http://localhost:4" } },
    };
    const id = await startSentinel(
      {
        server: "c",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
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
    const config = {
      servers: { d: { type: "remote", url: "http://localhost:5" } },
    };
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
      invoker(config)
    );
    const task = getSentinelTask(id);
    expect(task!.request.interval).toBe(2000);
    expect(task!.request.timeout).toBe(5000);
  });

  it("cleanup removes all active tasks", async () => {
    const config = {
      servers: { e: { type: "remote", url: "http://localhost:6" } },
    };
    await startSentinel(
      {
        server: "e",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    expect(getActiveSentinels().length).toBeGreaterThan(0);
    cleanup();
    expect(getActiveSentinels().length).toBe(0);
  });

  it("cancelled sentinel has status 'cancelled' not 'completed'", async () => {
    const config = {
      servers: { f: { type: "remote", url: "http://localhost:7" } },
    };
    const id = await startSentinel(
      {
        server: "f",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    cancelSentinel(id);
    const task = getSentinelTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.status).not.toBe("completed");
  });

  it("records MCP error with raw message for debugging", async () => {
    const config = {
      servers: { bad: { type: "remote", url: "http://localhost:1" } },
    };
    const id = await startSentinel(
      {
        server: "bad",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    await waitForStatus(id, "error");
    const task = getSentinelTask(id);
    expect(task?.status).toBe("error");
    expect(task?.error).toBeTruthy();
    // error should contain debugging info, not just a generic message
    expect(task!.error!.length).toBeGreaterThan(10);
  });

  it("invokes the notifier when a sentinel fails", async () => {
    const events: Array<{ id: string; event: string }> = [];
    setNotifier((task, event) => {
      events.push({ id: task.id, event });
    });

    const config = {
      servers: { failnotify: { type: "remote", url: "http://localhost:1" } },
    };
    const id = await startSentinel(
      {
        server: "failnotify",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    await waitForStatus(id, "error");
    expect(events.some((e) => e.id === id && e.event === "failed")).toBe(true);
  });

  it("auto-cleans error task after TTL", async () => {
    withEnv("SENTINEL_TASK_TTL_MS", "50");

    const config = {
      servers: { ttl1: { type: "remote", url: "http://localhost:1" } },
    };
    const id = await startSentinel(
      {
        server: "ttl1",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    await waitForStatus(id, "error");
    // wait for TTL to fire
    await new Promise((r) => setTimeout(r, 200));
    expect(getSentinelTask(id)).toBeUndefined();

    withEnv("SENTINEL_TASK_TTL_MS", undefined);
  });

  it("auto-cleans cancelled task after TTL", async () => {
    withEnv("SENTINEL_TASK_TTL_MS", "50");

    const config = {
      servers: { ttl2: { type: "remote", url: "http://localhost:2" } },
    };
    const id = await startSentinel(
      {
        server: "ttl2",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
    );
    cancelSentinel(id);
    // wait for TTL
    await new Promise((r) => setTimeout(r, 200));
    expect(getSentinelTask(id)).toBeUndefined();

    withEnv("SENTINEL_TASK_TTL_MS", undefined);
  });

  it("does not auto-clean when TTL is unset", async () => {
    const config = {
      servers: { nottl: { type: "remote", url: "http://localhost:3" } },
    };
    const id = await startSentinel(
      {
        server: "nottl",
        tool: "test",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      invoker(config)
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

  it("supports external invoker mode (no MCP config registered)", async () => {
    const calls: Array<{ server: string; tool: string; args: unknown }> = [];
    let count = 0;
    const externalInvoke = async (server: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ server, tool, args });
      count++;
      return count >= 3 ? { status: "completed" } : { status: "running" };
    };

    const id = await startSentinel(
      {
        server: "whatever",
        tool: "get_status",
        args: { job_id: "x" },
        interval: 1000,
        until: { path: "status", is: "eq", value: "completed" },
        sessionID: "s1",
      },
      externalInvoke
    );

    await waitForStatus(id, "completed");
    const task = getSentinelTask(id);
    expect(task?.status).toBe("completed");
    expect(task?.pollCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ server: "whatever", tool: "get_status", args: { job_id: "x" } });
  });

  it("handleRead paginates poll outputs by offset/limit", async () => {
    let count = 0;
    const externalInvoke = async () => {
      count++;
      return count >= 4 ? { status: "completed" } : { status: "running", n: count };
    };

    const id = await startSentinel(
      {
        server: "whatever",
        tool: "get_status",
        args: {},
        interval: 1000,
        until: { path: "status", is: "eq", value: "completed" },
        sessionID: "s1",
      },
      externalInvoke
    );
    await waitForStatus(id, "completed");

    const first = handleRead(id, 0, 2);
    expect(first).toContain("Poll #1");
    expect(first).toContain("Poll #2");
    expect(first).not.toContain("Poll #3");

    const last = handleRead(id, undefined, 2);
    expect(last).toContain("Poll #3");
    expect(last).toContain("Poll #4");
    expect(last).not.toContain("Poll #1");
  });

  it("times out when the deadline elapses before the condition is met", async () => {
    const externalInvoke = async () => ({ status: "running" });
    const id = await startSentinel(
      {
        server: "s",
        tool: "t",
        args: {},
        interval: 1000,
        timeout: 5000,
        until: { path: "status", is: "eq", value: "completed" },
        sessionID: "s1",
      },
      externalInvoke
    );
    await waitForStatus(id, "timeout");
    const task = getSentinelTask(id);
    expect(task?.status).toBe("timeout");
    expect(task?.pollCount).toBeGreaterThan(0);
  }, 15000);
});
