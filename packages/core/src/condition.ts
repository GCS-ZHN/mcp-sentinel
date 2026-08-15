/**
 * Recursive condition evaluation engine for sentinel polling.
 *
 * Resolves a JSON path (dot notation, `[n]` array indices) from a poll
 * result and reports whether the resolved value satisfies the condition.
 * Compound conditions (`not`, `and`, `or`) are evaluated recursively.
 *
 * A leaf condition without a `path` (or with an empty path) compares against
 * the raw poll result directly — no JSON-path resolution is performed — so
 * tools returning non-JSON payloads (plain text, numbers, booleans) can still
 * be matched.
 *
 * @module
 */

import type { SentinelCondition } from "./types.js";

/**
 * Walk a JSON value by dot-path, supporting array index notation.
 *
 * Array indices are normalized from `[n]` to `.n` before splitting on `.`.
 * Unlike a silent `undefined`, a missing key, an out-of-range array index, or
 * reading a property off a `null`/primitive intermediate node **throws** — the
 * condition is misconfigured and the agent must learn about it rather than the
 * sentinel silently polling forever.
 *
 * @param obj - The JSON value to traverse (typically a poll result).
 * @param path - Dot-path string (e.g. `"status"`, `"items[0].name"`).
 * @returns The resolved value.
 * @throws {Error} If the path references a missing key, an out-of-range array
 *         index, or a property on a `null`/primitive node.
 *
 * @example
 * ```ts
 * resolvePath({ a: [{ b: 2 }] }, "a[0].b")  // → 2
 * resolvePath({ x: null }, "x.y")             // → throws (cannot read "y" of null)
 * ```
 */
function resolvePath(obj: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = obj;
  for (const key of keys) {
    if (current == null) {
      throw new Error(
        `Cannot resolve path "${path}": cannot read "${key}" of ${current === null ? "null" : "undefined"}.`
      );
    }
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(
          `Cannot resolve path "${path}": index ${key} is out of range (array length ${current.length}).`
        );
      }
      current = current[index];
    } else if (typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        throw new Error(`Cannot resolve path "${path}": key "${key}" does not exist.`);
      }
      current = (current as Record<string, unknown>)[key];
    } else {
      throw new Error(
        `Cannot resolve path "${path}": cannot read "${key}" of a ${typeof current} value.`
      );
    }
  }
  return current;
}

/**
 * Whether a resolved comparison value is a non-leaf (array or object).
 *
 * The condition DSL compares leaves only: strings, numbers, booleans, or
 * `null`. Resolving a `path` (or the whole result) to an array or object is a
 * misconfiguration — the agent asked to compare a structured value — and must
 * surface as an error rather than silently never matching.
 */
function isNonLeaf(value: unknown): boolean {
  return value !== null && typeof value === "object";
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
 * @returns `true` if the comparison succeeds.
 * @throws {Error} For an unknown operator.
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
      throw new Error(
        `Unknown comparison operator: "${op}". Use one of: eq, ne, gt, gte, lt, lte, contains, match.`
      );
  }
}

/**
 * Evaluate a {@link SentinelCondition} against poll result data.
 *
 * Recursively handles:
 * - **Leaf** (`is` + `value`, optional `path`): resolves the path when present,
 *   otherwise compares the raw `data` value.
 * - **`not`**: negates the nested condition.
 * - **`and`**: short-circuits on first `false`.
 * - **`or`**: short-circuits on first `true`.
 *
 * @param condition - The condition to evaluate.
 * @param data - The JSON poll result (may be object, string, number, etc.).
 * @returns `true` if the condition is satisfied for `data`.
 * @throws {Error} For a malformed condition (no is/not/and/or) or an unknown
 *         operator.
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
  if ("is" in condition) {
    const actual = condition.path ? resolvePath(data, condition.path) : data;
    if (isNonLeaf(actual)) {
      const kind = Array.isArray(actual) ? "array" : "object";
      const location = condition.path ? `path "${condition.path}"` : "the raw result";
      throw new Error(
        `Condition resolved ${location} to a ${kind}; only leaf values (string, number, boolean, null) are comparable.`
      );
    }
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

  throw new Error('Invalid condition: expected one of "is", "not", "and", or "or".');
}
