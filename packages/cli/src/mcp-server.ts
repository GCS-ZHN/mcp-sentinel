/**
 * Sentinel stdio MCP server for the CLI.
 *
 * Registers the four `mcp_sentinel_*` tools against a harness-discovered MCP
 * config (connection-pool mode) and serves them over stdio. All request /
 * response logic lives in `@gcszhn/mcp-sentinel-core`; this module only owns
 * the MCP server seams.
 *
 * The CLI deliberately sets the notifier to `null`: as a generic MCP server it
 * has no harness message channel (no OpenCode `promptAsync`, no Codex hook),
 * so background completion is collected by the agent via
 * `mcp_sentinel_attach` / `mcp_sentinel_status` / `mcp_sentinel_read`.
 *
 * @module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import {
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
import type { McpConfig, SentinelCondition } from "@gcszhn/mcp-sentinel-core";
import pkg from "../package.json" with { type: "json" };

const POLL_DESCRIPTION = [
  "Submit a long-running MCP tool call and poll it at regular intervals until a condition is met. The sentinel polls silently (zero token cost) and you collect the result via mcp_sentinel_status, mcp_sentinel_attach, or mcp_sentinel_read.",
  "",
  "Parameters:",
  "- server: MCP server name (from the harness MCP config)",
  "- tool: Tool name to call on the server",
  "- args: Arguments for the tool (JSON object, default: {})",
  "- interval: Poll interval in ms (min 1000, default: 5000)",
  "- timeout: Max poll duration in ms (optional, polls until condition met if unset)",
  "- until: Condition object to wait for",
  "",
  "Condition model:",
  '{ "path": "field", "is": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"match", "value": any }',
  '{ "not": <condition> }',
  '{ "and": [<condition>, ...] }',
  '{ "or": [<condition>, ...] }',
  "",
  'Path uses dot notation with optional array indices: "status", "tasks[0].exit_code"',
].join("\n");

const STATUS_DESCRIPTION = [
  "Check the status of sentinel tasks, list active tasks, or cancel a running task.",
  "",
  "Actions:",
  '- "status": Get details of a specific sentinel (requires id)',
  '- "list": List all active sentinel tasks',
  '- "cancel": Cancel a running sentinel (requires id)',
].join("\n");

const ATTACH_DESCRIPTION = [
  "Wait for a sentinel task to complete. Use this when you want to block until the result is ready.",
  "",
  "Parameters:",
  "- id: The sentinel ID to wait for",
  "- timeout: Max wait time in ms (optional, waits indefinitely if unset)",
].join("\n");

const READ_DESCRIPTION = [
  "Read raw poll outputs from a sentinel task. Useful for debugging when a condition isn't matching — inspect actual MCP responses.",
  "",
  "Works whether the sentinel is running, completed, cancelled, or errored.",
].join("\n");

/**
 * Start the sentinel stdio MCP server against the given MCP config.
 *
 * Blocks until the stdio transport closes. Installs signal handlers for a
 * graceful shutdown (stop timers, close cached MCP connections).
 *
 * @param mcpConfig - The harness-discovered MCP config to poll.
 */
export async function startMcpServer(mcpConfig: McpConfig): Promise<void> {
  // Core logging → stderr, so harness diagnostics surface poll events without
  // polluting the tool's stdout JSON-RPC.
  setLogSink((level, message, extra) => {
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
    process.stderr.write(`[mcp-sentinel][${level}] ${message}${suffix}\n`);
  });

  // No harness message channel: background completions are collected via
  // mcp_sentinel_attach / status / read.
  setNotifier(null);

  const resolveServer = makeServerResolver(mcpConfig);
  const invoke = makeConnectionInvoker(resolveServer);

  const server = new McpServer(
    { name: pkg.name ?? "@gcszhn/mcp-sentinel-cli", version: pkg.version ?? "0.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "mcp_sentinel_poll",
    {
      description: POLL_DESCRIPTION,
      inputSchema: {
        server: z.string().describe("Name of the MCP server (from the harness MCP config)"),
        tool: z.string().describe("Name of the tool to call on the MCP server"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the tool (JSON object, default: {})"),
        interval: z
          .number()
          .int()
          .min(1000)
          .optional()
          .describe("Poll interval in milliseconds (default: 5000)"),
        timeout: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Maximum poll duration in milliseconds (0 or unset = no limit)"),
        until: z.unknown().describe("Condition object to wait for"),
      },
    },
    async (args) => {
      if (!args.server.trim() || !args.tool.trim()) {
        return {
          content: [
            { type: "text" as const, text: "Error: server and tool must be non-empty strings." },
          ],
        };
      }
      if (!resolveServer(args.server)) {
        return {
          content: [{ type: "text" as const, text: `Error: Unknown MCP server: ${args.server}` }],
        };
      }
      const text = await handlePoll(
        {
          server: args.server,
          tool: args.tool,
          args: args.args ?? {},
          interval: args.interval,
          timeout: args.timeout,
          until: args.until as SentinelCondition,
        },
        invoke
      );
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "mcp_sentinel_status",
    {
      description: STATUS_DESCRIPTION,
      inputSchema: {
        action: z
          .enum(["status", "list", "cancel"])
          .optional()
          .describe("Action: status of a sentinel, list active tasks, or cancel a task"),
        id: z.string().optional().describe("Sentinel ID (required for status and cancel)"),
      },
    },
    async (args) => {
      const text = handleStatus(args.action, args.id);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "mcp_sentinel_attach",
    {
      description: ATTACH_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("The sentinel ID to wait for"),
        timeout: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Maximum wait time in milliseconds (0 or unset = no limit)"),
      },
    },
    async (args, extra) => {
      const text = await handleAttach(args.id, args.timeout, () => extra.signal.aborted);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "mcp_sentinel_read",
    {
      description: READ_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("The sentinel ID to read outputs from"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start index (default: from end, giving the last N polls)"),
        limit: z.number().int().min(1).optional().describe("Max number of outputs (default: 5)"),
      },
    },
    async (args) => {
      const text = handleRead(args.id, args.offset, args.limit);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  async function shutdown(): Promise<void> {
    cleanup();
    await disconnectAll();
    try {
      await server.close();
    } catch {
      // ignore close errors during shutdown
    }
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await server.connect(new StdioServerTransport());
  logInfo("MCP sentinel server started (stdio)");
}
