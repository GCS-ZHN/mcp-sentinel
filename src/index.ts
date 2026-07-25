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
- timeout: Max poll duration in ms (optional, polls until condition met if unset)
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
      .describe(
        "Maximum poll duration in milliseconds (optional, polls until condition met if unset)"
      ),
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

const pollAttachTool = tool({
  description: `Block the agent, waiting for a sentinel poll task to complete. Use this when you want to pause until the polled result is ready, instead of checking poll_status repeatedly.

The tool sleeps and checks the poll status internally (no token cost during wait). If the user cancels execution, the background async notification still fires normally.

Parameters:
- poll_id: The poll ID to wait for
- timeout: Max wait time in ms (optional, waits indefinitely if unset)`,
  args: {
    poll_id: tool.schema.string().describe("The poll ID to wait for"),
    timeout: tool.schema
      .number()
      .int()
      .min(1000)
      .optional()
      .describe("Maximum wait time in milliseconds (optional)"),
  },
  async execute(args, ctx) {
    const task = getPollTask(args.poll_id);
    if (!task) {
      return `Poll \`${args.poll_id}\` not found.`;
    }

    if (task.status !== "polling") {
      if (task.status === "completed") {
        return `Poll \`${args.poll_id}\` already completed.\n\n**Result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
      }
      return `Poll \`${args.poll_id}\` status: ${task.status}${task.error ? ` — ${task.error}` : ""}`;
    }

    const checkInterval = 1000;
    const startedAt = Date.now();

    while (true) {
      if (ctx.abort.aborted) {
        return "";
      }

      const current = getPollTask(args.poll_id);
      if (!current) {
        return `Poll \`${args.poll_id}\` no longer exists.`;
      }

      if (current.status !== "polling") {
        if (current.status === "completed") {
          return [
            `## Poll Complete`,
            `**ID:** ${current.id}`,
            `**Server:** ${current.request.server}`,
            `**Tool:** ${current.request.tool}`,
            `**Polls:** ${current.pollCount}`,
            `**Duration:** ${((current.resolvedAt! - current.createdAt) / 1000).toFixed(1)}s`,
            `**Result:**\n\`\`\`json\n${JSON.stringify(current.lastResult, null, 2)}\n\`\`\``,
          ].join("\n");
        }
        if (current.status === "timeout") {
          return `Poll \`${args.poll_id}\` timed out after ${current.pollCount} polls.`;
        }
        return `Poll \`${args.poll_id}\` failed: ${current.error || "unknown error"}`;
      }

      if (args.timeout && Date.now() - startedAt >= args.timeout) {
        return `Attach timed out after ${args.timeout}ms. Poll \`${args.poll_id}\` is still running (${current.pollCount} polls so far).`;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
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
      poll_attach: pollAttachTool,
    },
  };
}
