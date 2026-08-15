import { describe, it, expect } from "bun:test";
import { evaluateCondition } from "../src/condition.js";
import type { SentinelCondition } from "../src/types.js";

describe("condition-evaluator", () => {
  describe("resolvePath", () => {
    it("resolves simple properties", () => {
      const data = { status: "completed", code: 0 };
      expect(evaluateCondition({ path: "status", is: "eq", value: "completed" }, data)).toBe(true);
      expect(evaluateCondition({ path: "status", is: "eq", value: "running" }, data)).toBe(false);
    });

    it("resolves nested properties", () => {
      const data = { tasks: [{ exit_code: 0 }, { exit_code: 1 }] };
      expect(evaluateCondition({ path: "tasks[0].exit_code", is: "eq", value: 0 }, data)).toBe(
        true
      );
      expect(evaluateCondition({ path: "tasks[1].exit_code", is: "eq", value: 1 }, data)).toBe(
        true
      );
      expect(evaluateCondition({ path: "tasks[1].exit_code", is: "eq", value: 0 }, data)).toBe(
        false
      );
    });

    it("resolves top-level array with nested path like [0].data.path", () => {
      const data = [{ data: { path: "found" } }, { data: { path: "other" } }];
      expect(evaluateCondition({ path: "[0].data.path", is: "eq", value: "found" }, data)).toBe(
        true
      );
      expect(evaluateCondition({ path: "[1].data.path", is: "eq", value: "other" }, data)).toBe(
        true
      );
    });

    it("resolves mixed array access like items[2].name", () => {
      const data = { items: [{ name: "a" }, { name: "b" }, { name: "c" }] };
      expect(evaluateCondition({ path: "items[2].name", is: "eq", value: "c" }, data)).toBe(true);
    });

    it("throws for a missing key", () => {
      const data = { foo: "bar" };
      expect(() => evaluateCondition({ path: "baz", is: "eq", value: "bar" }, data)).toThrow(
        /key "baz" does not exist/
      );
    });

    it("throws for a missing nested key", () => {
      const data = { a: {} };
      expect(() => evaluateCondition({ path: "a.b.c", is: "eq", value: 1 }, data)).toThrow(
        /key "b" does not exist/
      );
    });

    it("throws for an out-of-range array index", () => {
      const data = { items: [1, 2] };
      expect(() => evaluateCondition({ path: "items[5]", is: "eq", value: 1 }, data)).toThrow(
        /out of range/
      );
    });

    it("throws when reading a property off null", () => {
      const data = { a: null };
      expect(() => evaluateCondition({ path: "a.b", is: "eq", value: 1 }, data)).toThrow(
        /cannot read/
      );
    });

    it("throws when reading a property off a primitive", () => {
      const data = { a: "text" };
      expect(() => evaluateCondition({ path: "a.b", is: "eq", value: 1 }, data)).toThrow(
        /cannot read/
      );
    });
  });

  describe("comparison operators", () => {
    const data = { count: 5, name: "hello world", status: "done" };

    it("eq", () => {
      expect(evaluateCondition({ path: "count", is: "eq", value: 5 }, data)).toBe(true);
      expect(evaluateCondition({ path: "count", is: "eq", value: 3 }, data)).toBe(false);
    });

    it("ne", () => {
      expect(evaluateCondition({ path: "status", is: "ne", value: "running" }, data)).toBe(true);
      expect(evaluateCondition({ path: "status", is: "ne", value: "done" }, data)).toBe(false);
    });

    it("gt / gte / lt / lte", () => {
      expect(evaluateCondition({ path: "count", is: "gt", value: 3 }, data)).toBe(true);
      expect(evaluateCondition({ path: "count", is: "gt", value: 5 }, data)).toBe(false);
      expect(evaluateCondition({ path: "count", is: "gte", value: 5 }, data)).toBe(true);
      expect(evaluateCondition({ path: "count", is: "lt", value: 10 }, data)).toBe(true);
      expect(evaluateCondition({ path: "count", is: "lt", value: 5 }, data)).toBe(false);
      expect(evaluateCondition({ path: "count", is: "lte", value: 5 }, data)).toBe(true);
    });

    it("contains", () => {
      expect(evaluateCondition({ path: "name", is: "contains", value: "hello" }, data)).toBe(true);
      expect(evaluateCondition({ path: "name", is: "contains", value: "world" }, data)).toBe(true);
      expect(evaluateCondition({ path: "name", is: "contains", value: "xyz" }, data)).toBe(false);
    });

    it("match (regex)", () => {
      expect(evaluateCondition({ path: "name", is: "match", value: "^hello" }, data)).toBe(true);
      expect(evaluateCondition({ path: "name", is: "match", value: "world$" }, data)).toBe(true);
      expect(evaluateCondition({ path: "name", is: "match", value: "^bye" }, data)).toBe(false);
    });

    it("match handles invalid regex gracefully", () => {
      expect(evaluateCondition({ path: "name", is: "match", value: "[" }, data)).toBe(false);
    });
  });

  describe("logical composition", () => {
    const data = { status: "completed", exitCode: 0, stage: "deploy" as string | undefined };

    it("not", () => {
      expect(evaluateCondition({ not: { path: "status", is: "eq", value: "running" } }, data)).toBe(
        true
      );
      expect(
        evaluateCondition({ not: { path: "status", is: "eq", value: "completed" } }, data)
      ).toBe(false);
    });

    it("and (all true)", () => {
      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "completed" },
          { path: "exitCode", is: "eq", value: 0 },
        ],
      };
      expect(evaluateCondition(condition, data)).toBe(true);
    });

    it("and (one false)", () => {
      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "completed" },
          { path: "exitCode", is: "eq", value: 1 },
        ],
      };
      expect(evaluateCondition(condition, data)).toBe(false);
    });

    it("and (empty = true)", () => {
      expect(evaluateCondition({ and: [] }, data)).toBe(true);
    });

    it("or (one true)", () => {
      const condition: SentinelCondition = {
        or: [
          { path: "status", is: "eq", value: "running" },
          { path: "exitCode", is: "eq", value: 0 },
        ],
      };
      expect(evaluateCondition(condition, data)).toBe(true);
    });

    it("or (all false)", () => {
      const condition: SentinelCondition = {
        or: [
          { path: "status", is: "eq", value: "running" },
          { path: "exitCode", is: "eq", value: 1 },
        ],
      };
      expect(evaluateCondition(condition, data)).toBe(false);
    });

    it("or (empty = false)", () => {
      expect(evaluateCondition({ or: [] }, data)).toBe(false);
    });

    it("nested composition", () => {
      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "completed" },
          {
            or: [
              { path: "exitCode", is: "eq", value: 0 },
              { path: "stage", is: "eq", value: "test" },
            ],
          },
        ],
      };
      expect(evaluateCondition(condition, data)).toBe(true);
    });

    it("deeply nested composition", () => {
      const condition: SentinelCondition = {
        not: {
          or: [
            { not: { path: "status", is: "eq", value: "completed" } },
            { and: [{ path: "exitCode", is: "ne", value: 0 }] },
          ],
        },
      };
      expect(evaluateCondition(condition, data)).toBe(true);
    });
  });

  describe("no-path leaf (non-JSON payloads)", () => {
    it("compares the raw string result directly", () => {
      expect(evaluateCondition({ is: "eq", value: "completed" }, "completed")).toBe(true);
      expect(evaluateCondition({ is: "eq", value: "completed" }, "running")).toBe(false);
    });

    it("empty path behaves like no path", () => {
      expect(evaluateCondition({ path: "", is: "eq", value: 42 }, 42)).toBe(true);
      expect(evaluateCondition({ path: "", is: "eq", value: 42 }, 7)).toBe(false);
    });

    it("compares non-JSON numbers and booleans", () => {
      expect(evaluateCondition({ is: "gte", value: 100 }, 150)).toBe(true);
      expect(evaluateCondition({ is: "eq", value: true }, true)).toBe(true);
    });

    it("supports contains/match against a raw string", () => {
      expect(evaluateCondition({ is: "contains", value: "done" }, "build done")).toBe(true);
      expect(evaluateCondition({ is: "match", value: "^ok" }, "ok: built")).toBe(true);
    });

    it("works inside logical composition", () => {
      const condition: SentinelCondition = {
        or: [
          { is: "eq", value: "completed" },
          { is: "eq", value: "failed" },
        ],
      };
      expect(evaluateCondition(condition, "failed")).toBe(true);
      expect(evaluateCondition(condition, "running")).toBe(false);
    });
  });

  describe("non-leaf rejection", () => {
    it("throws when a path resolves to an object", () => {
      const data = { status: { code: 0 } };
      expect(() => evaluateCondition({ path: "status", is: "eq", value: 0 }, data)).toThrow(
        /only leaf values/
      );
    });

    it("throws when a path resolves to an array", () => {
      const data = { tasks: [1, 2, 3] };
      expect(() => evaluateCondition({ path: "tasks", is: "eq", value: 1 }, data)).toThrow(
        /only leaf values/
      );
    });

    it("throws when no path and the raw result is an object", () => {
      expect(() => evaluateCondition({ is: "eq", value: { a: 1 } }, { a: 1 })).toThrow(
        /only leaf values/
      );
    });

    it("allows null as a leaf", () => {
      expect(evaluateCondition({ path: "x", is: "eq", value: null }, { x: null })).toBe(true);
    });

    it("allows number and boolean leaves", () => {
      expect(evaluateCondition({ path: "n", is: "gte", value: 1 }, { n: 2 })).toBe(true);
      expect(evaluateCondition({ path: "b", is: "eq", value: true }, { b: true })).toBe(true);
    });

    it("throws inside a compound condition", () => {
      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "ok" },
          { path: "nested", is: "eq", value: 1 },
        ],
      };
      expect(() => evaluateCondition(condition, { status: "ok", nested: { a: 1 } })).toThrow(
        /only leaf values/
      );
    });
  });

  describe("real-world scenarios", () => {
    it("CI pipeline complete with success", () => {
      const pipelineResult = {
        status: "completed",
        tasks: [
          { name: "build", exit_code: 0 },
          { name: "test", exit_code: 0 },
          { name: "deploy", exit_code: 0 },
        ],
        total_duration: 120,
      };

      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "completed" },
          { path: "tasks[2].exit_code", is: "eq", value: 0 },
        ],
      };
      expect(evaluateCondition(condition, pipelineResult)).toBe(true);
    });

    it("task failed - condition not met", () => {
      const pipelineResult = {
        status: "completed",
        tasks: [
          { name: "build", exit_code: 0 },
          { name: "test", exit_code: 1 },
        ],
      };

      const condition: SentinelCondition = {
        and: [
          { path: "status", is: "eq", value: "completed" },
          { path: "tasks[1].exit_code", is: "eq", value: 0 },
        ],
      };
      expect(evaluateCondition(condition, pipelineResult)).toBe(false);
    });

    it("wait for either completed or failed", () => {
      const completed = { status: "completed" };
      const running = { status: "running" };
      const failed = { status: "failed" };

      const condition: SentinelCondition = {
        or: [
          { path: "status", is: "eq", value: "completed" },
          { path: "status", is: "eq", value: "failed" },
        ],
      };

      expect(evaluateCondition(condition, completed)).toBe(true);
      expect(evaluateCondition(condition, failed)).toBe(true);
      expect(evaluateCondition(condition, running)).toBe(false);
    });

    it("numeric threshold with gte", () => {
      expect(evaluateCondition({ path: "progress", is: "gte", value: 80 }, { progress: 100 })).toBe(
        true
      );
      expect(evaluateCondition({ path: "progress", is: "gte", value: 80 }, { progress: 50 })).toBe(
        false
      );
    });

    it("contains in log output", () => {
      const data = { log: "Build successful (1234 warnings)" };
      expect(evaluateCondition({ path: "log", is: "contains", value: "successful" }, data)).toBe(
        true
      );
    });
  });

  describe("malformed condition", () => {
    it("throws for an empty condition object", () => {
      expect(() => evaluateCondition({} as SentinelCondition, { a: 1 })).toThrow(
        /Invalid condition/
      );
    });

    it("throws for an unknown comparison operator", () => {
      expect(() =>
        evaluateCondition({ path: "x", is: "eqq" as never, value: 1 }, { x: 1 })
      ).toThrow(/Unknown comparison operator/);
    });
  });
});
