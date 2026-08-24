import { describe, it, expect } from "bun:test";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNotificationText,
  hydrateCommandTemplate,
  validateNotifierCommands,
  registerNotifierCommands,
  buildCommandNotifierDispatcher,
  handleSetNotifierCommands,
} from "../src/notifier-commands.js";
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

describe("validateNotifierCommands", () => {
  it("accepts a non-empty array of single-placeholder strings", () => {
    expect(
      validateNotifierCommands(['codex queue --thread "t1" --message "{}"', 'echo "{}"'])
    ).toBeNull();
  });

  it("rejects non-arrays and empty arrays", () => {
    expect(validateNotifierCommands("nope")).toContain("non-empty array");
    expect(validateNotifierCommands([])).toContain("non-empty array");
    expect(validateNotifierCommands(null)).toContain("non-empty array");
  });

  it("rejects non-string and empty-string entries", () => {
    expect(validateNotifierCommands([123])).toContain("commands[0] must be a non-empty string.");
    expect(validateNotifierCommands(["  "])).toContain("commands[0] must be a non-empty string.");
  });

  it("rejects zero or multiple placeholders", () => {
    expect(validateNotifierCommands(["no placeholder"])).toContain('exactly one "{}"');
    expect(validateNotifierCommands(["a {} b {} c"])).toContain('exactly one "{}"');
  });
});

describe("hydrateCommandTemplate", () => {
  it("substitutes the message at the single placeholder", () => {
    expect(hydrateCommandTemplate('echo "{}"', "hello world")).toBe('echo "hello world"');
  });

  it("does not interpret $ patterns in the message as substitution patterns", () => {
    expect(hydrateCommandTemplate('printf "%s" "{}"', "a $& b")).toBe('printf "%s" "a $& b"');
    const command = hydrateCommandTemplate('cat <<< "{}"', 'x $1 y');
    expect(command).toBe('cat <<< "x $1 y"');
  });
});

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

describe("buildCommandNotifierDispatcher", () => {
  it("routes to the command list registered under the task's sessionID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-notifier-"));
    const out = join(dir, "out.txt");
    try {
      registerNotifierCommands("notifier-1", ["printf '%s' '{}' > " + out]);
      const dispatcher = buildCommandNotifierDispatcher();
      const task = makeTask({
        resolvedAt: 3000,
        status: "completed",
        request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: "notifier-1" },
      });
      await dispatcher(task, "completed");
      expect(readFileSync(out, "utf8")).toBe(buildNotificationText(task, "completed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a task whose sessionID has no registered commands", async () => {
    const dispatcher = buildCommandNotifierDispatcher();
    const task = makeTask({
      status: "completed",
      request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: "missing-id" },
    });
    // must not throw or attempt to run anything
    await dispatcher(task, "completed");
  });

  it("rejects one session's notification from leaking into another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-notifier-"));
    const outA = join(dir, "a.txt");
    const outB = join(dir, "b.txt");
    try {
      registerNotifierCommands("notifier-A", ["printf '%s' '{}' > " + outA]);
      registerNotifierCommands("notifier-B", ["printf '%s' '{}' > " + outB]);
      const dispatcher = buildCommandNotifierDispatcher();
      const taskA = makeTask({ request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: "notifier-A" } });
      const taskB = makeTask({ request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: "notifier-B" } });
      await dispatcher(taskA, "completed");
      await dispatcher(taskB, "completed");
      expect(readFileSync(outA, "utf8")).toBe(buildNotificationText(taskA, "completed"));
      expect(readFileSync(outB, "utf8")).toBe(buildNotificationText(taskB, "completed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("runs commands in order and swallows a failing command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-notifier-"));
    const out = join(dir, "out.txt");
    try {
      registerNotifierCommands("notifier-force", ["exit 1", "printf '%s' '{}' > " + out]);
      const dispatcher = buildCommandNotifierDispatcher();
      const task = makeTask({
        request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: "notifier-force" },
      });
      await dispatcher(task, "completed");
      expect(readFileSync(out, "utf8")).toBe(buildNotificationText(task, "completed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleSetNotifierCommands", () => {
  it("returns an error for invalid input", () => {
    expect(handleSetNotifierCommands([])).toContain("non-empty array");
    expect(handleSetNotifierCommands(["x"])).toContain('exactly one "{}"');
  });

  it("installs the notifier and returns a confirmation for valid input", async () => {
    const output = handleSetNotifierCommands(['echo "{}"']);
    expect(output).toContain("Command notifier installed");
    expect(output).toContain('echo "{}"');
    // a uuid is returned as notifier_id and registered for that session
    expect(output).toContain("**notifier_id:**");
    const id = output.split("**notifier_id:** `")[1].split("`")[0];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const dispatcher = buildCommandNotifierDispatcher();
    const task = makeTask({
      request: { server: "srv", tool: "tool", args: {}, until: { path: "status", is: "eq", value: "completed" }, sessionID: id },
    });
    // Running the dispatcher with the registered id must not throw; the
    // 'echo "{}"' command succeeds and its output is discarded.
    await dispatcher(task, "completed");
  });
});
