/**
 * Shared type definitions for the harness-agnostic sentinel core.
 *
 * ## Condition types
 * Conditions form a recursive algebraic data type used by
 * {@link evaluateCondition} to test poll results.
 * Paths use dot notation with optional array indices
 * (e.g. `"tasks[0].exit_code"`).
 *
 * ## MCP server config
 * {@link McpServerConfig} is a discriminated union on `type`. Each host
 * normalizes its own config source (OpenCode's flat `mcp.{name}.*` keys, a
 * Codex `.mcp.json`, …) into this uniform shape.
 *
 * @module
 */

/**
 * Comparison operator for leaf conditions.
 *
 * | Operator    | Description                          |
 * | ----------- | ------------------------------------ |
 * | `eq`        | strict equality (`===`)              |
 * | `ne`        | strict inequality (`!==`)            |
 * | `gt`        | greater than (numeric coercion)      |
 * | `gte`       | greater than or equal                |
 * | `lt`        | less than                            |
 * | `lte`       | less than or equal                   |
 * | `contains`  | string inclusion (both must be str)  |
 * | `match`     | regex test via `new RegExp(expected)`|
 */
export type ComparisonOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "match";

/**
 * Leaf condition: resolve a JSON path from the poll result and compare the
 * resolved value against an expected value using the specified operator.
 *
 * @example
 * ```ts
 * // data.status === "completed"
 * { path: "status", is: "eq", value: "completed" }
 * // data.tasks[0].exit_code !== 0
 * { path: "tasks[0].exit_code", is: "ne", value: 0 }
 * ```
 */
export interface SimpleCondition {
  /**
   * Dot-path into the poll result JSON (e.g. `"status"`, `"items[0].name"`).
   *
   * Omit (or leave empty) to compare against the raw poll result itself —
   * no JSON-path resolution is performed. This supports MCP tools that return
   * non-JSON payloads (plain text, numbers, booleans, …).
   */
  path?: string;
  /** Comparison operator. */
  is: ComparisonOp;
  /** Expected value to compare against. */
  value: unknown;
}

/** Negates a nested {@link SentinelCondition}. */
export interface NotCondition {
  not: SentinelCondition;
}

/** All nested conditions in the array must be satisfied (logical AND). */
export interface AndCondition {
  and: SentinelCondition[];
}

/** At least one nested condition must be satisfied (logical OR). */
export interface OrCondition {
  or: SentinelCondition[];
}

/** Recursive condition type — a leaf, a negation, or a compound. */
export type SentinelCondition = SimpleCondition | NotCondition | AndCondition | OrCondition;

/**
 * Describes a polling task submitted by the agent via `mcp_sentinel_poll`.
 */
export interface SentinelRequest {
  /** MCP server name, resolved by the host's {@link ServerResolver}. */
  server: string;
  /** Tool name to invoke on each poll. */
  tool: string;
  /** Arguments passed to the MCP tool on each call. */
  args: Record<string, unknown>;
  /** Poll interval in milliseconds (clamped to min 1000, default 5000). */
  interval?: number;
  /** Maximum poll duration in ms. `0` or `undefined` means no limit. */
  timeout?: number;
  /** Termination condition evaluated on each poll result. */
  until: SentinelCondition;
  /**
   * Agent session ID for delivering the completion notification. Populated by
   * the host adapter (e.g. OpenCode's `ctx.sessionID`); omitted by adapters
   * that have no push-notification channel.
   */
  sessionID?: string;
}

/**
 * Runtime state of a single sentinel polling task.
 *
 * Created by {@link startSentinel}; transitions through
 * `polling → completed|cancelled|timeout|error`.
 */
export interface SentinelTask {
  /** Unique ID generated at creation time. */
  id: string;
  /** Original request parameters. */
  request: SentinelRequest;
  /** Unix-epoch timestamp of task creation. */
  createdAt: number;
  /** Total number of polls executed so far. */
  pollCount: number;
  /** Raw result from the most recent poll (before or after condition met). */
  lastResult: unknown;
  /**
   * Sliding window of poll snapshots. Capped by `SENTINEL_MAX_POLL_LOG`
   * (FIFO: oldest entries are dropped when the limit is exceeded).
   */
  pollLog: Array<{ index: number; time: number; result: unknown }>;
  /** Current task status. */
  status: "polling" | "completed" | "cancelled" | "timeout" | "error";
  /** Description of the error when status is `"error"`. */
  error?: string;
  /** When the task transitioned out of `"polling"`, if it has. */
  resolvedAt?: number;
}

/**
 * Configuration for a local (stdio) MCP server spawned as a subprocess.
 *
 * @see {@link StdioClientTransport}
 */
export interface McpLocalConfig {
  type: "local";
  /** Executable and arguments for the subprocess. */
  command: string[];
  /** Working directory for the spawned subprocess. */
  cwd?: string;
  /** Additional environment variables to pass to the subprocess. */
  env?: Record<string, string>;
  /** When `false`, the server is excluded from lookups. */
  enabled?: boolean;
}

/**
 * Configuration for a remote MCP server over Streamable HTTP.
 *
 * @see {@link StreamableHTTPClientTransport}
 */
export interface McpRemoteConfig {
  type: "remote";
  /** Full URL of the MCP endpoint (e.g. `http://example.com/mcp`). */
  url: string;
  /** Optional custom HTTP headers for requests. */
  headers?: Record<string, string>;
  /** When `false`, the server is excluded from lookups. */
  enabled?: boolean;
}

/** Discriminated union of local and remote MCP server configs. */
export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

/** A name → server-config map. Built by the harness from its own config source. */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/**
 * Resolve a target MCP server by name, or `null` when unknown/disabled.
 *
 * This is the uniform seam between the harness-agnostic core and each harness:
 * the core asks for a server by name and the harness answers from its own
 * config source (OpenCode `client.config.get()`, Codex `config.toml` +
 * `.mcp.json`, …).
 */
export type ServerResolver = (name: string) => McpServerConfig | null;

/**
 * Invoke an MCP tool and return its parsed result.
 *
 * This is the single seam the engine uses to talk to MCP. Two harness
 * strategies produce it:
 *
 * 1. **Connection-pool mode** — the harness registers MCP server configs with
 *    the core and lets the core own the connection lifecycle. Build it with
 *    {@link makeConnectionInvoker} from a {@link ServerResolver}.
 * 2. **External-invoker mode** — the harness already owns MCP (e.g. its own
 *    MCP bridge registered tools on a tool registry); the harness passes its
 *    own `(server, tool, args) => result` function and the core never opens a
 *    connection.
 *
 * The returned value must already be the canonical result the condition
 * evaluator inspects: a parsed JSON object, or a raw non-JSON value for tools
 * that return plain text/numbers.
 */
export type ToolInvoker = (
  server: string,
  tool: string,
  args: Record<string, unknown>
) => Promise<unknown>;
