# Error handling reference

The sentinel never hides failures. Every problem surfaces as a clear,
actionable tool output string or as the task's error status. This file is the
taxonomy plus the debugging flow; never guess error messages — the ones below
are the exact strings.

## Input validation errors (returned by the tool immediately)

| Input                                                 | Exact response                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Empty server or tool                                  | Error: server and tool must be non-empty strings.                                                        |
| until not a JSON object (string, number, array, null) | Error: until must be a JSON object describing a condition.                                               |
| args not a JSON object                                | The harness schema rejects it (args is not a JSON object); wording is the harness's own zod/schema error |
| commands not a non-empty string[] (notifier tool)     | Error: commands must be a non-empty array of command template strings.                                   |
| A template without exactly one {}                     | Error: commands[N] must contain exactly one "{}" placeholder (found M).                                  |

## MCP passthrough errors (the underlying server's own words)

These are returned VERBATIM — never wrapped or rewritten:

| Case                                 | Response                                               |
| ------------------------------------ | ------------------------------------------------------ |
| server not in the harness MCP config | Error: Unknown MCP server: <name>                      |
| tool missing on a live server        | Raw MCP error, e.g. -32602: Tool <name> not found      |
| Server rejects args                  | The server's raw error, field names and codes included |

## Condition resolution errors (task status = error)

These fire during polling when the until condition is misconfigured. Read the
raw poll log with mcp_sentinel_read to see the exact throw:

- Resolved value is an array or object (leaf-only rule).
- Path key does not exist ("key X does not exist").
- Array index out of range ("index X is out of range").
- Reading a property off null/undefined ("cannot read X of null/undefined").
- Reading a property off a primitive ("cannot read X of a string value").
- Unknown operator (not eq/ne/gt/gte/lt/lte/contains/match).

None of these silently poll forever — each becomes an error the agent sees.

## Other terminal states

| State                    | Meaning                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| timeout                  | Deadline (timeout ms) elapsed before the condition matched; lastResult holds the final poll |
| cancelled                | Cancelled via mcp_sentinel_status action=cancel                                             |
| Notifier command failure | Logged only; never changes the task state                                                   |

## Debugging workflow

1. mcp_sentinel_status { action: "status", id } — current state, poll count,
   lastResult, error (if any).
2. If error or timeout: mcp_sentinel_read { id, offset, limit } — raw poll
   outputs. Start from the end (default) to see recent responses, or offset=0
   for the first polls.
3. Compare the actual returned shape against your path — a typo'd key or a
   nested wrapper (e.g. data.status vs status) is the usual cause.
4. Fix the condition, re-validate with scripts/validate-condition.mjs, and
   resubmit the poll.

## Environment variable effects

- SENTINEL_TASK_TTL_MS: completed/cancelled tasks are removed after N ms; a
  task you expect to still exist may have been cleaned up.
- SENTINEL_MAX_POLL_LOG: poll log is FIFO-trimmed; old entries beyond the cap
  are gone from mcp_sentinel_read.

## Codex-harness discovery gotcha

In the Codex harness (mcp-sentinel mcp --harness codex), the sentinel
discovers the servers it can poll by running "codex mcp list --json" in its
own process environment. If poll returns "Error: Unknown MCP server: X" while
the server's tools ARE visible to your session, the sentinel process cannot
see the same MCP config you can — typically a different CODEX_HOME or config
path. Do not guess server names; either align the environment the MCP server
process runs with (e.g. set CODEX_HOME on the server entry), or register the
sentinel with "mcp-sentinel mcp --harness custom --mcp-config <file>" so
discovery is deterministic from a file you control.
