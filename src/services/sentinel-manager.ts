/**
 * Zero-token-cost MCP polling executor — the core sentinel engine.
 *
 * ## Lifecycle
 * 1. {@link startSentinel} creates a task and begins polling at `interval` ms.
 * 2. Each poll invokes an MCP tool via {@link callTool}, which handles
 *    transparent reconnection on connection-level errors.
 * 3. Poll results are evaluated against the termination condition. When met,
 *    the sentinel resolves as `completed`.
 * 4. If an unrecoverable error occurs, the sentinel resolves as `error`.
 * 5. If the total duration exceeds `timeout`, it resolves as `timeout`.
 * 6. Resolved tasks remain in memory for {@link SENTINEL_TASK_TTL_MS}
 *    (if configured) so agents can inspect status and poll logs.
 *
 * ## Concurrency
 * Each sentinel has its own `setInterval` timer. Multiple sentinels can run
 * concurrently against different MCP servers (or the same server with a
 * shared, cached client from {@link getOrCreateClient}).
 *
 * ## Notification
 * When a sentinel resolves, a prompt notification is sent to the originating
 * agent session via the opencode SDK. Notification failure is non-fatal.
 *
 * @module
 */

import { evaluateCondition } from "./condition-evaluator.js";
import { getOrCreateClient, callTool } from "./mcp-connection-manager.js";
import { lookupServer } from "./config-reader.js";
import { getMaxPollLog, getTaskTtlMs } from "./sentinel-config.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import type { SentinelRequest, SentinelTask, McpConfig } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

/**
 * All sentinel tasks, indexed by ID.
 * Includes both active (polling) and resolved (completed/errored/cancelled)
 * tasks until the latter are cleaned up by TTL.
 */
const activeSentinels = new Map<string, SentinelTask>();

/** `setInterval` handles for active sentinels. Key exists only while `status === "polling"`. */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** `setTimeout` handles for deferred TTL cleanup of resolved tasks. */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

let _client: OpencodeClient | null = null;

/**
 * Store a reference to the opencode SDK client so sentinel notification
 * prompts can be delivered to the agent session.
 *
 * Must be called during plugin initialization, before any sentinel is started.
 *
 * @param client - The opencode SDK client from {@link PluginInput}.
 */
export function setNotifyFn(client: OpencodeClient): void {
  _client = client;
}

/**
 * Generate a unique sentinel ID.
 *
 * Format: `sentinel_{timestamp}_{6-random-chars}`
 */
function generateId(): string {
  return `sentinel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Launch a polling sentinel that calls an MCP tool on a fixed interval and
 * waits for a condition to be met.
 *
 * **Guards:**
 * - `interval` is clamped to min `1000 ms` (prevents `setInterval` flood).
 * - `timeout` is clamped to min `5000 ms` when `> 0`. `0` / `undefined` = no limit.
 *
 * The first poll fires immediately; subsequent polls run on `setInterval`.
 * The sentinel's poll loop is **shared with connection reconnection**: if the
 * MCP session expires or the server is temporarily unreachable,
 * {@link callTool} will reconnect transparently and the poll continues.
 *
 * @param request - Sentinel parameters (server, tool, args, interval, etc.).
 * @param mcpConfig - Parsed opencode MCP configuration.
 * @returns The generated sentinel ID string.
 * @throws {Error} If the configured MCP server is not found in `mcpConfig`
 *                 or is disabled.
 */
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

  /** Single poll iteration. Checks termination, records result, handles errors. */
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
      // callTool already tried reconnection. If we still get an error here,
      // it's genuinely unrecoverable — mark the sentinel as errored.
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

  // Fire the first poll immediately
  void poll();

  return id;
}

/**
 * Mark a sentinel as completed, stop its timer, and notify the agent.
 *
 * @param id - Sentinel ID.
 * @param result - The final poll result that satisfied the condition.
 */
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

/**
 * Send a prompt notification to the agent session that originated the
 * sentinel.
 *
 * Notification uses `client.session.promptAsync()` (NOT `prompt()`). Part
 * IDs must start with `prt-` per the opencode plugin SDK convention.
 *
 * Notification failure is silently ignored — the sentinel task state is
 * still accessible via `mcp_sentinel_status` and `mcp_sentinel_read`.
 *
 * @param id - Sentinel ID.
 * @param sessionID - Agent session ID from the originating request.
 * @param type - Notification type: `completed`, `failed`, or `timeout`.
 * @param data - The result data (for `completed`) or error message (for `failed`).
 */
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
    // prompt notification failure is non-fatal: the task state is still
    // queryable via mcp_sentinel_status / mcp_sentinel_read
  }
}

/**
 * Stop the `setInterval` timer for a sentinel and remove it from the
 * active timer map.
 *
 * @param id - Sentinel ID.
 */
function stopTimers(id: string): void {
  const timer = activeTimers.get(id);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

/**
 * Schedule deferred cleanup for a resolved (completed / errored / cancelled)
 * sentinel task.
 *
 * After `SENTINEL_TASK_TTL_MS`, the task is removed from `activeSentinels`,
 * freeing its memory. If TTL is not configured, the task persists until
 * plugin shutdown or {@link cleanup}.
 *
 * @param id - Sentinel ID.
 */
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

/**
 * Cancel a pending TTL cleanup timer.
 *
 * @param id - Sentinel ID.
 */
function clearTaskCleanup(id: string): void {
  const timer = cleanupTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(id);
  }
}

/**
 * Cancel an active (polling) sentinel.
 *
 * Stops the timer, marks the task as `"cancelled"`, and schedules TTL
 * cleanup. Idempotent for already-resolved or non-existent tasks.
 *
 * @param id - Sentinel ID to cancel.
 * @returns `true` if the sentinel was successfully cancelled, `false` if it
 *          was not found or already resolved.
 */
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

/**
 * Look up a sentinel task by ID.
 *
 * @param id - Sentinel ID.
 * @returns The task state, or `undefined` if not found (never existed or
 *          was cleaned up).
 */
export function getSentinelTask(id: string): SentinelTask | undefined {
  return activeSentinels.get(id);
}

/**
 * Return all sentinels that are currently in the `"polling"` state.
 *
 * @returns Array of active (polling) sentinel tasks. Empty array if none.
 */
export function getActiveSentinels(): SentinelTask[] {
  return Array.from(activeSentinels.values()).filter((t) => t.status === "polling");
}

/**
 * Shut down all active sentinels: stop interval timers, clear TTL cleanup
 * timers, and remove all task state from memory.
 *
 * Called on plugin shutdown (`SIGINT` / `SIGTERM`). After this call, all
 * sentinel tasks are gone — agents should use `mcp_sentinel_attach` to
 * collect results before shutdown.
 */
export function cleanup(): void {
  for (const [id] of activeTimers) {
    stopTimers(id);
  }
  for (const [id] of cleanupTimers) {
    clearTaskCleanup(id);
  }
  activeSentinels.clear();
}
