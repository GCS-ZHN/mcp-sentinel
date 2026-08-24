/**
 * Shared tool and parameter descriptions for the sentinel's MCP tools.
 *
 * Every harness adapter (CLI, OpenCode, DeepSeek Harness) registers the same
 * four tools — `mcp_sentinel_poll`, `mcp_sentinel_status`,
 * `mcp_sentinel_attach`, `mcp_sentinel_read` — with identical parameter
 * semantics, so the descriptions live here as consts rather than being
 * copy-pasted into each adapter.
 *
 * @module
 */

/** Parameter descriptions (identical across all harness adapters). */
export const SERVER_DESCRIPTION = "Name of the MCP server to call";
export const TOOL_DESCRIPTION = "Name of the tool to call on the MCP server";
export const ARGS_DESCRIPTION = "Arguments for the tool (JSON object, default: {})";
export const INTERVAL_DESCRIPTION = "Poll interval in milliseconds (default: 5000)";
export const POLL_TIMEOUT_DESCRIPTION =
  "Maximum poll duration in milliseconds (0 or unset = no limit)";
export const UNTIL_DESCRIPTION =
  'Condition object to wait for, e.g. {"path":"status","is":"eq","value":"completed"}';
export const NOTIFIER_ID_DESCRIPTION =
  "Optional notifier_id (uuid) returned by mcp_sentinel_set_notifier_commands; the resolved sentinel runs that session's command list.";
export const ACTION_DESCRIPTION =
  "Action: status of a sentinel, list active tasks, or cancel a task";
export const STATUS_ID_DESCRIPTION = "Sentinel ID (required for status and cancel)";
export const ATTACH_ID_DESCRIPTION = "The sentinel ID to wait for";
export const ATTACH_TIMEOUT_DESCRIPTION =
  "Maximum wait time in milliseconds (0 or unset = no limit)";
export const READ_ID_DESCRIPTION = "The sentinel ID to read outputs from";
export const READ_OFFSET_DESCRIPTION =
  "0-based start index (default: from end, giving the last N polls)";
export const READ_LIMIT_DESCRIPTION = "Max number of outputs (default: 5)";

/** Note appended to the poll description by harnesses that push a completion notification via `setNotifier`. */
export const COMPLETION_NOTIFICATION_NOTE =
  "You will receive a notification when the sentinel finishes.";

/** The leaf-compare condition model shared by every poll tool. */
export const CONDITION_MODEL = `Condition model:
{ "path": "field", "is": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"match", "value": any }
{ "not": <condition> }
{ "and": [<condition>, ...] }
{ "or": [<condition>, ...] }

Path uses dot notation with optional array indices: "status", "tasks[0].exit_code"`;

/** Tool-level description for `mcp_sentinel_poll`. */
export const POLL_TOOL_DESCRIPTION = `Submit a long-running MCP tool call and poll it at regular intervals until a condition is met. The sentinel polls silently (zero token cost); collect the result with mcp_sentinel_status, mcp_sentinel_attach, or mcp_sentinel_read.

Parameters:
- server: ${SERVER_DESCRIPTION}
- tool: ${TOOL_DESCRIPTION}
- args: ${ARGS_DESCRIPTION}
- interval: ${INTERVAL_DESCRIPTION}
- timeout: ${POLL_TIMEOUT_DESCRIPTION}
- until: ${UNTIL_DESCRIPTION}
- notifier_id: ${NOTIFIER_ID_DESCRIPTION}

${CONDITION_MODEL}

Note: the "<mcp_server_name>-<mcp_tool_name>" form above is only an example. Each harness concatenates the server and tool names differently — some add prefixes or suffixes, and the separator between them varies. Infer the actual "server" and "tool" parameter values from the harness's real MCP tool names and surrounding context.`;

/** Tool-level description for `mcp_sentinel_status`. */
export const STATUS_TOOL_DESCRIPTION = `Check the status of sentinel tasks, list active tasks, or cancel a running task.

Actions:
- "status": Get details of a specific sentinel (requires id)
- "list": List all active sentinel tasks
- "cancel": Cancel a running sentinel (requires id)`;

/** Tool-level description for `mcp_sentinel_attach`. */
export const ATTACH_TOOL_DESCRIPTION = `Block the agent, waiting for a sentinel task to complete. Use this when you want to pause until the result is ready, instead of checking mcp_sentinel_status repeatedly.

The tool sleeps and checks the status internally (no token cost during wait).

Parameters:
- id: ${ATTACH_ID_DESCRIPTION}
- timeout: ${ATTACH_TIMEOUT_DESCRIPTION}`;

/** Tool-level description for `mcp_sentinel_read`. */
export const READ_TOOL_DESCRIPTION = `Read raw poll outputs from a sentinel task. Useful for debugging when a condition isn't matching — inspect actual MCP responses.

Works whether the sentinel is running, completed, cancelled, or errored.`;
