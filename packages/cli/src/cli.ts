#!/usr/bin/env bun
/**
 * `mcp-sentinel` CLI entry point.
 *
 * Starts the sentinel as a stdio MCP server. The MCP servers it can poll are
 * discovered from the selected harness, so the sentinel is usable in any
 * harness (Codex, OpenCode, DeepSeek Harness, …) with no per-harness config:
 *
 * ```bash
 * mcp-sentinel mcp --harness codex
 * mcp-sentinel mcp --harness opencode
 * mcp-sentinel mcp --harness custom --mcp-config ./mcp.json
 * ```
 *
 * @module
 */

import { discoverMcpConfig } from "./config.js";
import { startMcpServer } from "./mcp-server.js";

const USAGE = `Usage: mcp-sentinel mcp --harness <codex|opencode|custom|none> [--mcp-config <file>]

Start the sentinel as a stdio MCP server. The MCP servers it can poll are
discovered from the selected harness:

  --harness codex      codex mcp list --json
  --harness opencode   opencode debug config (JSON "mcp" object)
  --harness custom     a JSON file passed via --mcp-config
  --harness none       no discovery (empty config)

Examples:
  mcp-sentinel mcp --harness codex
  mcp-sentinel mcp --harness opencode
  mcp-sentinel mcp --harness custom --mcp-config ./mcp.json
`;

const VALID_HARNESSES = new Set(["codex", "opencode", "custom", "none"]);

const args = process.argv.slice(2);
const subcommand = args[0];
const wantsHelp = args.includes("--help") || args.includes("-h");

if (subcommand !== "mcp") {
  process.stderr.write(USAGE);
  process.exit(1);
}
if (wantsHelp) {
  process.stdout.write(USAGE);
  process.exit(0);
}

let harness: string | undefined;
let mcpConfigPath: string | undefined;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--harness") {
    harness = args[++i];
    if (!harness) {
      process.stderr.write(USAGE);
      process.exit(1);
    }
  } else if (a === "--mcp-config") {
    mcpConfigPath = args[++i];
    if (!mcpConfigPath) {
      process.stderr.write(USAGE);
      process.exit(1);
    }
  } else {
    process.stderr.write(`Error: unknown argument "${a}".\n\n${USAGE}`);
    process.exit(1);
  }
}

const resolvedHarness = harness ?? (mcpConfigPath ? "custom" : "none");
if (!VALID_HARNESSES.has(resolvedHarness)) {
  process.stderr.write(`Error: unknown harness "${resolvedHarness}".\n\n${USAGE}`);
  process.exit(1);
}
if (resolvedHarness === "custom" && !mcpConfigPath) {
  process.stderr.write("Error: --harness custom requires --mcp-config <file>.\n\n" + USAGE);
  process.exit(1);
}

const mcpConfig = discoverMcpConfig({ harness: resolvedHarness, mcpConfigPath });
await startMcpServer(mcpConfig);
