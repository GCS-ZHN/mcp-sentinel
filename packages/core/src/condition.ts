/**
 * Recursive condition evaluation engine for sentinel polling.
 *
 * Resolves a JSON path (dot notation, `[n]` array indices) from a poll
 * result and reports whether the resolved value satisfies the condition.
 * Compound conditions (`not`, `and`, `or`) are evaluated recursively.
 *
 * @module
 */

import type { SentinelCondition } from "./types.js";

/**
 * Walk a JSON value by dot-path, supporting array index notation.
 *
 * Array indices are normalized from `[n]` to `.n` before splitting on `.`.
 * Returns `undefined` for any null or undefined intermediate node.
 *
 * @param obj - The JSON value to traverse (typically a poll result).
 * @param path - Dot-path string (e.g. `"status"`, `"items[0].name"`).
 * @returns The resolved value, or `undefined` if the path doesn't exist.
 *
 * @example
 * ```ts
 * resolvePath({ a: [{ b: 2 }] }, "a[0].b")  // → 2
 * resolvePath({ x: null }, "x.y")             // → undefined
 * ```
 */
function resolvePath(obj: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Compare two values using one of the supported operators.
 *
 * Numeric operators (`gt`, `gte`, `lt`, `lte`) coerce both sides to
 * `Number`. String operators (`contains`, `match`) require string values
 * — mismatched types produce `false`.
 *
 * @param actual - The value resolved from the poll result.
 * @param op - Comparison operator.
 * @param expected - The expected value from the condition.
 * @returns `true` if the comparison succeeds. Unknown operators always
 *          produce `false`.
 */
function compare(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "contains":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.includes(expected)
      );
    case "match":
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Evaluate a {@link SentinelCondition} against poll result data.
 *
 * Recursively handles:
 * - **Leaf** (`path` + `is` + `value`): resolves the path, then compares.
 * - **`not`**: negates the nested condition.
 * - **`and`**: short-circuits on first `false`.
 * - **`or`**: short-circuits on first `true`.
 *
 * @param condition - The condition to evaluate.
 * @param data - The JSON poll result (may be object, string, number, etc.).
 * @returns `true` if the condition is satisfied for `data`.
 *
 * @example
 * ```ts
 * evaluateCondition(
 *   { path: "status", is: "eq", value: "completed" },
 *   { status: "completed" }
 * )  // → true
 *
 * evaluateCondition(
 *   { and: [{ path: "a", is: "gt", value: 0 }, { path: "b", is: "eq", value: 1 }] },
 *   { a: 5, b: 1 }
 * )  // → true
 * ```
 */
export function evaluateCondition(condition: SentinelCondition, data: unknown): boolean {
  if ("path" in condition) {
    const actual = resolvePath(data, condition.path);
    return compare(actual, condition.is, condition.value);
  }

  if ("not" in condition) {
    return !evaluateCondition(condition.not, data);
  }

  if ("and" in condition) {
    return condition.and.every((c) => evaluateCondition(c, data));
  }

  if ("or" in condition) {
    return condition.or.some((c) => evaluateCondition(c, data));
  }

  return false;
}
