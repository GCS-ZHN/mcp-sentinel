import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpLocalConfig, McpRemoteConfig } from "./types.js";
import pkg from "../../package.json" with { type: "json" };

const CLIENT_INFO = {
  name: pkg.name ?? "opencode-mcp-sentinel",
  version: pkg.version ?? "0.0.0",
};

interface ConnectionEntry {
  client: Client;
  connectedAt: number;
  lastUsedAt: number;
  serverName: string;
  serverConfig: McpServerConfig;
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

  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const transport = await createTransport(config);
  await client.connect(transport);

  connections.set(key, {
    client,
    serverName: name,
    serverConfig: config,
    connectedAt: now,
    lastUsedAt: now,
  });
  return client;
}

export function isConnectionError(err: unknown): boolean {
  if (err == null) return false;

  const code = (err as { code?: number }).code;
  if (code === 404) return true;
  if (code !== undefined && code >= 500 && code < 600) return true;

  const message = String((err as { message?: string }).message ?? err ?? "");
  if (message.includes("Session not found")) return true;
  if (message.includes("Not connected")) return true;
  if (message.includes("ECONNREFUSED")) return true;
  if (message.includes("ECONNRESET")) return true;
  if (message.includes("ETIMEDOUT")) return true;
  if (message.includes("fetch failed")) return true;

  return false;
}

function evictCachedClient(client: Client): ConnectionEntry | undefined {
  for (const [key, entry] of connections) {
    if (entry.client === client) {
      connections.delete(key);
      return entry;
    }
  }
  return undefined;
}

export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  try {
    return await invokeTool(client, toolName, args);
  } catch (err) {
    if (!isConnectionError(err)) throw err;

    const entry = evictCachedClient(client);
    try {
      await client.close();
    } catch {
      // dead transport — close may also throw
    }

    if (!entry) throw err;

    const fresh = await getOrCreateClient(entry.serverName, entry.serverConfig);
    return await invokeTool(fresh, toolName, args);
  }
}

async function invokeTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({ name: toolName, arguments: args });

  if (result.isError) {
    const errorContent = result.content as Array<{ type: string; text?: string }>;
    const texts = errorContent
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!);
    const message = texts.length > 0 ? texts.join("\n") : JSON.stringify(result.content);
    throw new Error(`MCP tool call error: ${message}`);
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
