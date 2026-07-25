import type { SentinelCondition } from "./types.js";

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
