function readEnvIntNonNegative(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return undefined;
  return n;
}

export function getMaxPollLog(): number | undefined {
  return readEnvIntNonNegative("SENTINEL_MAX_POLL_LOG");
}

export function getTaskTtlMs(): number | undefined {
  return readEnvIntNonNegative("SENTINEL_TASK_TTL_MS");
}
