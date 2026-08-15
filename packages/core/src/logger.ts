/**
 * Structured logging with a pluggable sink.
 *
 * The host adapter installs a sink appropriate to its environment — the
 * OpenCode adapter writes to its service-log UI via `client.app.log` under
 * `service: "mcp-sentinel"`. With no sink installed, log calls are no-ops.
 *
 * All log functions are fire-and-forget (`void`) — a failure to write a
 * log entry is silently ignored, never crashing the plugin.
 *
 * @module
 */

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A logging sink receives a level, message, and optional structured fields. */
export type LogSink = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => void | Promise<void>;

let _sink: LogSink | null = null;

/**
 * Install (or clear, with `null`) the active logging sink.
 *
 * @param sink - The sink to receive log entries, or `null` to disable logging.
 */
export function setLogSink(sink: LogSink | null): void {
  _sink = sink;
}

/**
 * Deliver a log entry to the installed sink, if any.
 * Sink failures are silently ignored — logging must never crash the plugin.
 */
async function writeLog(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  if (!_sink) return;
  try {
    await _sink(level, message, extra);
  } catch {
    // log write failure is non-fatal
  }
}

/**
 * Log a debug-level message. Only visible when the host runs with debug
 * logging enabled.
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
