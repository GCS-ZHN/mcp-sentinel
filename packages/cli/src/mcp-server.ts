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
  ACTION_DESCRIPTION,
  ARGS_DESCRIPTION,
  ATTACH_ID_DESCRIPTION,
  ATTACH_TIMEOUT_DESCRIPTION,
  ATTACH_TOOL_DESCRIPTION,
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
import type { McpConfig, SentinelCondition } from "@gcszhn/mcp-sentinel-core";
import pkg from "../package.json" with { type: "json" };

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
      description: POLL_TOOL_DESCRIPTION,
      inputSchema: {
        server: z.string().describe(SERVER_DESCRIPTION),
        tool: z.string().describe(TOOL_DESCRIPTION),
        args: z.json().optional().describe(ARGS_DESCRIPTION),
        interval: z.number().int().min(1000).optional().describe(INTERVAL_DESCRIPTION),
        timeout: z.number().int().min(0).optional().describe(POLL_TIMEOUT_DESCRIPTION),
        until: z.json().describe(UNTIL_DESCRIPTION),
      },
    },
    async (args) => {
      if (args.server.trim() && !resolveServer(args.server)) {
        return {
          content: [{ type: "text" as const, text: `Error: Unknown MCP server: ${args.server}` }],
        };
      }
      const text = await handlePoll(
        {
          server: args.server,
          tool: args.tool,
          args: (args.args ?? {}) as Record<string, unknown>,
          interval: args.interval,
          timeout: args.timeout,
          until: args.until as unknown as SentinelCondition,
        },
        invoke
      );
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "mcp_sentinel_status",
    {
      description: STATUS_TOOL_DESCRIPTION,
      inputSchema: {
        action: z.enum(["status", "list", "cancel"]).optional().describe(ACTION_DESCRIPTION),
        id: z.string().optional().describe(STATUS_ID_DESCRIPTION),
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
      description: ATTACH_TOOL_DESCRIPTION,
      inputSchema: {
        id: z.string().describe(ATTACH_ID_DESCRIPTION),
        timeout: z.number().int().min(0).optional().describe(ATTACH_TIMEOUT_DESCRIPTION),
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
      description: READ_TOOL_DESCRIPTION,
      inputSchema: {
        id: z.string().describe(READ_ID_DESCRIPTION),
        offset: z.number().int().min(0).optional().describe(READ_OFFSET_DESCRIPTION),
        limit: z.number().int().min(1).optional().describe(READ_LIMIT_DESCRIPTION),
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
