import type { McpConfig, McpServerConfig, ServerResolver } from "./types.js";

/**
 * Build a {@link ServerResolver} from a parsed {@link McpConfig}.
 *
 * Encapsulates the `enabled: false` exclusion so the core engine only ever
 * sees usable server configs. Harnesses call this once with their parsed
 * config and hand the resulting resolver to the engine.
 */
export function makeServerResolver(mcpConfig: McpConfig): ServerResolver {
  return (name: string): McpServerConfig | null => {
    const server = mcpConfig.servers[name];
    if (!server || server.enabled === false) return null;
    return server;
  };
}
