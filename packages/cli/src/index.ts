/**
 * `@gcszhn/mcp-sentinel-cli` public API.
 *
 * Exports the pure, unit-testable pieces of the CLI — harness MCP config
 * discovery — plus the MCP server launcher. The CLI entry (`cli.ts`) is an
 * executable with side effects and is not re-exported here.
 *
 * @module
 */

export * from "./config.js";
export * from "./mcp-server.js";
export * from "./notifier-commands.js";
