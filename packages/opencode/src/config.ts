/**
 * OpenCode harness — MCP config discovery.
 *
 * OpenCode stores MCP servers as flat keys under `mcp`:
 *
 * ```jsonc
 * { "mcp": { "servername": { "type": "local", "command": [...], "enabled": true } } }
 * ```
 *
 * This module normalizes that shape into the core's {@link McpServerConfig}
 * and exposes a {@link ServerResolver} for the core engine. Other harnesses
 * read their own config source (e.g. Codex `config.toml` + `.mcp.json`) and
 * provide their own resolver.
 *
 * @module
 */

import type {
  McpServerConfig,
  McpLocalConfig,
  McpRemoteConfig,
  McpConfig,
} from "@gcszhn/mcp-sentinel-core";

/**
 * Parse the raw OpenCode config (`client.config.get().data`) into a typed
 * {@link McpConfig}.
 *
 * Supported server types:
 * - `"local"` / `"stdio"` — spawns a subprocess via `command` and `args`
 * - `"remote"` / `"http"` — connects via Streamable HTTP at `url`
 * - No explicit type — inferred from `command` (local) or `url` (remote)
 *
 * @param raw - The raw config object. Safe to pass `{}`, `null`, or arbitrary
 *              shapes — invalid structures produce an empty servers map.
 * @returns A typed config with a `servers` map keyed by server name.
 */
export function parseOpencodeMcpConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== "object") {
    return { servers: {} };
  }

  const config = raw as Record<string, unknown>;
  // Null-prototype map so a server literally named `__proto__` (an own key from
  // JSON.parse of a config file) cannot mutate the object's prototype.
  const servers: Record<string, McpServerConfig> = Object.create(null);

  if (config.mcp && typeof config.mcp === "object") {
    for (const [name, serverConfig] of Object.entries(config.mcp)) {
      if (!serverConfig || typeof serverConfig !== "object") continue;
      const parsed = parseServerEntry(serverConfig as Record<string, unknown>);
      if (parsed) {
        servers[name] = parsed;
      }
    }
  }

  return { servers };
}

/**
 * Normalize a single MCP server entry into an {@link McpServerConfig},
 * inferring the transport type from `command`/`url` when `type` is absent.
 */
function parseServerEntry(sc: Record<string, unknown>): McpServerConfig | null {
  const serverType = typeof sc.type === "string" ? sc.type : "";

  if (serverType === "local" || serverType === "stdio") {
    const command = normalizeCommand(sc);
    if (!command) return null;
    return {
      type: "local",
      command,
      cwd: typeof sc.cwd === "string" ? sc.cwd : undefined,
      env: sc.env as Record<string, string> | undefined,
      enabled: sc.enabled !== false,
    } as McpLocalConfig;
  }

  if (serverType === "remote" || serverType === "http") {
    return {
      type: "remote",
      url: String(sc.url ?? ""),
      headers: sc.headers as Record<string, string> | undefined,
      enabled: sc.enabled !== false,
    } as McpRemoteConfig;
  }

  // No explicit type — infer from presence of `command` (local) or `url` (remote).
  if (sc.command !== undefined) {
    const command = normalizeCommand(sc);
    if (!command) return null;
    return {
      type: "local",
      command,
      cwd: typeof sc.cwd === "string" ? sc.cwd : undefined,
      env: sc.env as Record<string, string> | undefined,
      enabled: sc.enabled !== false,
    } as McpLocalConfig;
  }

  if (sc.url !== undefined) {
    return {
      type: "remote",
      url: String(sc.url),
      headers: sc.headers as Record<string, string> | undefined,
      enabled: sc.enabled !== false,
    } as McpRemoteConfig;
  }

  return null;
}

/**
 * Normalize a `command`/`args` pair into a single argv array.
 *
 * Accepts either `command: ["node", "x.js"]` (array) or
 * `command: "node"` + `args: ["x.js"]` (string + array).
 */
function normalizeCommand(sc: Record<string, unknown>): string[] | null {
  if (Array.isArray(sc.command)) {
    return sc.command.map(String);
  }
  if (typeof sc.command === "string") {
    const command = [sc.command];
    if (Array.isArray(sc.args)) {
      command.push(...sc.args.map(String));
    }
    return command;
  }
  return null;
}
