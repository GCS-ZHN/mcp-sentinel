/**
 * Harness-agnostic tool handlers shared by every host adapter.
 *
 * These functions contain the pure request/response logic for the four
 * sentinel tools. Adapters own the framework-specific concerns — input
 * schema/parsing, config discovery, session IDs, and abort signals — and
 * delegate to these handlers.
 *
 * Every handler returns a plain string (an `"Error: ..."` string on invalid
 * input) rather than throwing, so the agent always sees readable feedback.
 *
 * @module
 */

import { startSentinel, cancelSentinel, getSentinelTask, getActiveSentinels } from "./engine.js";
import type { SentinelCondition, SentinelRequest, ToolInvoker } from "./types.js";

/** Normalized inputs for {@link handlePoll}. */
export interface PollHandlerInput {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  interval?: number;
  timeout?: number;
  until: SentinelCondition;
  sessionID?: string;
}

/**
 * `mcp_sentinel_poll` — submit a long-running MCP tool call and poll it until
 * a condition is met.
 */
export async function handlePoll(input: PollHandlerInput, invoke: ToolInvoker): Promise<string> {
  if (!input.server.trim() || !input.tool.trim()) {
    return "Error: server and tool must be non-empty strings.";
  }

  if (!input.until || typeof input.until !== "object" || Array.isArray(input.until)) {
    return "Error: until must be a JSON object describing a condition.";
  }

  try {
    const request: SentinelRequest = { ...input };
    const id = await startSentinel(request, invoke);

    return `Sentinel started.\n\n**ID:** \`${id}\`\n**Server:** ${request.server}\n**Tool:** ${request.tool}\n**Interval:** ${request.interval ?? 5000}ms\n**Timeout:** ${request.timeout ? request.timeout + "ms" : "none"}\n\nUse \`mcp_sentinel_status\` to check progress or cancel.`;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

/**
 * `mcp_sentinel_status` — check status, list active tasks, or cancel a task.
 */
export function handleStatus(action: string | undefined, id: string | undefined): string {
  const resolvedAction = action ?? "status";
  switch (resolvedAction) {
    case "status": {
      if (!id) {
        return "Error: id is required for status action.";
      }
      const task = getSentinelTask(id);
      if (!task) {
        return `Sentinel \`${id}\` not found.`;
      }
      return [
        `**ID:** ${task.id}`,
        `**Status:** ${task.status}`,
        `**Server:** ${task.request.server}`,
        `**Tool:** ${task.request.tool}`,
        `**Poll count:** ${task.pollCount}`,
        `**Created:** ${new Date(task.createdAt).toISOString()}`,
        task.resolvedAt
          ? `**Resolved:** ${new Date(task.resolvedAt).toISOString()}`
          : "**Running...**",
        task.status === "completed"
          ? `**Last result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``
          : "",
        task.error ? `**Error:** ${task.error}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "list": {
      const tasks = getActiveSentinels();
      if (tasks.length === 0) {
        return "No active sentinel tasks.";
      }
      return tasks
        .map(
          (t) =>
            `- \`${t.id}\` | ${t.request.server}/${t.request.tool} | count=${t.pollCount} | ${new Date(t.createdAt).toISOString()}`
        )
        .join("\n");
    }
    case "cancel": {
      if (!id) {
        return "Error: id is required for cancel action.";
      }
      const cancelled = cancelSentinel(id);
      return cancelled
        ? `Sentinel \`${id}\` cancelled.`
        : `Sentinel \`${id}\` not found or already completed.`;
    }
    default:
      return `Unknown action: ${resolvedAction}. Use "status", "list", or "cancel".`;
  }
}

/**
 * `mcp_sentinel_attach` — block until a sentinel task completes.
 *
 * Polls `getSentinelTask` every 1000 ms internally (no token cost during the
 * wait). `isAborted` reports user cancellation so the wait can end early.
 */
export async function handleAttach(
  id: string,
  timeout: number | undefined,
  isAborted: () => boolean
): Promise<string> {
  const task = getSentinelTask(id);
  if (!task) {
    return `Sentinel \`${id}\` not found.`;
  }

  if (task.status !== "polling") {
    if (task.status === "completed") {
      return `Sentinel \`${id}\` already completed.\n\n**Result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
    }
    return `Sentinel \`${id}\` status: ${task.status}${task.error ? ` — ${task.error}` : ""}`;
  }

  const checkInterval = 1000;
  const startedAt = Date.now();

  while (true) {
    if (isAborted()) {
      return "";
    }

    const current = getSentinelTask(id);
    if (!current) {
      return `Sentinel \`${id}\` no longer exists.`;
    }

    if (current.status !== "polling") {
      if (current.status === "completed") {
        return [
          `## Sentinel Complete`,
          `**ID:** ${current.id}`,
          `**Server:** ${current.request.server}`,
          `**Tool:** ${current.request.tool}`,
          `**Polls:** ${current.pollCount}`,
          `**Duration:** ${current.resolvedAt != null ? ((current.resolvedAt - current.createdAt) / 1000).toFixed(1) : "—"}s`,
          `**Result:**\n\`\`\`json\n${JSON.stringify(current.lastResult, null, 2)}\n\`\`\``,
        ].join("\n");
      }
      if (current.status === "timeout") {
        return `Sentinel \`${id}\` timed out after ${current.pollCount} polls.`;
      }
      if (current.status === "cancelled") {
        return `Sentinel \`${id}\` was cancelled.`;
      }
      return `Sentinel \`${id}\` failed: ${current.error || "unknown error"}`;
    }

    if (timeout && timeout > 0 && Date.now() - startedAt >= timeout) {
      return `Attach timed out after ${timeout}ms. Sentinel \`${id}\` is still running (${current.pollCount} polls so far).`;
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }
}

/**
 * `mcp_sentinel_read` — read raw poll outputs with offset/limit pagination.
 */
export function handleRead(
  id: string,
  offset: number | undefined,
  limit: number | undefined
): string {
  const task = getSentinelTask(id);
  if (!task) {
    return `Sentinel \`${id}\` not found.`;
  }

  const max = limit ?? 5;
  const all = task.pollLog;
  let slice: typeof all;

  if (offset !== undefined) {
    slice = all.slice(offset, offset + max);
  } else {
    slice = all.slice(-max);
  }

  if (slice.length === 0) {
    if (all.length === 0) {
      return `Sentinel \`${id}\` (status: ${task.status}) has no outputs yet.`;
    }
    return `Sentinel \`${id}\` has ${all.length} outputs but none match the requested range (offset=${offset ?? "end"}, limit=${max}).`;
  }

  const lines = [
    `**Sentinel:** \`${task.id}\` | **Status:** ${task.status} | **Total polls:** ${task.pollCount}`,
    `**Server:** ${task.request.server} | **Tool:** ${task.request.tool}`,
    task.request.timeout ? `**Timeout:** ${task.request.timeout}ms` : "**Timeout:** none",
    task.error ? `**Error:** ${task.error}` : "",
    "",
    `Showing ${slice.length} of ${task.pollLog.length} outputs:`,
    "",
  ].filter(Boolean);

  for (const entry of slice) {
    lines.push(
      `--- Poll #${entry.index} (${new Date(entry.time).toISOString()}) ---`,
      "```json",
      JSON.stringify(entry.result, null, 2),
      "```",
      ""
    );
  }

  return lines.join("\n");
}
