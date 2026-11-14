/**
 * OpenCode 2 (V2) harness — MCP config discovery and preflight checks.
 *
 * In V2 the host exposes MCP configuration through the `ctx.mcp` domain. The
 * plugin captures the current server list from a synchronous `transform`
 * callback (the only place V2 exposes `editor.list()`), then normalizes that
 * V2 shape into the core's {@link McpConfig} for connection-pool mode:
 *
 * ```jsonc
 * {
 *   "mcp": {
 *     "servers": {
 *       "name": {
 *         "type": "local",
 *         "command": ["bun", "run", "server.ts"],
 *         "environment": { "KEY": "value" },
 *         "disabled": false
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Differences from V1:
 * - servers live under `mcp.servers.{name}` (not flat `mcp.{name}`)
 * - `environment` replaces `env`
 * - `disabled` is the inverse of V1's `enabled`
 *
 * @module
 */

import type {
  McpConfig,
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
} from "@gcszhn/mcp-sentinel-core";

/**
 * Minimal structural view of a V2 `Mcp.ServerConfig`.
 *
 * Kept intentionally loose (and free of `@opencode/plugin`/`effect` types) so
 * this module is testable in isolation and stays tolerant of schema additions.
 */
export interface Opencode2McpServerConfig {
  readonly type?: string;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly environment?: unknown;
  readonly disabled?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
  readonly oauth?: unknown;
}

/** One `[name, config]` entry as returned by the V2 MCP editor. */
export type Opencode2McpEntry = readonly [string, Opencode2McpServerConfig];

/** MCP connection status as reported by `ctx.mcp.list()`. */
export interface Opencode2McpStatus {
  readonly status: string;
  readonly error?: string;
}

/**
 * Normalize the V2 MCP server list into the core's {@link McpConfig}.
 *
 * Invalid entries (missing/non-string `command`, empty `url`, …) are skipped,
 * matching the core's contract that only usable server configs reach the
 * resolver. Disabled servers are kept but marked `enabled: false`, so the
 * core's {@link makeServerResolver} excludes them consistently.
 *
 * @param entries - `[name, config]` entries captured from `ctx.mcp.transform`.
 * @returns A typed config with a null-prototype `servers` map.
 */
export function normalizeOpencode2McpConfig(
  entries: Iterable<Opencode2McpEntry> | null | undefined
): McpConfig {
  // Null-prototype map so a server literally named `__proto__` cannot mutate
  // the object's prototype.
  const servers: Record<string, McpServerConfig> = Object.create(null);
  if (!entries) return { servers };

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [name, raw] = entry;
    if (typeof name !== "string" || !isRecord(raw)) continue;

    const normalized = normalizeServerEntry(raw);
    if (normalized) servers[name] = normalized;
  }

  return { servers };
}

/**
 * Look up a raw V2 entry by server name.
 *
 * Iterates instead of indexing a map so names such as `__proto__` cannot read
 * inherited properties.
 */
export function findMcpEntry(
  entries: Iterable<Opencode2McpEntry> | null | undefined,
  name: string
): Opencode2McpEntry | undefined {
  if (!entries) return undefined;
  for (const entry of entries) {
    if (Array.isArray(entry) && entry.length >= 2 && entry[0] === name) return entry;
  }
  return undefined;
}

/** Whether a remote server declares OAuth authentication (`oauth` other than `false`). */
export function serverUsesOAuth(entry: Opencode2McpEntry | undefined): boolean {
  if (!entry) return false;
  const raw = entry[1];
  return raw.type === "remote" && raw.oauth !== undefined && raw.oauth !== false;
}

/** Whether a remote server has non-empty static headers the sentinel can reuse. */
export function serverHasHeaders(entry: Opencode2McpEntry | undefined): boolean {
  if (!entry) return false;
  const headers = entry[1].headers;
  return isRecord(headers) && Object.keys(headers).length > 0;
}

/**
 * Preflight a poll target and return a clean `"Error: ..."` string when the
 * server cannot be used, or `undefined` when it can.
 *
 * V2's MCP config is the source of truth for connection details, while the
 * host's connection status is the source of truth for authentication. The
 * sentinel opens its own MCP connection, so it cannot inherit host OAuth
 * credentials — a `needs_auth` server without static headers is reported
 * explicitly instead of failing later with an opaque 401.
 *
 * @param entries - Captured V2 MCP entries.
 * @param server - Requested server name.
 * @param status - Optional `ctx.mcp.list()` status for that server.
 */
export function describeServerProblem(
  entries: Iterable<Opencode2McpEntry> | null | undefined,
  server: string,
  status?: Opencode2McpStatus
): string | undefined {
  // Empty names are reported by the core handler with its canonical message.
  if (!server.trim()) return undefined;

  const entry = findMcpEntry(entries, server);
  if (!entry) return `Error: Unknown MCP server: ${server}`;

  const raw = entry[1];
  if (raw.disabled === true) {
    return `Error: MCP server "${server}" is disabled in OpenCode configuration.`;
  }

  const normalized = normalizeOpencode2McpConfig(entries);
  if (!Object.hasOwn(normalized.servers, server)) {
    return `Error: MCP server "${server}" has an unsupported configuration (expected a local command array or a remote url).`;
  }

  if (status?.status === "needs_auth" && !serverHasHeaders(entry)) {
    return `Error: MCP server "${server}" requires OAuth authentication. mcp-sentinel opens its own MCP connection and cannot reuse OpenCode's OAuth credentials; configure static headers for this server instead.${status.error ? ` (${status.error})` : ""}`;
  }

  return undefined;
}

/** Normalize one raw V2 server entry, or `null` when it is not usable. */
function normalizeServerEntry(raw: Opencode2McpServerConfig): McpServerConfig | null {
  const disabled = raw.disabled === true;

  if (raw.type === "local") {
    const command = normalizeCommand(raw.command);
    if (!command) return null;
    const local: McpLocalConfig = {
      type: "local",
      command,
      enabled: !disabled,
    };
    if (typeof raw.cwd === "string") local.cwd = raw.cwd;
    const env = normalizeStringMap(raw.environment);
    if (env) local.env = env;
    return local;
  }

  if (raw.type === "remote") {
    if (typeof raw.url !== "string" || raw.url.trim() === "") return null;
    const remote: McpRemoteConfig = {
      type: "remote",
      url: raw.url,
      enabled: !disabled,
    };
    const headers = normalizeStringMap(raw.headers);
    if (headers) remote.headers = headers;
    return remote;
  }

  return null;
}

/** Accept only a non-empty array of stringifiable command parts. */
function normalizeCommand(command: unknown): string[] | null {
  if (!Array.isArray(command) || command.length === 0) return null;
  if (!command.every((part) => typeof part === "string")) return null;
  return command.map((part) => part as string);
}

/** Normalize a `Record<string, string>`-shaped value, or `undefined` when absent. */
function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

/** Whether `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
