/**
 * opencode adapter — registers the four sentinel tools as native opencode
 * tools and wires opencode-specific integration (config discovery, session
 * notifications, service logging) into the framework-agnostic core.
 *
 * All request/response logic lives in `core/tools.ts`; this file
 * only owns the opencode seams: `tool()` definitions, `client.config.get()`,
 * `ctx.sessionID`, `ctx.abort`, `client.session.promptAsync()`, and
 * `client.app.log()`.
 *
 * @module
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { parseOpencodeMcpConfig } from "./config.js";
import {
  ACTION_DESCRIPTION,
  ARGS_DESCRIPTION,
  ATTACH_ID_DESCRIPTION,
  ATTACH_TIMEOUT_DESCRIPTION,
  ATTACH_TOOL_DESCRIPTION,
  COMPLETION_NOTIFICATION_NOTE,
  INTERVAL_DESCRIPTION,
  POLL_TIMEOUT_DESCRIPTION,
  POLL_TOOL_DESCRIPTION,
  READ_ID_DESCRIPTION,
  READ_LIMIT_DESCRIPTION,
  READ_OFFSET_DESCRIPTION,
  READ_TOOL_DESCRIPTION,
  SERVER_DESCRIPTION,
  STATUS_ID_DESCRIPTION,
  STATUS_TOOL_DESCRIPTION,
  TOOL_DESCRIPTION,
  UNTIL_DESCRIPTION,
  cleanup,
  disconnectAll,
  handleAttach,
  handlePoll,
  handleRead,
  handleStatus,
  logInfo,
  makeConnectionInvoker,
  makeServerResolver,
  setLogSink,
  setNotifier,
} from "@gcszhn/mcp-sentinel-core";
import type {
  SentinelCondition,
  SentinelEvent,
  SentinelNotifier,
  SentinelTask,
} from "@gcszhn/mcp-sentinel-core";

/** Service identifier used in the opencode log API. */
const SERVICE_NAME = "mcp-sentinel";

let _client: OpencodeClient | null = null;

/**
 * Build the opencode-style notification text for a resolved sentinel.
 *
 * Lives in the harness, not the core, because the notification message format
 * is host-specific — other hosts may render completions differently.
 */
export function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return `## Sentinel Complete\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Duration:** ${task.resolvedAt != null ? ((task.resolvedAt - task.createdAt) / 1000).toFixed(1) : "—"}s\n**Result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
    case "failed":
      return `## Sentinel Failed\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Error:** ${task.error}`;
    case "timeout":
      return `## Sentinel Timeout\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Last result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
  }
}

/**
 * opencode notifier: delivers a prompt notification to the originating
 * session when a sentinel resolves.
 *
 * Uses `client.session.promptAsync()` (NOT `prompt()`). Part IDs must start
 * with `prt-` per the opencode plugin SDK convention.
 */
const opencodeNotifier: SentinelNotifier = async (task, event) => {
  if (!_client) return;
  const sessionID = task.request.sessionID;
  if (!sessionID) return;

  const text = buildNotificationText(task, event);
  await _client.session.promptAsync({
    path: { id: sessionID },
    body: {
      parts: [{ id: `prt-sentinel-${task.id}-${Date.now()}`, type: "text", text }],
    },
  });
};

/**
 * `mcp_sentinel_poll` — submit a long-running MCP tool call and poll it at
 * regular intervals until a condition is met.
 */
const sentinelPollTool = tool({
  description: `${POLL_TOOL_DESCRIPTION}

${COMPLETION_NOTIFICATION_NOTE}`,
  args: {
    server: tool.schema.string().describe(SERVER_DESCRIPTION),
    tool: tool.schema.string().describe(TOOL_DESCRIPTION),
    args: tool.schema.json().optional().describe(ARGS_DESCRIPTION),
    interval: tool.schema.number().int().min(1000).optional().describe(INTERVAL_DESCRIPTION),
    timeout: tool.schema.number().int().min(0).optional().describe(POLL_TIMEOUT_DESCRIPTION),
    until: tool.schema.json().describe(UNTIL_DESCRIPTION),
  },
  async execute(args, ctx) {
    if (!_client) {
      return "Error: Plugin client not initialized.";
    }

    const toolArgs = (args.args ?? {}) as Record<string, unknown>;
    const until = args.until as unknown as SentinelCondition;

    const configResult = await _client.config.get();
    const rawConfig = configResult.data ?? {};
    const resolveServer = makeServerResolver(parseOpencodeMcpConfig(rawConfig));
    if (args.server.trim() && !resolveServer(args.server)) {
      return `Error: Unknown MCP server: ${args.server}`;
    }
    const invoke = makeConnectionInvoker(resolveServer);

    return handlePoll(
      {
        server: args.server,
        tool: args.tool,
        args: toolArgs,
        interval: args.interval,
        timeout: args.timeout,
        until,
        sessionID: ctx.sessionID,
      },
      invoke
    );
  },
});

/**
 * `mcp_sentinel_status` — check status of sentinel tasks, list all active
 * tasks, or cancel a running task.
 */
const sentinelStatusTool = tool({
  description: STATUS_TOOL_DESCRIPTION,
  args: {
    action: tool.schema.enum(["status", "list", "cancel"]).optional().describe(ACTION_DESCRIPTION),
    id: tool.schema.string().optional().describe(STATUS_ID_DESCRIPTION),
  },
  async execute(args) {
    return handleStatus(args.action, args.id);
  },
});

/**
 * `mcp_sentinel_attach` — block the agent, waiting for a sentinel task to
 * complete.
 */
const sentinelAttachTool = tool({
  description: ATTACH_TOOL_DESCRIPTION,
  args: {
    id: tool.schema.string().describe(ATTACH_ID_DESCRIPTION),
    timeout: tool.schema.number().int().min(0).optional().describe(ATTACH_TIMEOUT_DESCRIPTION),
  },
  async execute(args, ctx) {
    return handleAttach(args.id, args.timeout, () => ctx.abort.aborted);
  },
});

/**
 * `mcp_sentinel_read` — read raw poll outputs from a sentinel task.
 */
const sentinelReadTool = tool({
  description: READ_TOOL_DESCRIPTION,
  args: {
    id: tool.schema.string().describe(READ_ID_DESCRIPTION),
    offset: tool.schema.number().int().min(0).optional().describe(READ_OFFSET_DESCRIPTION),
    limit: tool.schema.number().int().min(1).optional().describe(READ_LIMIT_DESCRIPTION),
  },
  async execute(args) {
    return handleRead(args.id, args.offset, args.limit);
  },
});

/**
 * Graceful shutdown: stop all sentinel timers and close all cached MCP
 * connections.
 */
async function shutdown() {
  cleanup();
  await disconnectAll();
}

/**
 * Plugin entry point called by the opencode plugin host.
 *
 * Initializes the logger sink and notification channel, registers signal
 * handlers for graceful shutdown, and returns the four sentinel tools.
 *
 * @param input - The plugin input from opencode (includes SDK client reference).
 * @returns Tool hook definitions.
 */
export async function OpenCodeSentinelPlugin(input: PluginInput): Promise<Hooks> {
  _client = input.client;

  setLogSink(async (level, message, extra) => {
    if (!_client) return;
    await _client.app.log({ body: { service: SERVICE_NAME, level, message, extra } });
  });
  setNotifier(opencodeNotifier);
  logInfo("MCP Sentinel plugin initialized");

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  return {
    tool: {
      mcp_sentinel_poll: sentinelPollTool,
      mcp_sentinel_status: sentinelStatusTool,
      mcp_sentinel_attach: sentinelAttachTool,
      mcp_sentinel_read: sentinelReadTool,
    },
  };
}
