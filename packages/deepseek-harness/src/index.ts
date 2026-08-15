/**
 * DeepSeek Harness adapter — registers the four sentinel tools as native
 * Harness tools and wires harness-specific integration (MCP config discovery
 * and logging) into the framework-agnostic core.
 *
 * All request/response logic lives in `@gcszhn/mcp-sentinel-core`; this file
 * only owns the Harness seams: the `tools` and `agents` services,
 * `ctx.logger`, the `Config` schema, and `ctx.effect()` cleanup. When a
 * background sentinel resolves, it wakes the originating agent via
 * `Agent.followup` (the deepseek-harness push-notification channel).
 *
 * @module
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  cleanup,
  disconnectAll,
  handleAttach,
  handlePoll,
  handleRead,
  handleStatus,
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
import { toMcpConfig } from "./config.js";
import type { Config } from "./config.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "mcp-sentinel";

/** Services required by this plugin: the agent registry and the tool registry. */
export const inject = ["agents", "tools"];

/** Re-export the config schema (value) so Cordis validates it and fills defaults. */
export { Config } from "./config.js";
/** Re-export the config shape types for consumers. */
export type { ServerConfig, StdioServerConfig, StreamableHttpServerConfig } from "./config.js";

/** Canonical string output shared by every sentinel tool (markdown text). */
const textOutput = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
};

/**
 * Build the agent-facing notification text for a resolved sentinel.
 *
 * Lives in the harness, not the core, because the message format is
 * host-specific — other hosts may render completions differently.
 */
function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return `## Sentinel Complete

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Duration:** ${((task.resolvedAt! - task.createdAt) / 1000).toFixed(1)}s
**Result:**
\`\`\`json
${JSON.stringify(task.lastResult, null, 2)}
\`\`\``;
    case "failed":
      return `## Sentinel Failed

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Error:** ${task.error}`;
    case "timeout":
      return `## Sentinel Timeout

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Last result:**
\`\`\`json
${JSON.stringify(task.lastResult, null, 2)}
\`\`\``;
  }
}

const POLL_DESCRIPTION = `Submit a long-running MCP tool call and poll it at regular intervals until a condition is met. The sentinel polls silently (zero token cost) and the agent collects the result with sentinel_attach / sentinel_status / sentinel_read.

Parameters:
- server: MCP server name (from this plugin's "servers" config)
- tool: Tool name to call on the server
- args: Arguments for the tool (JSON string, default: "{}")
- interval: Poll interval in ms (min 1000, default: 5000)
- timeout: Max poll duration in ms (optional, polls until condition met if unset)
- until: Condition object to wait for

Condition model:
{ "path": "field", "is": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"match", "value": any }
{ "not": <condition> }
{ "and": [<condition>, ...] }
{ "or": [<condition>, ...] }

Path uses dot notation with optional array indices: "status", "tasks[0].exit_code".`;

const STATUS_DESCRIPTION = `Check the status of sentinel tasks, list active tasks, or cancel a running task.

Actions:
- "status": Get details of a specific sentinel (requires id)
- "list": List all active sentinel tasks
- "cancel": Cancel a running sentinel (requires id)`;

const ATTACH_DESCRIPTION = `Block the agent, waiting for a sentinel task to complete. Use this when you want to pause until the result is ready, instead of checking sentinel_status repeatedly.

The tool sleeps and checks the status internally (no token cost during wait).

Parameters:
- id: The sentinel ID to wait for
- timeout: Max wait time in ms (optional, waits indefinitely if unset)`;

const READ_DESCRIPTION = `Read raw poll outputs from a sentinel task. Useful for debugging when a condition isn't matching — inspect actual MCP responses.

Works whether the sentinel is running, completed, cancelled, or errored.`;

/**
 * DeepSeek Harness plugin entry point.
 *
 * Installs a logger sink, builds a server resolver from the resolved config,
 * registers the four sentinel tools, and schedules core cleanup on unload.
 *
 * @param ctx - plugin context carrying the tool registry and logger.
 * @param config - validated MCP server configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("mcp-sentinel");
  setLogSink((level, message, extra) => {
    const text =
      extra && Object.keys(extra).length > 0 ? `${message} ${JSON.stringify(extra)}` : message;
    const write = logger[level];
    if (typeof write === "function") {
      write.call(logger, text);
    } else {
      // Preview-stage safety net: if the Cordis logger surface changes under
      // us, keep the diagnostic visible instead of failing silently.
      console.error(`[mcp-sentinel] ${level}: ${text}`);
    }
  });

  // When a background sentinel resolves, push a completion notice into the
  // originating agent's inbox via `Agent.followup` so the driver wakes and the
  // agent can collect the result — the deepseek-harness equivalent of
  // OpenCode's `promptAsync` push notification. Notification failures are
  // contained and logged: they must never disturb the sentinel task itself.
  const notifier: SentinelNotifier = (task, event) => {
    const sessionID = task.request.sessionID;
    if (!sessionID) {
      logger.warn(
        `sentinel ${task.id} resolved without a sessionID — push notification skipped (agentless call?)`
      );
      return;
    }

    let agent: Agent | undefined;
    try {
      agent = ctx.agents.get(SessionId(sessionID));
    } catch (err) {
      logger.warn(`sentinel ${task.id}: ctx.agents.get("${sessionID}") threw — ${String(err)}`);
      return;
    }
    if (!agent) {
      logger.warn(
        `sentinel ${task.id} resolved but agent "${sessionID}" is no longer live — push notification skipped`
      );
      return;
    }

    try {
      const text = buildNotificationText(task, event);
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: {
            kind: "plugin",
            plugin: "mcp-sentinel",
            form: "notice",
            summary: `sentinel ${task.id} ${event}`,
          },
        })
      );
    } catch (err) {
      logger.warn(`sentinel ${task.id}: agent.followup failed — ${String(err)}`);
    }
  };
  setNotifier(notifier);

  const resolveServer = makeServerResolver(toMcpConfig(config));

  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_poll",
      description: POLL_DESCRIPTION,
      parameters: {
        server: {
          type: "string",
          required: true,
          description: 'Name of the MCP server (from this plugin\'s "servers" config)',
        },
        tool: {
          type: "string",
          required: true,
          description: "Name of the tool to call on the MCP server",
        },
        args: {
          type: "string",
          description: 'Arguments for the tool as a JSON string (default: "{}")',
        },
        interval: {
          type: "number",
          description: "Poll interval in milliseconds (default: 5000)",
        },
        timeout: {
          type: "number",
          description: "Maximum poll duration in milliseconds (0 or unset = no limit)",
        },
        until: {
          type: "string",
          required: true,
          description:
            'Condition as a JSON string, e.g. \'{"path":"status","is":"eq","value":"completed"}\'',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        if (!exec.agent) {
          logger.warn(
            "mcp_sentinel_poll: no agent in the execution context — the sentinel will run but cannot push a completion notification"
          );
        }

        let toolArgs: Record<string, unknown> = {};
        if (args.args) {
          try {
            const parsed: unknown = JSON.parse(args.args);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return "Error: args must be a JSON object.";
            }
            toolArgs = parsed as Record<string, unknown>;
          } catch {
            return "Error: Invalid JSON for args parameter.";
          }
        }

        let until: SentinelCondition;
        try {
          const parsed: unknown = JSON.parse(args.until);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return "Error: until must be a JSON object describing a condition.";
          }
          until = parsed as SentinelCondition;
        } catch {
          return "Error: Invalid JSON for until parameter. Must be a valid JSON object.";
        }

        return handlePoll(
          {
            server: args.server,
            tool: args.tool,
            args: toolArgs,
            interval: args.interval,
            timeout: args.timeout,
            until,
            sessionID: exec.agent?.id,
          },
          resolveServer
        );
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_status",
      description: STATUS_DESCRIPTION,
      parameters: {
        action: {
          type: "string",
          enum: ["status", "list", "cancel"],
          description: "Action: status of a sentinel, list active tasks, or cancel a task",
        },
        id: {
          type: "string",
          description: "Sentinel ID (required for status and cancel)",
        },
      },
      output: textOutput,
      execute(args) {
        return Promise.resolve(handleStatus(args.action, args.id));
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_attach",
      description: ATTACH_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: "The sentinel ID to wait for",
        },
        timeout: {
          type: "number",
          description: "Maximum wait time in milliseconds (0 or unset = no limit)",
        },
      },
      output: textOutput,
      async execute(args, exec) {
        return handleAttach(args.id, args.timeout, () => exec.signal.aborted);
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_read",
      description: READ_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: "The sentinel ID to read outputs from",
        },
        offset: {
          type: "number",
          description: "0-based start index (default: from end, giving the last N polls)",
        },
        limit: {
          type: "number",
          description: "Max number of outputs (default: 5)",
        },
      },
      output: textOutput,
      execute(args) {
        return Promise.resolve(handleRead(args.id, args.offset, args.limit));
      },
    })
  );

  // Core cleanup runs when the plugin unloads (HMR replacement, profile
  // teardown): stop all sentinel timers, clear TTL timers, close connections.
  ctx.effect(() => {
    return () => {
      cleanup();
      void disconnectAll();
    };
  }, "mcp-sentinel.cleanup");
}
