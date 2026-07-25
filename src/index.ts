import { tool } from "@opencode-ai/plugin";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { parseMcpConfig } from "./services/config-reader.js";
import {
  startSentinel,
  cancelSentinel,
  getSentinelTask,
  getActiveSentinels,
  setNotifyFn,
  cleanup,
} from "./services/sentinel-manager.js";
import { disconnectAll } from "./services/mcp-connection-manager.js";
import type { SentinelRequest } from "./services/types.js";

let _client: OpencodeClient | null = null;

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

    let until: SentinelRequest["until"];
    try {
      const parsed = JSON.parse(args.until);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "Error: until must be a JSON object describing a condition.";
      }
      until = parsed as SentinelRequest["until"];
    } catch {
      return "Error: Invalid JSON for until parameter. Must be a valid JSON object.";
    }

    if (!args.server.trim() || !args.tool.trim()) {
      return "Error: server and tool must be non-empty strings.";
    }

    const configResult = await _client.config.get();
    const rawConfig = configResult.data ?? {};
    const mcpConfig = parseMcpConfig(rawConfig);

    try {
      const request: SentinelRequest = {
        server: args.server,
        tool: args.tool,
        args: toolArgs,
        interval: args.interval,
        timeout: args.timeout,
        until,
        sessionID: ctx.sessionID,
      };

      const id = await startSentinel(request, mcpConfig);

      return `Sentinel started.\n\n**ID:** \`${id}\`\n**Server:** ${request.server}\n**Tool:** ${request.tool}\n**Interval:** ${request.interval ?? 5000}ms\n**Timeout:** ${request.timeout ? request.timeout + "ms" : "none"}\n\nUse \`sentinel_status\` to check progress or cancel.`;
    } catch (err) {
      return `Error: ${String(err)}`;
    }
  },
});

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
    const action = args.action ?? "status";
    switch (action) {
      case "status": {
        if (!args.id) {
          return "Error: id is required for status action.";
        }
        const task = getSentinelTask(args.id);
        if (!task) {
          return `Sentinel \`${args.id}\` not found.`;
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
        if (!args.id) {
          return "Error: id is required for cancel action.";
        }
        const cancelled = cancelSentinel(args.id);
        return cancelled
          ? `Sentinel \`${args.id}\` cancelled.`
          : `Sentinel \`${args.id}\` not found or already completed.`;
      }
      default:
        return `Unknown action: ${action}. Use "status", "list", or "cancel".`;
    }
  },
});

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
    const task = getSentinelTask(args.id);
    if (!task) {
      return `Sentinel \`${args.id}\` not found.`;
    }

    if (task.status !== "polling") {
      if (task.status === "completed") {
        return `Sentinel \`${args.id}\` already completed.\n\n**Result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
      }
      return `Sentinel \`${args.id}\` status: ${task.status}${task.error ? ` — ${task.error}` : ""}`;
    }

    const checkInterval = 1000;
    const startedAt = Date.now();

    while (true) {
      if (ctx.abort.aborted) {
        return "";
      }

      const current = getSentinelTask(args.id);
      if (!current) {
        return `Sentinel \`${args.id}\` no longer exists.`;
      }

      if (current.status !== "polling") {
        if (current.status === "completed") {
          return [
            `## Sentinel Complete`,
            `**ID:** ${current.id}`,
            `**Server:** ${current.request.server}`,
            `**Tool:** ${current.request.tool}`,
            `**Polls:** ${current.pollCount}`,
            `**Duration:** ${((current.resolvedAt! - current.createdAt) / 1000).toFixed(1)}s`,
            `**Result:**\n\`\`\`json\n${JSON.stringify(current.lastResult, null, 2)}\n\`\`\``,
          ].join("\n");
        }
        if (current.status === "timeout") {
          return `Sentinel \`${args.id}\` timed out after ${current.pollCount} polls.`;
        }
        if (current.status === "cancelled") {
          return `Sentinel \`${args.id}\` was cancelled.`;
        }
        return `Sentinel \`${args.id}\` failed: ${current.error || "unknown error"}`;
      }

      if (args.timeout && args.timeout > 0 && Date.now() - startedAt >= args.timeout) {
        return `Attach timed out after ${args.timeout}ms. Sentinel \`${args.id}\` is still running (${current.pollCount} polls so far).`;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  },
});

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
    const task = getSentinelTask(args.id);
    if (!task) {
      return `Sentinel \`${args.id}\` not found.`;
    }

    const max = args.limit ?? 5;
    const all = task.pollLog;
    let slice: typeof all;

    if (args.offset !== undefined) {
      slice = all.slice(args.offset, args.offset + max);
    } else {
      slice = all.slice(-max);
    }

    if (slice.length === 0) {
      if (all.length === 0) {
        return `Sentinel \`${args.id}\` (status: ${task.status}) has no outputs yet.`;
      }
      return `Sentinel \`${args.id}\` has ${all.length} outputs but none match the requested range (offset=${args.offset ?? "end"}, limit=${max}).`;
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
  },
});

async function shutdown() {
  cleanup();
  await disconnectAll();
}

export async function OpenCodeSentinelPlugin(input: PluginInput): Promise<Hooks> {
  _client = input.client;
  setNotifyFn(input.client);

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
