/**
 * DeepSeek Harness adapter — MCP server config discovery.
 *
 * The sentinel core ships its own MCP client pool, so this adapter does not
 * bridge through the harness's `@deepseek-ai/dsh-mcp-client` service. Instead
 * it declares its own `servers` map (mirroring the mcp-client config shape:
 * `stdio` / `streamable-http`) and normalizes it into the core's
 * {@link McpConfig}. Users override the `servers` map in their profile's
 * `cordis.patch.yml`.
 *
 * @module
 */

import z from "@deepseek-ai/schemastery";
import type { McpConfig, McpServerConfig } from "@gcszhn/mcp-sentinel-core";

/** One MCP server reached over a spawned child process on stdio. */
export interface StdioServerConfig {
  transport: "stdio";
  /** Executable used to start the server. */
  command: string;
  /** Arguments passed directly, without shell interpolation. */
  args: string[];
  /** Extra env vars merged on top of the scrubbed ambient env. */
  env: Record<string, string>;
  /** Working directory for the child process. */
  cwd: string;
  /** When `false`, the server is excluded from sentinel lookups. */
  enabled: boolean;
}

/** One MCP server reached over Streamable HTTP. */
export interface StreamableHttpServerConfig {
  transport: "streamable-http";
  /** Full URL of the MCP endpoint. */
  url: string;
  /** Extra headers attached to MCP requests (e.g. auth tokens). */
  headers: Record<string, string>;
  /** When `false`, the server is excluded from sentinel lookups. */
  enabled: boolean;
}

/** A stdio or Streamable HTTP MCP server. */
export type ServerConfig = StdioServerConfig | StreamableHttpServerConfig;

/** Plugin configuration: a name → server map resolved from `cordis.yml`. */
export interface Config {
  servers: Record<string, ServerConfig>;
}

/**
 * Schemastery schema for {@link Config}. Defaults are declared on the schema
 * fields themselves, so an unset `servers` map resolves to `{}`.
 */
export const Config: z<Config> = z.object({
  servers: z
    .dict(
      z.union([
        z.object({
          transport: z.const("stdio"),
          command: z.string().required(),
          args: z.array(String).default([]),
          env: z.dict(String).default({}),
          cwd: z.string().default(""),
          enabled: z.boolean().default(true),
        }),
        z.object({
          transport: z.const("streamable-http"),
          url: z.string().required(),
          headers: z.dict(String).default({}),
          enabled: z.boolean().default(true),
        }),
      ])
    )
    .default({}),
}) as unknown as z<Config>;

/**
 * Normalize the resolved plugin config into the core's {@link McpConfig}.
 *
 * Maps the harness's `transport`-discriminated shape onto the core's
 * `type: "local" | "remote"` shape. Empty `cwd` / `env` / `headers` become
 * `undefined` so the core falls back to its own transport defaults.
 */
export function toMcpConfig(config: Config): McpConfig {
  const servers: Record<string, McpServerConfig> = {};

  // `config` may be undefined when the plugin is invoked directly (e.g. tests)
  // or when the host skips schema validation — normalize defensively.
  for (const [name, server] of Object.entries(config?.servers ?? {})) {
    if (!server) continue;

    if (server.transport === "stdio") {
      servers[name] = {
        type: "local",
        command: [server.command, ...server.args],
        cwd: server.cwd === "" ? undefined : server.cwd,
        env: Object.keys(server.env).length > 0 ? server.env : undefined,
        enabled: server.enabled,
      };
    } else {
      servers[name] = {
        type: "remote",
        url: server.url,
        headers: Object.keys(server.headers).length > 0 ? server.headers : undefined,
        enabled: server.enabled,
      };
    }
  }

  return { servers };
}
