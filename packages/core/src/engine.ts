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
 * When a sentinel resolves, an injected {@link SentinelNotifier} callback is
 * invoked. The host adapter implements this through its own message channel
 * (e.g. OpenCode's `session.promptAsync`); the core itself has no opinion on
 * how a notification is delivered. Notification failure is non-fatal.
 *
 * @module
 */

import { evaluateCondition } from "./condition.js";
import { getMaxPollLog, getTaskTtlMs } from "./env.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import type { SentinelRequest, SentinelTask, ToolInvoker } from "./types.js";

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

/** Sentinel lifecycle events delivered to the {@link SentinelNotifier}. */
export type SentinelEvent = "completed" | "failed" | "timeout";

/**
 * Notifier callback invoked when a sentinel transitions out of the polling
 * state. Receives the task (which already carries `lastResult` / `error`)
 * so adapters can build their own message format.
 */
export type SentinelNotifier = (task: SentinelTask, event: SentinelEvent) => void | Promise<void>;

let _notifier: SentinelNotifier | null = null;

/**
 * Install (or clear, with `null`) the notifier invoked when a sentinel
 * resolves.
 *
 * Must be called during plugin initialization, before any sentinel is started.
 *
 * @param notifier - The callback to invoke on resolution.
 */
export function setNotifier(notifier: SentinelNotifier | null): void {
  _notifier = notifier;
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
 * Each poll delegates the actual MCP call to the supplied {@link ToolInvoker},
 * so reconnection policy is owned by whichever strategy produced the invoker.
 *
 * @param request - Sentinel parameters (server, tool, args, interval, etc.).
 * @param invoke - Invokes the target MCP tool and returns its parsed result.
 * @returns The generated sentinel ID string.
 */
export async function startSentinel(
  request: SentinelRequest,
  invoke: ToolInvoker
): Promise<string> {
  const id = generateId();
  const interval = Math.max(request.interval ?? 5000, 1000);
  const timeout =
    request.timeout != null && request.timeout > 0 ? Math.max(request.timeout, 5000) : undefined;

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
      const result = await invoke(request.server, request.tool, request.args);

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
      await notify(t, "failed");
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
      await notify(t, "timeout");
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

  await notify(task, "completed");
}

/**
 * Invoke the installed notifier for a resolved sentinel.
 *
 * Notification failure is silently ignored — the sentinel task state is
 * still accessible via `mcp_sentinel_status` and `mcp_sentinel_read`.
 *
 * @param task - The resolved task (already carries `lastResult`/`error`).
 * @param event - The resolution event: `completed`, `failed`, or `timeout`.
 */
async function notify(task: SentinelTask, event: SentinelEvent): Promise<void> {
  if (!_notifier) return;
  try {
    await _notifier(task, event);
  } catch {
    // notification failure is non-fatal: the task state is still queryable
    // via mcp_sentinel_status / mcp_sentinel_read
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
