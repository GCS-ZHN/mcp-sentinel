/**
 * MCP client connection pool with lazy reconnection.
 *
 * ## Caching
 * Maintains a singleton cache of `@modelcontextprotocol/sdk` `Client`
 * instances keyed by server identity (`name@remote:url` or
 * `name@local:cmd arg...`).
 *
 * ## Reconnection
 * When {@link callTool} encounters a connection-level error — Streamable HTTP
 * session expiry (404), server fault (5xx), or network errors (ECONNREFUSED,
 * ECONNRESET, ETIMEDOUT, fetch failed) — the dead client is evicted from the
 * cache, a fresh connection is established via {@link getOrCreateClient}, and
 * the failed tool call is retried exactly once.
 *
 * Per the [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#session-management):
 * > When a client receives HTTP 404 in response to a request containing an
 * > `Mcp-Session-Id`, it **MUST** start a new session by sending a new
 * > `InitializeRequest` without a session ID attached.
 *
 * The `@modelcontextprotocol/sdk`'s {@link StreamableHTTPClientTransport}
 * throws a {@link StreamableHTTPError} on 404 but does **not** automatically
 * re-initialize — that obligation is fulfilled by this module.
 *
 * @module
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpLocalConfig, McpRemoteConfig } from "./types.js";
import { logDebug } from "./logger.js";
import pkg from "../package.json" with { type: "json" };

/** MCP client info derived from `package.json` at build time. */
const CLIENT_INFO = {
  name: pkg.name ?? "mcp-sentinel-core",
  version: pkg.version ?? "0.0.0",
};

/**
 * Cache entry for a connected MCP client.
 *
 * Stores the `client` instance, creation/usage timestamps, and enough
 * metadata (`serverName` + `serverConfig`) to rebuild the connection
 * when the session expires or the transport dies.
 */
interface ConnectionEntry {
  /** The connected MCP client instance. */
  client: Client;
  /** Unix-epoch timestamp when this connection was established. */
  connectedAt: number;
  /** Unix-epoch timestamp of the most recent cache hit or usage. */
  lastUsedAt: number;
  /** Server name from the host's MCP config (for reconnection). */
  serverName: string;
  /** Server config from the host's MCP config (for reconnection). */
  serverConfig: McpServerConfig;
}

/**
 * Connection cache keyed by `name@remote:url` or `name@local:cmd args...`.
 * Each entry holds a connected {@link Client} instance.
 */
const connections = new Map<string, ConnectionEntry>();

/**
 * Per-client reconnection metadata stored via a {@link WeakMap}.
 *
 * When concurrent polls share the same cached client and both encounter a
 * connection error, the first poll evicts the entry from `connections`.
 * The second poll — which no longer finds an entry — falls back to this
 * WeakMap to obtain the `serverName`/`serverConfig` needed for reconnect.
 *
 * Using a WeakMap ensures the metadata is garbage-collected when the
 * `Client` itself is no longer referenced.
 */
const clientMeta = new WeakMap<Client, { serverName: string; serverConfig: McpServerConfig }>();

/**
 * In-flight connection promises keyed by cache key.
 *
 * When multiple callers (e.g. concurrent sentinel polls against the same
 * server) invoke {@link getOrCreateClient} simultaneously after a cache
 * eviction, only the first caller creates the connection. Others await
 * the same promise, preventing orphaned duplicate connections.
 */
const pendingConnections = new Map<string, Promise<Client>>();

/**
 * Generate a deterministic cache key from a server name and config.
 *
 * For remote servers: `"name@remote:http://host/mcp"`
 * For local servers:  `"name@local:bun server.ts --port 0"`
 */
function serverKey(name: string, config: McpServerConfig): string {
  if (config.type === "remote") return `${name}@remote:${(config as McpRemoteConfig).url}`;
  const localConfig = config as McpLocalConfig;
  return `${name}@local:${localConfig.command.join(" ")}`;
}

/**
 * Build the appropriate transport (stdio or Streamable HTTP) from the
 * server configuration.
 *
 * @param config - The server configuration.
 * @returns A transport ready to be connected via `client.connect()`.
 * @throws {Error} If a local config is missing a `command`.
 */
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
    cwd: localConfig.cwd,
  });
  return transport;
}

/**
 * Retrieve (from cache) or lazily create an MCP client for the given
 * `(name, config)` pair.
 *
 * The returned client may be cached. If the underlying connection later
 * fails with a recoverable error, {@link callTool} will evict it from the
 * cache and call this function again to rebuild.
 *
 * @param name - MCP server name (from the host's MCP config).
 * @param config - Parsed server configuration.
 * @returns A connected MCP client instance.
 */
export async function getOrCreateClient(name: string, config: McpServerConfig): Promise<Client> {
  const key = serverKey(name, config);
  const existing = connections.get(key);
  const now = Date.now();

  if (existing) {
    existing.lastUsedAt = now;
    return existing.client;
  }

  // Deduplicate concurrent connection attempts for the same server key.
  // If two sentinels race to reconnect after cache eviction, only one
  // creates the transport — the other awaits the same promise.
  const pending = pendingConnections.get(key);
  if (pending) return pending;

  const promise = doConnect(name, config, key, now);
  pendingConnections.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingConnections.delete(key);
  }
}

async function doConnect(
  name: string,
  config: McpServerConfig,
  key: string,
  now: number
): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const transport = await createTransport(config);
  await client.connect(transport);

  clientMeta.set(client, { serverName: name, serverConfig: config });

  connections.set(key, {
    client,
    serverName: name,
    serverConfig: config,
    connectedAt: now,
    lastUsedAt: now,
  });
  return client;
}

/**
 * Classify whether an error from the MCP SDK indicates a recoverable
 * connection-level failure that warrants reconnection and retry.
 *
 * **Detected signals:**
 * - HTTP `404` — MCP spec: session terminated, MUST re-initialize
 * - HTTP `5xx` — server fault, may be transient
 * - `"Session not found"` in message — proxy/gateway rewriting of 404
 * - `"Not connected"` — stdio transport process died
 * - `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT` — network-level errors
 * - `"fetch failed"` — Bun's generic network error
 *
 * **Not detected** (returns `false`):
 * - `null` / `undefined`
 * - HTTP `403`, `401` (auth errors — not recoverable)
 * - Tool-level errors (e.g. `"Tool not found"`)
 *
 * @param err - The caught error (from SDK's `client.callTool`).
 * @returns `true` if the error likely indicates a dead or unavailable
 *          connection that can be fixed by reconnecting.
 */
export function isConnectionError(err: unknown): boolean {
  if (err == null) return false;

  const code = (err as { code?: number }).code;
  if (code === 404) return true;
  if (code !== undefined && code >= 500 && code < 600) return true;

  const message = String((err as { message?: string }).message ?? err ?? "");
  if (message.includes("Session not found")) return true;
  if (message.includes("Not connected")) return true;
  if (message.includes("Connection closed")) return true;
  if (message.includes("ECONNREFUSED")) return true;
  if (message.includes("ECONNRESET")) return true;
  if (message.includes("ETIMEDOUT")) return true;
  if (message.includes("fetch failed")) return true;

  return false;
}

/**
 * Walk the connection cache and remove the entry whose `client` reference
 * matches the given (dead) client.
 *
 * @param client - The dead client to evict.
 * @returns The evicted entry's metadata (`serverName`, `serverConfig`),
 *          or `undefined` if the client was not found in the cache.
 */
function evictCachedClient(client: Client): ConnectionEntry | undefined {
  for (const [key, entry] of connections) {
    if (entry.client === client) {
      connections.delete(key);
      return entry;
    }
  }
  return undefined;
}

/**
 * Call an MCP tool through the given client.
 *
 * If the call throws a connection-level error (as classified by
 * {@link isConnectionError}), the dead client is evicted from the cache,
 * a fresh connection is established via {@link getOrCreateClient}, and the
 * call is retried exactly once.
 *
 * Non-connection errors (auth failures, tool-not-found, etc.) are re-thrown
 * immediately without retry.
 *
 * @param client - An MCP client (may be cached; may be dead).
 * @param toolName - Name of the MCP tool to invoke.
 * @param args - Arguments for the tool call.
 * @returns The parsed tool result: a JSON object, a string (single text
 *          part), or the raw content array (non-text parts).
 * @throws {Error} If the call fails and cannot be recovered.
 *
 * @example
 * ```ts
 * const client = await getOrCreateClient("my-server", remoteConfig);
 * // After server restart:
 * const result = await callTool(client, "get_status", { job_id: "abc" });
 * // transparently evicted dead client, reconnected, retried, succeeded
 * ```
 */
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
      // dead transport — close may also throw, ignore
    }

    if (!entry) {
      const meta = clientMeta.get(client);
      if (meta) {
        logDebug(`Reconnecting (concurrent-eviction fallback)`, {
          server: meta.serverName,
        });
        const fresh = await getOrCreateClient(meta.serverName, meta.serverConfig);
        return await invokeTool(fresh, toolName, args);
      }
      throw err;
    }

    logDebug(`Reconnecting after connection error`, {
      server: entry.serverName,
    });
    const fresh = await getOrCreateClient(entry.serverName, entry.serverConfig);
    return await invokeTool(fresh, toolName, args);
  }
}

/**
 * Low-level tool invocation without retry logic.
 *
 * Calls `client.callTool`, checks for MCP-level errors (`result.isError`),
 * and parses the text content into a JSON object when possible.
 *
 * @param client - A connected MCP client.
 * @param toolName - Tool name.
 * @param args - Tool arguments.
 * @returns Parsed result (object, string, or content array).
 * @throws {Error} If the MCP server returns an error (`result.isError`).
 */
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

/**
 * Gracefully close all cached connections and clear the cache.
 *
 * Called during plugin shutdown (`SIGINT`/`SIGTERM`). Individual close
 * errors are silently ignored — we're shutting down anyway.
 */
export async function disconnectAll(): Promise<void> {
  for (const [, entry] of connections) {
    try {
      await entry.client.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
  connections.clear();
  pendingConnections.clear();
}

/**
 * @returns The number of currently cached connection entries.
 */
export function getConnectionCount(): number {
  return connections.size;
}
