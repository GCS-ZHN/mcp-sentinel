import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpLocalConfig, McpRemoteConfig } from "./types.js";

interface ConnectionEntry {
  client: Client;
  connectedAt: number;
  lastUsedAt: number;
}

const connections = new Map<string, ConnectionEntry>();

function serverKey(name: string, config: McpServerConfig): string {
  if (config.type === "remote") return `${name}@remote:${(config as McpRemoteConfig).url}`;
  const localConfig = config as McpLocalConfig;
  return `${name}@local:${localConfig.command.join(" ")}`;
}

async function createTransport(config: McpServerConfig) {
  if (config.type === "remote") {
    const remoteConfig = config as McpRemoteConfig;
    const transport = new StreamableHTTPClientTransport(new URL(remoteConfig.url), {
      requestInit: remoteConfig.headers ? { headers: remoteConfig.headers } : undefined,
    });
    return transport;
  }

  const localConfig = config as McpLocalConfig;
  const [command, ...args] = localConfig.command;
  if (!command) {
    throw new Error("Local MCP server config missing command");
  }
  const transport = new StdioClientTransport({
    command,
    args,
    env: localConfig.env,
  });
  return transport;
}

export async function getOrCreateClient(name: string, config: McpServerConfig): Promise<Client> {
  const key = serverKey(name, config);
  const existing = connections.get(key);
  const now = Date.now();

  if (existing) {
    existing.lastUsedAt = now;
    return existing.client;
  }

  const client = new Client(
    { name: "opencode-mcp-sentinel", version: "0.1.0" },
    { capabilities: {} }
  );

  const transport = await createTransport(config);
  await client.connect(transport);

  connections.set(key, { client, connectedAt: now, lastUsedAt: now });
  return client;
}

export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({ name: toolName, arguments: args });

  if (result.isError) {
    throw new Error(`MCP tool call error: ${JSON.stringify(result.content)}`);
  }

  const content = result.content as Array<{ type: string; text?: string }>;
  const textParts = content
    .filter(
      (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string"
    )
    .map((c) => c.text);

  if (textParts.length === 0) {
    return content;
  }

  const combined = textParts.join("");
  try {
    return JSON.parse(combined);
  } catch {
    if (textParts.length === 1) return textParts[0];
    return combined;
  }
}

export async function disconnectAll(): Promise<void> {
  for (const [, entry] of connections) {
    try {
      await entry.client.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
  connections.clear();
}

export function getConnectionCount(): number {
  return connections.size;
}
