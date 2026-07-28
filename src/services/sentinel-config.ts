/**
 * Environment-driven runtime configuration for the sentinel plugin.
 *
 * Reads optional tuning parameters from `process.env`:
 *
 * | Variable                | Type    | Default     | Purpose                                     |
 * | ----------------------- | ------- | ----------- | ------------------------------------------- |
 * | `SENTINEL_MAX_POLL_LOG` | pos-int | unlimited   | Max poll log entries per task (FIFO evict)  |
 * | `SENTINEL_TASK_TTL_MS`  | pos-int | no cleanup  | Auto-delete completed tasks after N ms      |
 *
 * Zero, negative, or non-numeric values are treated as unlimited/disabled.
 *
 * @module
 */

/**
 * Read an environment variable as a strictly positive integer, or
 * `undefined` if unset, zero, negative, or non-numeric.
 *
 * Note: zero is treated as unset despite the function name — only values
 * `>= 1` are returned.
 *
 * @param name - The environment variable name.
 * @returns The parsed positive integer (≥ 1), or `undefined`.
 */
function readEnvIntNonNegative(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return undefined;
  return n;
}

/**
 * @returns The maximum number of poll log entries to retain per task
 *          (FIFO eviction when exceeded), or `undefined` for unlimited.
 */
export function getMaxPollLog(): number | undefined {
  return readEnvIntNonNegative("SENTINEL_MAX_POLL_LOG");
}

/**
 * @returns The time-to-live in milliseconds for completed/errored/cancelled
 *          tasks before they are cleaned from memory, or `undefined` for no
 *          automatic cleanup.
 */
export function getTaskTtlMs(): number | undefined {
  return readEnvIntNonNegative("SENTINEL_TASK_TTL_MS");
}
