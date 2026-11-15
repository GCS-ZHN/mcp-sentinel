/**
 * OpenCode 2 (V2) harness — host binding registry.
 *
 * The core keeps its notifier and log sink in module-level state. V2 can load
 * one plugin instance per location **in the same server process**, and all of
 * those instances import the same core module. A naive
 * `setNotifier(instanceNotifier)` would let the last-loaded instance clobber
 * the others, and a per-instance `cleanup()` would wipe every location's
 * tasks.
 *
 * This registry keeps each instance's channels and routes notifications by the
 * session that started the sentinel (`task.request.sessionID`), falling back to
 * the most recently registered instance when no owner is known. Global core
 * cleanup is the caller's job and must only run when the registry is empty.
 *
 * @module
 */

import { setLogSink, setNotifier } from "@gcszhn/mcp-sentinel-core";
import type {
  LogSink,
  McpConfig,
  SentinelEvent,
  SentinelNotifier,
  SentinelTask,
} from "@gcszhn/mcp-sentinel-core";

/** A single plugin instance's notification and logging channels. */
export interface HostBinding {
  /** Delivers a resolved sentinel to this instance's host session channel. */
  readonly notifier: SentinelNotifier;
  /** Writes a structured log entry through this instance's host log channel. */
  readonly logSink: LogSink;
  /**
   * The MCP servers this instance's location sees, refreshed on every MCP
   * transform replay. Used to reconcile the process-wide connection cache:
   * a connection may only be closed once **no** live instance needs it.
   */
  mcpConfig?: McpConfig;
}

const bindings: HostBinding[] = [];
const sessionOwners = new Map<string, HostBinding>();

/** Return the most recently registered binding, if any. */
export function getActiveHostBinding(): HostBinding | undefined {
  return bindings[bindings.length - 1];
}

/**
 * The MCP config of every live plugin instance.
 *
 * The core's connection cache is process-wide, while each V2 instance only sees
 * the servers configured for its own location. Reconciliation must therefore
 * run against every location's config; merging by name would drop a server two
 * locations configure differently (for example a project overriding a global
 * server), and closing it would break the other location's polls.
 */
export function getCombinedMcpConfigs(): McpConfig[] {
  return bindings.map((binding) => binding.mcpConfig ?? { servers: {} });
}

/** Number of currently registered plugin instances. */
export function getHostBindingCount(): number {
  return bindings.length;
}

/**
 * Record which plugin instance owns a session, so that session's sentinel
 * completions are delivered through the same instance's `ctx.session`.
 */
export function claimSession(sessionID: string | undefined, binding: HostBinding): void {
  if (sessionID) sessionOwners.set(sessionID, binding);
}

/**
 * Dispatch a sentinel resolution to the binding that owns the task's session.
 *
 * Falls back to the most recently registered binding for tasks without an
 * owner (for example, tasks recovered after a plugin reload). Exported so the
 * routing behavior can be unit-tested directly.
 */
export async function dispatchNotification(
  task: SentinelTask,
  event: SentinelEvent
): Promise<void> {
  const sessionID = task.request.sessionID;
  const owner = sessionID ? sessionOwners.get(sessionID) : undefined;
  const binding = owner && bindings.includes(owner) ? owner : getActiveHostBinding();
  if (binding) await binding.notifier(task, event);
}

/** Route a core log entry to the active plugin instance's host log channel. */
const dispatchLog: LogSink = (level, message, extra) => {
  const binding = getActiveHostBinding();
  if (binding) return binding.logSink(level, message, extra);
};

/**
 * Register a plugin instance's channels and install the shared dispatchers.
 *
 * Idempotent for the same binding object.
 */
export function registerHostBinding(binding: HostBinding): void {
  if (!bindings.includes(binding)) bindings.push(binding);
  setNotifier(dispatchNotification);
  setLogSink(dispatchLog);
}

/**
 * Remove a plugin instance's channels.
 *
 * When the last instance unloads, the core notifier/log sink are cleared and
 * all session ownership is forgotten. The caller decides whether to run the
 * core's global `cleanup()`/`disconnectAll()`; see `src/index.ts`.
 */
export function unregisterHostBinding(binding: HostBinding): void {
  const index = bindings.indexOf(binding);
  if (index !== -1) bindings.splice(index, 1);

  for (const [sessionID, owner] of sessionOwners) {
    if (owner === binding) sessionOwners.delete(sessionID);
  }

  if (bindings.length === 0) {
    setNotifier(null);
    setLogSink(null);
    sessionOwners.clear();
  }
}
