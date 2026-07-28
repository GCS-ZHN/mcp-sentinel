/**
 * Structured logging via the opencode client's `app.log` API.
 *
 * Logs are delivered to the opencode service-log UI under
 * `service: "mcp-sentinel"`. All log functions are fire-and-forget
 * (`void`) — a failure to write a log entry is silently ignored.
 *
 * @module
 */

import type { OpencodeClient } from "@opencode-ai/sdk";

/** Service identifier used in the opencode log API. */
const SERVICE_NAME = "mcp-sentinel";

let _client: OpencodeClient | null = null;

/**
 * Store a reference to the opencode SDK client so log entries can be
 * delivered to the opencode log service.
 *
 * Must be called during plugin initialization (before any logs are emitted).
 *
 * @param client - The opencode SDK client from {@link PluginInput}.
 */
export function setLogClient(client: OpencodeClient): void {
  _client = client;
}

type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Write a structured log entry to the opencode log API.
 *
 * @param level - Log severity level.
 * @param message - Human-readable log message.
 * @param extra - Optional structured key-value pairs for the entry.
 */
async function writeLog(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  if (!_client) return;
  try {
    await _client.app.log({
      body: { service: SERVICE_NAME, level, message, extra },
    });
  } catch {
    // log write failure is non-fatal: we must not crash the plugin
  }
}

/**
 * Log a debug-level message. Only visible when opencode runs with
 * `--log-level DEBUG`.
 *
 * @param message - Debug message.
 * @param extra - Optional structured context (task id, poll count, etc.).
 */
export function logDebug(message: string, extra?: Record<string, unknown>): void {
  void writeLog("debug", message, extra);
}

/**
 * Log an info-level message for normal operation events.
 *
 * @param message - Info message.
 * @param extra - Optional structured context.
 */
export function logInfo(message: string, extra?: Record<string, unknown>): void {
  void writeLog("info", message, extra);
}

/**
 * Log a warning-level message for non-fatal anomalies.
 *
 * @param message - Warning message.
 * @param extra - Optional structured context.
 */
export function logWarn(message: string, extra?: Record<string, unknown>): void {
  void writeLog("warn", message, extra);
}

/**
 * Log an error-level message for failures (poll errors, connection issues).
 *
 * @param message - Error message.
 * @param extra - Optional structured context.
 */
export function logError(message: string, extra?: Record<string, unknown>): void {
  void writeLog("error", message, extra);
}
