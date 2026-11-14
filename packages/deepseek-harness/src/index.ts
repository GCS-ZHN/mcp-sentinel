/**
 * DeepSeek Harness adapter — registers the four sentinel tools as native
 * Harness tools and wires harness-specific integration (logging and push
 * notification) into the framework-agnostic core.
 *
 * All request/response logic lives in `@gcszhn/mcp-sentinel-core`; this file
 * only owns the Harness seams: the `tools` and `agents` services,
 * `ctx.logger`, and `ctx.effect()` cleanup. It runs in **external-invoker
 * mode**: instead of handing the core MCP server config, it reuses the MCP
 * tools already registered by `@deepseek-ai/dsh-mcp-client` through
 * `ctx.tools.execute`, so the user never configures MCP twice. When a
 * background sentinel resolves, it wakes the originating agent via
 * `Agent.followup` (the deepseek-harness push-notification channel).
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolBatchResult, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
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
  parseMcpContent,
  setLogSink,
  setNotifier,
} from "@gcszhn/mcp-sentinel-core";
import type {
  SentinelCondition,
  SentinelEvent,
  SentinelNotifier,
  SentinelTask,
  ToolInvoker,
} from "@gcszhn/mcp-sentinel-core";

/** Cordis plugin name used by loader diagnostics. */
export const name = "mcp-sentinel";

/** Services required by this plugin: the agent registry and the tool registry. */
export const inject = ["agents", "tools"];

// Harness 0.2.x has no shared catch-all source kind; each producer declares
// its own. The completion notice is a one-off account of the sentinel resolving.
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "mcp-sentinel": { kind: "mcp-sentinel" } & ContextFormed;
  }
}

/** Canonical string output shared by every sentinel tool (markdown text). */
const textOutput = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
};

/**
 * Extract the canonical poll result from a `ctx.tools.execute` outcome.
 *
 * `@deepseek-ai/dsh-mcp-client` registers each MCP tool with the canonical
 * value `{ content: JsonValue[], structuredContent? }`. Prefer the structured
 * object when present; otherwise parse the rendered model-facing text blocks.
 * Tool failures throw with their error code (e.g. `UNKNOWN_TOOL`) preserved.
 *
 * Exported for unit testing — this is the one harness-specific result-shape
 * translation the external-invoker mode owns.
 */
export function extractToolResult(result: ToolExecutionResult): unknown {
  if (result.isError) {
    const code = result.error.info?.code;
    throw new Error(code ? `${code}: ${result.error.message}` : result.error.message);
  }
  const value = result.value as { structuredContent?: unknown } | null;
  if (value && typeof value === "object" && value.structuredContent !== undefined) {
    return value.structuredContent;
  }
  return parseMcpContent(result.content);
}

/**
 * Extract the single sentinel call from a Harness 0.2.x execution batch.
 *
 * `ctx.tools.execute` now accepts a raw call batch and returns one settled
 * outcome per call. The sentinel always submits exactly one call, so an empty
 * batch means the host violated that contract and must fail loudly instead of
 * polling `undefined` forever.
 */
export function extractSingleResult(batch: ToolBatchResult): unknown {
  const settled = batch.results[0];
  if (settled === undefined) {
    throw new Error("tool execution returned no result for the sentinel call");
  }
  return extractToolResult(settled.result);
}

/** DeepSeek Harness function-name contract: only `[A-Za-z0-9_-]`, at most 64 chars. */
const MCP_TOOL_NAME_MAX = 64;

/** Characters the Harness replaces when an MCP identity is used as a tool name. */
const MCP_TOOL_NAME_INVALID = /[^A-Za-z0-9_-]/g;

/**
 * Resolve the Harness tool-registry name for an MCP tool.
 *
 * `@deepseek-ai/dsh-mcp-client` registers tools as
 * `mcp__<serverName>__<rawName>` when that identity is already a valid
 * DeepSeek function name. Otherwise it replaces invalid characters and
 * truncates to 64 chars, appending a 12-hex-char SHA-256 hash of
 * `serverName\0rawName` so distinct MCP identities never collide. This mirrors
 * `publicToolName` in `dsh-mcp-client/src/tools.ts` (not exported from the
 * package entrypoint); the sentinel must address the same registered name or
 * every call on a dotted/slashed tool name would resolve as `UNKNOWN_TOOL`.
 */
export function mcpToolName(server: string, tool: string): string {
  const joined = `mcp__${server}__${tool}`;
  const normalized = joined.replace(MCP_TOOL_NAME_INVALID, "_");
  if (normalized === joined && normalized.length <= MCP_TOOL_NAME_MAX) {
    return normalized;
  }
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, MCP_TOOL_NAME_MAX - 12 - 1)}_${hash}`;
}

/**
 * Build the agent-facing notification text for a resolved sentinel.
 *
 * Lives in the harness, not the core, because the message format is
 * host-specific — other hosts may render completions differently.
 */
export function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return `## Sentinel Complete

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Duration:** ${task.resolvedAt != null ? ((task.resolvedAt - task.createdAt) / 1000).toFixed(1) : "—"}s
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

/**
 * DeepSeek Harness plugin entry point.
 *
 * Installs a logger sink, builds an external tool invoker over the harness's
 * already-registered MCP tools, registers the four sentinel tools, and
 * schedules core cleanup on unload.
 *
 * @param ctx - plugin context carrying the tool registry, agent registry, and logger.
 */
export function apply(ctx: Context): void {
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
            kind: "mcp-sentinel",
            form: "notice",
            summary: boundContextSummary(`sentinel ${task.id} ${event}`),
          },
        })
      );
    } catch (err) {
      logger.warn(`sentinel ${task.id}: agent.followup failed — ${String(err)}`);
    }
  };
  setNotifier(notifier);

  // External-invoker mode: call the MCP tools already registered by
  // `@deepseek-ai/dsh-mcp-client` through the harness tool registry instead of
  // owning MCP connections in the core. The server name maps to the
  // `serverName` of an mcp-client instance, and the tool name to the public
  // registry name derived from its raw MCP name. Passing the originating agent
  // keeps the call in that agent's executor/tool scope; it is absent only for
  // agentless programmatic polls.
  const invoke: ToolInvoker = async (server, tool, args, context) => {
    const agent =
      context?.sessionID === undefined ? undefined : ctx.agents.get(SessionId(context.sessionID));
    const callArguments = JSON.stringify(args);
    if (callArguments === undefined) {
      throw new Error(`sentinel arguments for ${server}/${tool} are not JSON-serializable`);
    }
    const batch = await ctx.tools.execute({
      calls: [
        {
          type: "tool-call",
          id: ToolCallId(`sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`),
          name: mcpToolName(server, tool),
          arguments: callArguments,
        },
      ],
      signal: new AbortController().signal,
      ...(agent === undefined ? {} : { agent }),
    });
    return extractSingleResult(batch);
  };

  // doc: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools#the-unified-json-value-schema-dsl
  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_poll",
      description: `${POLL_TOOL_DESCRIPTION}

${COMPLETION_NOTIFICATION_NOTE}`,
      parameters: {
        server: {
          type: "string",
          required: true,
          description: SERVER_DESCRIPTION,
        },
        tool: {
          type: "string",
          required: true,
          description: TOOL_DESCRIPTION,
        },
        args: {
          type: "json",
          description: ARGS_DESCRIPTION,
        },
        interval: {
          type: "number",
          description: INTERVAL_DESCRIPTION,
        },
        timeout: {
          type: "number",
          description: POLL_TIMEOUT_DESCRIPTION,
        },
        until: {
          type: "json",
          required: true,
          description: UNTIL_DESCRIPTION,
        },
      },
      output: textOutput,
      async execute(args, exec) {
        if (!exec.agent) {
          logger.warn(
            "mcp_sentinel_poll: no agent in the execution context — the sentinel will run but cannot push a completion notification"
          );
        }

        const toolArgs = (args.args ?? {}) as Record<string, unknown>;
        const until = args.until as unknown as SentinelCondition;

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
          invoke
        );
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "mcp_sentinel_status",
      description: STATUS_TOOL_DESCRIPTION,
      parameters: {
        action: {
          type: "string",
          enum: ["status", "list", "cancel"],
          description: ACTION_DESCRIPTION,
        },
        id: {
          type: "string",
          description: STATUS_ID_DESCRIPTION,
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
      description: ATTACH_TOOL_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: ATTACH_ID_DESCRIPTION,
        },
        timeout: {
          type: "number",
          description: ATTACH_TIMEOUT_DESCRIPTION,
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
      description: READ_TOOL_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: READ_ID_DESCRIPTION,
        },
        offset: {
          type: "number",
          description: READ_OFFSET_DESCRIPTION,
        },
        limit: {
          type: "number",
          description: READ_LIMIT_DESCRIPTION,
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
