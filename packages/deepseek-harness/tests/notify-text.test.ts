import { describe, it, expect } from "bun:test";
import { buildNotificationText } from "../src/index.js";
import type { SentinelTask } from "@gcszhn/mcp-sentinel-core";

function makeTask(overrides: Partial<SentinelTask> = {}): SentinelTask {
  return {
    id: "sentinel_1",
    request: {
      server: "srv",
      tool: "tool",
      args: {},
      until: { path: "status", is: "eq", value: "completed" },
    },
    createdAt: 1000,
    pollCount: 3,
    lastResult: { status: "completed" },
    pollLog: [],
    status: "polling",
    ...overrides,
  };
}

describe("buildNotificationText", () => {
  it("renders a completed notification with the result", () => {
    const task = makeTask({ resolvedAt: 3000, status: "completed" });
    const text = buildNotificationText(task, "completed");
    expect(text).toContain("## Sentinel Complete");
    expect(text).toContain("**Server:** srv");
    expect(text).toContain('"status": "completed"');
  });

  it("renders a failed notification with the error", () => {
    const task = makeTask({ status: "error", error: "boom" });
    const text = buildNotificationText(task, "failed");
    expect(text).toContain("## Sentinel Failed");
    expect(text).toContain("**Error:** boom");
  });

  it("renders a timeout notification with the last result", () => {
    const task = makeTask({ status: "timeout" });
    const text = buildNotificationText(task, "timeout");
    expect(text).toContain("## Sentinel Timeout");
    expect(text).toContain("**Poll count:** 3");
  });
});
