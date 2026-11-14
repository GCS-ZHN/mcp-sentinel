/**
 * OpenCode 2 (V2) adapter — registers the four sentinel tools through the V2
 * `Plugin.define` / `ctx.tool.transform` API and wires OpenCode-specific
 * integration (MCP config discovery, synthetic session notifications, console
 * logging) into the framework-agnostic core.
 *
 * All request/response logic lives in `@gcszhn/mcp-sentinel-core/tools`; this
 * file owns only the V2 seams:
 * - `ctx.mcp.transform(editor => editor.list())` for MCP config discovery
 * - `ctx.tool.transform(editor => editor.add(...))` for JSON-Schema tools
 * - `context.sessionID` / `context.signal` for task ownership and abort
 * - `ctx.session.synthetic()` for completion delivery
 * - a cleanup function returned from `setup` for resource release
 *
 * @module
 */

import { Plugin } from "@opencode/plugin";
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
  logError,
  logInfo,
  logWarn,
  makeConnectionInvoker,
  makeServerResolver,
} from "@gcszhn/mcp-sentinel-core";
import type { LogSink, SentinelCondition, SentinelNotifier } from "@gcszhn/mcp-sentinel-core";
import { describeServerProblem, normalizeOpencode2McpConfig } from "./config.js";
import type { Opencode2McpEntry, Opencode2McpStatus } from "./config.js";
import {
  claimSession,
  getHostBindingCount,
  registerHostBinding,
  unregisterHostBinding,
} from "./host-registry.js";
import type { HostBinding } from "./host-registry.js";
import { buildNotificationText } from "./notify.js";

/** Stable plugin identifier used by OpenCode diagnostics and plugin storage. */
const PLUGIN_ID = "mcp-sentinel-opencode2";

/** Session-inbox delivery strategy for completion notices. */
type Delivery = "steer" | "queue";

// ---------------------------------------------------------------------------
// Tool input parsing
//
// V2 validates tool inputs against the JSON Schemas registered below. These
// parsers are a defensive backstop that returns a clean `"Error: ..."` string
// instead of letting a malformed object reach the core.
// ---------------------------------------------------------------------------

interface PollInput {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  interval?: number;
  timeout?: number;
  until: SentinelCondition;
}

interface StatusInput {
  action?: string;
  id?: string;
}

interface AttachInput {
  id: string;
  timeout?: number;
}

interface ReadInput {
  id: string;
  offset?: number;
  limit?: number;
}

function parsePollInput(raw: unknown): PollInput | string {
  if (!isRecord(raw)) return "Error: invalid poll input; expected a JSON object.";
  if (typeof raw.server !== "string") return "Error: server must be a string.";
  if (typeof raw.tool !== "string") return "Error: tool must be a string.";

  if (raw.args !== undefined && !isRecord(raw.args)) {
    return "Error: args must be a JSON object.";
  }
  if (!isNonNegativeInteger(raw.interval)) {
    return "Error: interval must be a non-negative integer.";
  }
  if (!isNonNegativeInteger(raw.timeout)) {
    return "Error: timeout must be a non-negative integer.";
  }
  if (!isRecord(raw.until)) {
    return "Error: until must be a JSON object describing a condition.";
  }

  return {
    server: raw.server,
    tool: raw.tool,
    args: raw.args ?? {},
    interval: raw.interval,
    timeout: raw.timeout,
    until: raw.until as unknown as SentinelCondition,
  };
}

function parseStatusInput(raw: unknown): StatusInput | string {
  if (!isRecord(raw)) return "Error: invalid status input; expected a JSON object.";
  if (raw.action !== undefined && typeof raw.action !== "string") {
    return "Error: action must be a string.";
  }
  if (raw.id !== undefined && typeof raw.id !== "string") {
    return "Error: id must be a string.";
  }
  return { action: raw.action, id: raw.id };
}

function parseAttachInput(raw: unknown): AttachInput | string {
  if (!isRecord(raw)) return "Error: invalid attach input; expected a JSON object.";
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return "Error: id must be a non-empty string.";
  }
  if (!isNonNegativeInteger(raw.timeout)) {
    return "Error: timeout must be a non-negative integer.";
  }
  return { id: raw.id, timeout: raw.timeout };
}

function parseReadInput(raw: unknown): ReadInput | string {
  if (!isRecord(raw)) return "Error: invalid read input; expected a JSON object.";
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return "Error: id must be a non-empty string.";
  }
  if (!isNonNegativeInteger(raw.offset)) {
    return "Error: offset must be a non-negative integer.";
  }
  if (!isNonNegativeInteger(raw.limit) || (raw.limit !== undefined && raw.limit < 1)) {
    return "Error: limit must be a positive integer.";
  }
  return { id: raw.id, offset: raw.offset, limit: raw.limit };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    // V2 exposes MCP *configuration* only inside a transform; `ctx.mcp.list()`
    // returns connection status, not config. Capture the current entries from
    // this cheap, synchronous, replayable callback. OpenCode replays it when
    // the registry is rebuilt (for example after a config reload).
    let mcpEntries: readonly Opencode2McpEntry[] = [];
    await ctx.mcp.transform((editor) => {
      mcpEntries = editor.list();
    });

    const delivery: Delivery = ctx.options.delivery === "steer" ? "steer" : "queue";
    const resume = ctx.options.resume !== false;

    const logSink: LogSink = (level, message, extra) => {
      const line = `[mcp-sentinel] ${message}`;
      const details = extra && Object.keys(extra).length > 0 ? extra : undefined;
      switch (level) {
        case "debug":
          console.debug(line, details ?? "");
          break;
        case "info":
          console.log(line, details ?? "");
          break;
        case "warn":
          console.warn(line, details ?? "");
          break;
        case "error":
          console.error(line, details ?? "");
          break;
        default:
          console.log(line, details ?? "");
          break;
      }
    };

    const notifier: SentinelNotifier = async (task, event) => {
      const sessionID = task.request.sessionID;
      if (!sessionID) return;

      try {
        // Synthetic messages are background system notices, not user prompts:
        // they bypass the prompt-admission hook and resume the session by
        // default. `queue` avoids reordering work the user is already doing.
        const synthetic = {
          sessionID,
          text: buildNotificationText(task, event),
          description: "MCP Sentinel result",
          delivery,
          resume,
        } as Parameters<typeof ctx.session.synthetic>[0];
        await ctx.session.synthetic(synthetic);
      } catch (err) {
        // The task remains queryable via status/read; log the delivery failure
        // so it can be diagnosed instead of disappearing silently.
        logError("Failed to deliver sentinel notification", {
          id: task.id,
          sessionID,
          error: String(err),
        });
        throw err;
      }
    };

    const binding: HostBinding = { notifier, logSink };
    registerHostBinding(binding);
    logInfo("MCP Sentinel OpenCode 2 plugin initialized", { version: ctx.app.version });

    /** Read a server's connection status from the host's MCP domain. */
    const getMcpStatus = async (name: string): Promise<Opencode2McpStatus | undefined> => {
      const listed = await ctx.mcp.list();
      const found = listed.data.find((server) => server.name === name);
      if (!found) return undefined;
      const status = found.status;
      if (status.status === "failed" || status.status === "needs_auth") {
        return { status: status.status, error: status.error };
      }
      return { status: status.status };
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "mcp_sentinel_poll",
        description: `${POLL_TOOL_DESCRIPTION}

${COMPLETION_NOTIFICATION_NOTE}`,
        input: {
          type: "object",
          properties: {
            server: { type: "string", description: SERVER_DESCRIPTION },
            tool: { type: "string", description: TOOL_DESCRIPTION },
            args: { type: "object", description: ARGS_DESCRIPTION, additionalProperties: true },
            interval: { type: "integer", minimum: 1000, description: INTERVAL_DESCRIPTION },
            timeout: { type: "integer", minimum: 0, description: POLL_TIMEOUT_DESCRIPTION },
            until: { type: "object", description: UNTIL_DESCRIPTION, additionalProperties: true },
          },
          required: ["server", "tool", "until"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const input = parsePollInput(raw);
          if (typeof input === "string") return { content: input };

          // Snapshot the captured config for this call so a replay during the
          // poll cannot split resolution and invocation across versions.
          const entries = mcpEntries;
          let status: Opencode2McpStatus | undefined;
          if (input.server.trim()) {
            try {
              status = await getMcpStatus(input.server);
            } catch (err) {
              // Status is only a preflight aid. The sentinel opens its own
              // connection, so proceed if the status lookup itself fails.
              logWarn("Could not read MCP status before polling", {
                server: input.server,
                error: String(err),
              });
            }
          }

          const problem = describeServerProblem(entries, input.server, status);
          if (problem) return { content: problem };

          claimSession(context.sessionID, binding);
          const content = await handlePoll(
            {
              ...input,
              sessionID: context.sessionID,
            },
            makeConnectionInvoker(makeServerResolver(normalizeOpencode2McpConfig(entries)))
          );
          return { content };
        },
      });

      editor.add({
        name: "mcp_sentinel_status",
        description: STATUS_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "list", "cancel"],
              description: ACTION_DESCRIPTION,
            },
            id: { type: "string", description: STATUS_ID_DESCRIPTION },
          },
          additionalProperties: false,
        },
        async execute(raw) {
          const input = parseStatusInput(raw);
          if (typeof input === "string") return { content: input };
          return { content: handleStatus(input.action, input.id) };
        },
      });

      editor.add({
        name: "mcp_sentinel_attach",
        description: ATTACH_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: ATTACH_ID_DESCRIPTION },
            timeout: { type: "integer", minimum: 0, description: ATTACH_TIMEOUT_DESCRIPTION },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const input = parseAttachInput(raw);
          if (typeof input === "string") return { content: input };
          return {
            content: await handleAttach(input.id, input.timeout, () => context.signal.aborted),
          };
        },
      });

      editor.add({
        name: "mcp_sentinel_read",
        description: READ_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: READ_ID_DESCRIPTION },
            offset: { type: "integer", minimum: 0, description: READ_OFFSET_DESCRIPTION },
            limit: { type: "integer", minimum: 1, description: READ_LIMIT_DESCRIPTION },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(raw) {
          const input = parseReadInput(raw);
          if (typeof input === "string") return { content: input };
          return { content: handleRead(input.id, input.offset, input.limit) };
        },
      });
    });

    // V2 disposes registrations automatically. Release only the process-wide
    // core resources once the last plugin instance for this server unloads;
    // otherwise one location would wipe another location's sentinels.
    return async () => {
      unregisterHostBinding(binding);
      if (getHostBindingCount() === 0) {
        cleanup();
        await disconnectAll();
      }
    };
  },
});
