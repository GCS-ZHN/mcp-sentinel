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
import { setNotifier, cleanup, makeServerResolver } from "@gcszhn/mcp-sentinel-core";
import type { SentinelEvent, SentinelNotifier } from "@gcszhn/mcp-sentinel-core";
import { disconnectAll } from "@gcszhn/mcp-sentinel-core";
import { setLogSink, logInfo } from "@gcszhn/mcp-sentinel-core";
import { handlePoll, handleStatus, handleAttach, handleRead } from "@gcszhn/mcp-sentinel-core";
import type { SentinelCondition, SentinelTask } from "@gcszhn/mcp-sentinel-core";

/** Service identifier used in the opencode log API. */
const SERVICE_NAME = "mcp-sentinel";

let _client: OpencodeClient | null = null;

/**
 * Build the opencode-style notification text for a resolved sentinel.
 *
 * Lives in the harness, not the core, because the notification message format
 * is host-specific — other hosts may render completions differently.
 */
function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return `## Sentinel Complete\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Duration:** ${((task.resolvedAt! - task.createdAt) / 1000).toFixed(1)}s\n**Result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
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
  description: `Submit a long-running MCP tool call and poll it at regular intervals until a condition is met. The sentinel polls silently (zero token cost) and notifies you when done.

Parameters:
- server: MCP server name (from opencode config)
- tool: Tool name to call on the server
- args: Arguments for the tool (JSON object, default: {})
- interval: Poll interval in ms (min 1000, default: 5000)
- timeout: Max poll duration in ms (optional, polls until condition met if unset)
- until: Condition object to wait for

Condition model:
{ "path": "field", "is": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"match", "value": any }
{ "not": <condition> }
{ "and": [<condition>, ...] }
{ "or": [<condition>, ...] }

Path uses dot notation with optional array indices: "status", "tasks[0].exit_code"

You will receive a prompt notification with the result when done. Use sentinel_status to check/cancel.`,
  args: {
    server: tool.schema.string().describe("Name of the MCP server (from opencode config)"),
    tool: tool.schema.string().describe("Name of the tool to call on the MCP server"),
    args: tool.schema
      .string()
      .optional()
      .describe("Arguments for the tool as a JSON string (default: '{}')"),
    interval: tool.schema
      .number()
      .int()
      .min(1000)
      .optional()
      .describe("Poll interval in milliseconds (default: 5000)"),
    timeout: tool.schema
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Maximum poll duration in milliseconds (0 or unset = no limit)"),
    until: tool.schema
      .string()
      .describe(
        'Condition as a JSON string, e.g. \'{"path":"status","is":"eq","value":"completed"}\''
      ),
  },
  async execute(args, ctx) {
    if (!_client) {
      return "Error: Plugin client not initialized.";
    }

    let toolArgs: Record<string, unknown> = {};
    if (args.args) {
      try {
        toolArgs = JSON.parse(args.args);
      } catch {
        return "Error: Invalid JSON for args parameter.";
      }
    }

    let until: SentinelCondition;
    try {
      const parsed = JSON.parse(args.until);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "Error: until must be a JSON object describing a condition.";
      }
      until = parsed as SentinelCondition;
    } catch {
      return "Error: Invalid JSON for until parameter. Must be a valid JSON object.";
    }

    const configResult = await _client.config.get();
    const rawConfig = configResult.data ?? {};
    const resolveServer = makeServerResolver(parseOpencodeMcpConfig(rawConfig));

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
      resolveServer
    );
  },
});

/**
 * `mcp_sentinel_status` — check status of sentinel tasks, list all active
 * tasks, or cancel a running task.
 */
const sentinelStatusTool = tool({
  description: `Check the status of sentinel tasks, list active tasks, or cancel a running task.

Actions:
- "status": Get details of a specific sentinel (requires id)
- "list": List all active sentinel tasks
- "cancel": Cancel a running sentinel (requires id)`,
  args: {
    action: tool.schema
      .enum(["status", "list", "cancel"])
      .optional()
      .describe("Action: status of a sentinel, list active tasks, or cancel a task"),
    id: tool.schema.string().optional().describe("Sentinel ID (required for status and cancel)"),
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
  description: `Block the agent, waiting for a sentinel task to complete. Use this when you want to pause until the result is ready, instead of checking sentinel_status repeatedly.

The tool sleeps and checks the status internally (no token cost during wait). If the user cancels execution, the background async notification still fires normally.

Parameters:
- id: The sentinel ID to wait for
- timeout: Max wait time in ms (optional, waits indefinitely if unset)`,
  args: {
    id: tool.schema.string().describe("The sentinel ID to wait for"),
    timeout: tool.schema
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Maximum wait time in milliseconds (0 or unset = no limit)"),
  },
  async execute(args, ctx) {
    return handleAttach(args.id, args.timeout, () => ctx.abort.aborted);
  },
});

/**
 * `mcp_sentinel_read` — read raw poll outputs from a sentinel task.
 */
const sentinelReadTool = tool({
  description: `Read raw poll outputs from a sentinel task. Useful for debugging when a condition isn't matching — inspect actual MCP responses.

Works whether the sentinel is running, completed, cancelled, or errored.`,
  args: {
    id: tool.schema.string().describe("The sentinel ID to read outputs from"),
    offset: tool.schema
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based start index (default: from end, giving the last N polls)"),
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max number of outputs (default: 5)"),
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
