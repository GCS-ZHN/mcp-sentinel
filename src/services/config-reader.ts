import type { McpServerConfig, McpLocalConfig, McpRemoteConfig, McpConfig } from "./types.js";

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

export function lookupServer(config: McpConfig, serverName: string): McpServerConfig | null {
  const server = config.servers[serverName];
  if (!server) return null;
  if (server.enabled === false) return null;
  return server;
}
