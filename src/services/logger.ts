import type { OpencodeClient } from "@opencode-ai/sdk";

const SERVICE_NAME = "mcp-sentinel";

let _client: OpencodeClient | null = null;

export function setLogClient(client: OpencodeClient): void {
  _client = client;
}

type LogLevel = "debug" | "info" | "warn" | "error";

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
    // log write failure is non-fatal
  }
}

export function logDebug(message: string, extra?: Record<string, unknown>): void {
  void writeLog("debug", message, extra);
}

export function logInfo(message: string, extra?: Record<string, unknown>): void {
  void writeLog("info", message, extra);
}

export function logWarn(message: string, extra?: Record<string, unknown>): void {
  void writeLog("warn", message, extra);
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  void writeLog("error", message, extra);
}
