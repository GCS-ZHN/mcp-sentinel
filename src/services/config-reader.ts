/**
 * Parse opencode's flat MCP server configuration into typed structures.
 *
 * opencode stores MCP servers as flat keys:
 * ```jsonc
 * { "mcp": { "servername": { "type": "local", "command": [...], "enabled": true } } }
 * ```
 *
 * This module normalizes that shape into {@link McpServerConfig}
 * discriminated by `type`, plus helper utilities for lookup.
 *
 * @module
 */

import type { McpServerConfig, McpLocalConfig, McpRemoteConfig, McpConfig } from "./types.js";

/**
 * Parse the raw opencode config (from `client.config.get().data`) into a
 * typed {@link McpConfig}.
 *
 * Supported server types:
 * - `"local"` / `"stdio"` — spawns a subprocess via `command` and `args`
 * - `"remote"` / `"http"` — connects via Streamable HTTP at `url`
 *
 * Servers with `enabled: false` are still included in the parsed result;
 * they are excluded at lookup time by {@link lookupServer}.
 *
 * @param raw - The raw config object from opencode. Safe to pass `{}`, `null`,
 *              or arbitrary shapes — invalid structures produce an empty
 *              servers map.
 * @returns A typed config with a `servers` map keyed by server name.
 *
 * @example
 * ```ts
 * parseMcpConfig({
 *   mcp: {
 *     "my-server": { type: "local", command: ["node", "server.js"] },
 *   }
 * })
 * // → { servers: { "my-server": { type: "local", command: ["node", "server.js"] } } }
 * ```
 */
export function parseMcpConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== "object") {
    return { servers: {} };
  }

  const config = raw as Record<string, unknown>;
  const servers: Record<string, McpServerConfig> = {};

  if (config.mcp && typeof config.mcp === "object") {
    const mcp = config.mcp as Record<string, unknown>;
    for (const [name, serverConfig] of Object.entries(mcp)) {
      if (!serverConfig || typeof serverConfig !== "object") continue;
      const sc = serverConfig as Record<string, unknown>;
      const serverType = typeof sc.type === "string" ? sc.type : "";

      if (serverType === "local" || serverType === "stdio") {
        let command: string[];
        if (Array.isArray(sc.command)) {
          command = sc.command.map(String);
        } else if (typeof sc.command === "string") {
          command = [sc.command];
          if (Array.isArray(sc.args)) {
            command.push(...sc.args.map(String));
          }
        } else {
          continue;
        }
        servers[name] = {
          type: "local",
          command,
          env: sc.env as Record<string, string> | undefined,
          enabled: sc.enabled !== false,
        } as McpLocalConfig;
      } else if (serverType === "remote" || serverType === "http") {
        servers[name] = {
          type: "remote",
          url: String(sc.url ?? ""),
          headers: sc.headers as Record<string, string> | undefined,
          enabled: sc.enabled !== false,
        } as McpRemoteConfig;
      }
    }
  }

  return { servers };
}

/**
 * Look up a server config by name.
 *
 * @param config - The parsed MCP config.
 * @param serverName - Server name as configured in the `mcp` block.
 * @returns The server config, or `null` if not found or explicitly disabled
 *          (`enabled: false`).
 */
export function lookupServer(config: McpConfig, serverName: string): McpServerConfig | null {
  const server = config.servers[serverName];
  if (!server) return null;
  if (server.enabled === false) return null;
  return server;
}
