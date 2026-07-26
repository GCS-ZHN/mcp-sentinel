import { evaluateCondition } from "./condition-evaluator.js";
import { getOrCreateClient, callTool } from "./mcp-connection-manager.js";
import { lookupServer } from "./config-reader.js";
import { getMaxPollLog, getTaskTtlMs } from "./sentinel-config.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import type { SentinelRequest, SentinelTask, McpConfig } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

const activeSentinels = new Map<string, SentinelTask>();
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

let _client: OpencodeClient | null = null;

export function setNotifyFn(client: OpencodeClient): void {
  _client = client;
}

function generateId(): string {
  return `sentinel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function startSentinel(
  request: SentinelRequest,
  mcpConfig: McpConfig
): Promise<string> {
  const id = generateId();
  const interval = Math.max(request.interval ?? 5000, 1000);
  const timeout =
    request.timeout != null && request.timeout > 0 ? Math.max(request.timeout, 5000) : undefined;

  const serverConfig = lookupServer(mcpConfig, request.server);
  if (!serverConfig) {
    throw new Error(`Unknown MCP server: ${request.server}`);
  }

  const task: SentinelTask = {
    id,
    request,
    createdAt: Date.now(),
    pollCount: 0,
    lastResult: null,
    pollLog: [],
    status: "polling",
  };

  activeSentinels.set(id, task);

  const poll = async () => {
    const t = activeSentinels.get(id);
    if (!t || t.status !== "polling") return;

    try {
      const client = await getOrCreateClient(request.server, serverConfig);
      const result = await callTool(client, request.tool, request.args);

      t.pollCount++;
      t.lastResult = result;
      t.pollLog.push({ index: t.pollCount, time: Date.now(), result });
      const maxLog = getMaxPollLog();
      if (maxLog !== undefined && t.pollLog.length > maxLog) {
        t.pollLog = t.pollLog.slice(-maxLog);
        logDebug(`Trimming pollLog to ${maxLog} entries`, { id, pollCount: t.pollCount });
      }

      logDebug(`Poll #${t.pollCount}`, {
        id,
        server: request.server,
        tool: request.tool,
      });

      if (evaluateCondition(request.until, result)) {
        await resolveSentinel(id, result);
        return;
      }
    } catch (err) {
      t.status = "error";
      t.error = String(err);
      t.resolvedAt = Date.now();
      stopTimers(id);
      scheduleTaskCleanup(id);
      logError(`Poll failed: ${String(err)}`, {
        id,
        server: request.server,
        tool: request.tool,
        pollCount: t.pollCount,
      });
      await notify(id, request.sessionID, "failed", String(err));
    }

    if (timeout && Date.now() - t.createdAt >= timeout) {
      t.status = "timeout";
      t.resolvedAt = Date.now();
      stopTimers(id);
      scheduleTaskCleanup(id);
      logWarn(`Task timed out after ${t.pollCount} polls`, {
        id,
        server: request.server,
        tool: request.tool,
        timeout,
      });
      await notify(id, request.sessionID, "timeout", null);
    }
  };

  const timer = setInterval(poll, interval);
  activeTimers.set(id, timer);

  void poll();

  return id;
}

async function resolveSentinel(id: string, result: unknown): Promise<void> {
  const task = activeSentinels.get(id);
  if (!task) return;

  task.status = "completed";
  task.resolvedAt = Date.now();
  task.lastResult = result;
  stopTimers(id);
  scheduleTaskCleanup(id);
  logInfo("Task completed", {
    id,
    server: task.request.server,
    tool: task.request.tool,
    pollCount: task.pollCount,
    duration: task.resolvedAt - task.createdAt,
  });

  await notify(id, task.request.sessionID, "completed", result);
}

async function notify(
  id: string,
  sessionID: string,
  type: "completed" | "failed" | "timeout",
  data: unknown
): Promise<void> {
  const task = activeSentinels.get(id);
  if (!task || !_client) return;

  if (!sessionID) return;

  let text: string;
  switch (type) {
    case "completed":
      text = `## Sentinel Complete\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Duration:** ${((task.resolvedAt! - task.createdAt) / 1000).toFixed(1)}s\n**Result:**\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
      break;
    case "failed":
      text = `## Sentinel Failed\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Error:** ${data}`;
      break;
    case "timeout":
      text = `## Sentinel Timeout\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Last result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
      break;
  }

  try {
    await _client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ id: `prt-sentinel-${id}-${Date.now()}`, type: "text", text }],
      },
    });
  } catch {
    // prompt notification failure is non-fatal
  }
}

function stopTimers(id: string): void {
  const timer = activeTimers.get(id);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

function scheduleTaskCleanup(id: string): void {
  const ttl = getTaskTtlMs();
  if (ttl === undefined) return;

  logDebug(`Scheduling task cleanup in ${ttl}ms`, { id });
  const timer = setTimeout(() => {
    activeSentinels.delete(id);
    cleanupTimers.delete(id);
    logDebug("Task cleaned up from memory", { id });
  }, ttl);
  cleanupTimers.set(id, timer);
}

function clearTaskCleanup(id: string): void {
  const timer = cleanupTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(id);
  }
}

export function cancelSentinel(id: string): boolean {
  const task = activeSentinels.get(id);
  if (!task || task.status !== "polling") return false;

  task.status = "cancelled";
  task.resolvedAt = Date.now();
  stopTimers(id);
  scheduleTaskCleanup(id);
  logInfo("Task cancelled", { id, server: task.request.server, tool: task.request.tool });
  return true;
}

export function getSentinelTask(id: string): SentinelTask | undefined {
  return activeSentinels.get(id);
}

export function getActiveSentinels(): SentinelTask[] {
  return Array.from(activeSentinels.values()).filter((t) => t.status === "polling");
}

export function cleanup(): void {
  for (const [id] of activeTimers) {
    stopTimers(id);
  }
  for (const [id] of cleanupTimers) {
    clearTaskCleanup(id);
  }
  activeSentinels.clear();
}
