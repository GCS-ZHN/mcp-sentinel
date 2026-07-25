import { tool } from "@opencode-ai/plugin";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { parseMcpConfig } from "./services/config-reader.js";
import {
  startPoll,
  cancelPoll,
  getPollTask,
  getActivePolls,
  setNotifyFn,
  cleanup,
} from "./services/poll-manager.js";
import { disconnectAll } from "./services/mcp-connection-manager.js";
import type { PollRequest } from "./services/types.js";

let _client: OpencodeClient | null = null;

const pollMcpTool = tool({
  description: `Submit a long-running MCP tool call and poll it at regular intervals until a condition is met. The sentinel polls silently (zero token cost) and notifies you when done.

Parameters:
- server: MCP server name (from opencode config)
- tool: Tool name to call on the server
- args: Arguments for the tool (JSON object, default: {})
- interval: Poll interval in ms (min 1000, default: 5000)
- timeout: Max poll duration in ms (min 5000, default: 600000 = 10 min)
- until: Condition object to wait for

Condition model:
{ "path": "field", "is": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"match", "value": any }
{ "not": <condition> }
{ "and": [<condition>, ...] }
{ "or": [<condition>, ...] }

Path uses dot notation with optional array indices: "status", "tasks[0].exit_code"

You will receive a prompt notification with the result when done. Use poll_status to check/cancel.`,
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
      .min(5000)
      .optional()
      .describe("Maximum poll duration in milliseconds (default: 600000)"),
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

    let until: PollRequest["until"];
    try {
      until = JSON.parse(args.until);
    } catch {
      return "Error: Invalid JSON for until parameter. Must be a valid JSON object describing the condition.";
    }

    const configResult = await _client.config.get();
    const rawConfig = configResult.data ?? {};
    const mcpConfig = parseMcpConfig(rawConfig);

    const request: PollRequest = {
      server: args.server,
      tool: args.tool,
      args: toolArgs,
      interval: args.interval,
      timeout: args.timeout,
      until,
      sessionID: ctx.sessionID,
    };

    const pollId = await startPoll(request, mcpConfig);

    return `Sentinel started polling.\n\n**Poll ID:** \`${pollId}\`\n**Server:** ${request.server}\n**Tool:** ${request.tool}\n**Interval:** ${request.interval ?? 5000}ms\n**Timeout:** ${request.timeout ?? 600000}ms\n\nYou will be notified when the condition is met or the poll times out. Use \`poll_status\` to check progress or cancel.`;
  },
});

const pollStatusTool = tool({
  description: `Check the status of sentinel polls, list active polls, or cancel a running poll.

Actions:
- "status": Get details of a specific poll (requires poll_id)
- "list": List all active polling tasks
- "cancel": Cancel a running poll (requires poll_id)`,
  args: {
    action: tool.schema
      .enum(["status", "list", "cancel"])
      .describe("Action: status of a poll, list active polls, or cancel a poll"),
    poll_id: tool.schema.string().optional().describe("Poll ID (required for status and cancel)"),
  },
  async execute(args) {
    switch (args.action) {
      case "status": {
        if (!args.poll_id) {
          return "Error: poll_id is required for status action.";
        }
        const task = getPollTask(args.poll_id);
        if (!task) {
          return `Poll \`${args.poll_id}\` not found.`;
        }
        return [
          `**Poll ID:** ${task.id}`,
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
        const polls = getActivePolls();
        if (polls.length === 0) {
          return "No active polls.";
        }
        return polls
          .map(
            (t) =>
              `- \`${t.id}\` | ${t.request.server}/${t.request.tool} | count=${t.pollCount} | ${new Date(t.createdAt).toISOString()}`
          )
          .join("\n");
      }
      case "cancel": {
        if (!args.poll_id) {
          return "Error: poll_id is required for cancel action.";
        }
        const cancelled = cancelPoll(args.poll_id);
        return cancelled
          ? `Poll \`${args.poll_id}\` cancelled.`
          : `Poll \`${args.poll_id}\` not found or already completed.`;
      }
    }
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
      poll_mcp: pollMcpTool,
      poll_status: pollStatusTool,
    },
  };
}
