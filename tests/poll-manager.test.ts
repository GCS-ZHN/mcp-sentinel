import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startPoll,
  cancelPoll,
  getPollTask,
  getActivePolls,
  cleanup,
  setNotifyFn,
} from "../src/services/poll-manager.js";
import { parseMcpConfig } from "../src/services/config-reader.js";

function createMockClient() {
  return {
    session: {
      promptAsync: async (_opts: unknown) => ({}),
    },
  } as any;
}

describe("poll-manager", () => {
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
      startPoll(
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

  it("creates a poll task with valid config", () => {
    const config = parseMcpConfig({
      mcp: { test: { type: "remote", url: "http://localhost:9999" } },
    });
    expect(
      startPoll(
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

  it("generates unique poll IDs", () => {
    const config = parseMcpConfig({
      mcp: { s1: { type: "remote", url: "http://localhost:1" } },
    });
    const p1 = startPoll(
      {
        server: "s1",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const p2 = startPoll(
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

  it("getActivePolls returns active polls", async () => {
    const config = parseMcpConfig({
      mcp: { a: { type: "remote", url: "http://localhost:2" } },
    });
    const id = await startPoll(
      {
        server: "a",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const polls = getActivePolls();
    expect(polls.length).toBeGreaterThanOrEqual(1);
    expect(polls.some((p) => p.id === id)).toBe(true);
  });

  it("getPollTask returns task details", async () => {
    const config = parseMcpConfig({
      mcp: { b: { type: "remote", url: "http://localhost:3" } },
    });
    const id = await startPoll(
      {
        server: "b",
        tool: "test",
        args: { key: "val" },
        until: { path: "ok", is: "eq", value: true },
        sessionID: "s1",
      },
      config
    );
    const task = getPollTask(id);
    expect(task).toBeDefined();
    expect(task!.request.server).toBe("b");
    expect(task!.request.tool).toBe("test");
    expect(task!.request.args).toEqual({ key: "val" });
    expect(task!.status).toBe("polling");
  });

  it("cancelPoll cancels active poll", async () => {
    const config = parseMcpConfig({
      mcp: { c: { type: "remote", url: "http://localhost:4" } },
    });
    const id = await startPoll(
      {
        server: "c",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    const cancelled = cancelPoll(id);
    expect(cancelled).toBe(true);
    const task = getPollTask(id);
    expect(task?.status).toBe("completed");
    expect(getActivePolls()).toEqual([]);
  });

  it("cancelPoll returns false for already completed poll", () => {
    const result = cancelPoll("nonexistent");
    expect(result).toBe(false);
  });

  it("returns undefined for nonexistent poll", () => {
    expect(getPollTask("nope")).toBeUndefined();
  });

  it("respects custom interval and timeout", async () => {
    const config = parseMcpConfig({
      mcp: { d: { type: "remote", url: "http://localhost:5" } },
    });
    const id = await startPoll(
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
    const task = getPollTask(id);
    expect(task!.request.interval).toBe(2000);
    expect(task!.request.timeout).toBe(5000);
  });

  it("cleanup removes all active polls", async () => {
    const config = parseMcpConfig({
      mcp: { e: { type: "remote", url: "http://localhost:6" } },
    });
    await startPoll(
      {
        server: "e",
        tool: "t",
        args: {},
        until: { path: "x", is: "eq", value: 1 },
        sessionID: "s1",
      },
      config
    );
    expect(getActivePolls().length).toBeGreaterThan(0);
    cleanup();
    expect(getActivePolls().length).toBe(0);
  });
});
