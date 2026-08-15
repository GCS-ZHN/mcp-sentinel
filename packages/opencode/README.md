# mcp-sentinel-opencode-plugin

An [OpenCode](https://opencode.ai) plugin that acts as a **sentinel** between
the AI agent and MCP servers — polling long-running tasks on the agent's behalf
so that token-costly status loops never enter the LLM inference path.

This package is the OpenCode harness adapter for `mcp-sentinel-core`.

## Install

```bash
opencode plugin -g mcp-sentinel-opencode-plugin
```

Or add it to your `opencode.jsonc` (project `.opencode/opencode.jsonc` or
global `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugin": ["mcp-sentinel-opencode-plugin"],
}
```

The plugin reads your existing MCP server config — no additional setup needed.

## Tools

### `mcp_sentinel_poll`

Submit a long-running MCP tool call and poll it at regular intervals until a
condition is met. Returns a sentinel ID immediately; the agent is notified via
`promptAsync` when done.

| Parameter  | Type   | Default    | Description                                |
| ---------- | ------ | ---------- | ------------------------------------------ |
| `server`   | string | _required_ | MCP server name (from opencode config)     |
| `tool`     | string | _required_ | Tool name to call on the server            |
| `args`     | string | `"{}"`     | JSON string of arguments for the tool      |
| `interval` | number | `5000`     | Poll interval in milliseconds              |
| `timeout`  | number | _optional_ | Max poll duration in ms (unset = no limit) |
| `until`    | string | _required_ | JSON condition object                      |

### `mcp_sentinel_status`

Check status, list active tasks, or cancel a running task (`action` =
`status` | `list` | `cancel`).

### `mcp_sentinel_attach`

Block the agent, waiting for a sentinel to complete. Zero token cost during
the wait.

### `mcp_sentinel_read`

Read raw poll outputs with offset/limit pagination.

## Condition model

Conditions are pure declarative data:

```jsonc
{ "path": "status", "is": "eq", "value": "completed" }
{ "and": [
  { "path": "status", "is": "eq", "value": "completed" },
  { "path": "tasks[0].exit_code", "is": "eq", "value": 0 }
] }
```

See the repository root `README.md` for the full operator and path syntax.

## Environment variables

| Variable                | Default   | Description                               |
| ----------------------- | --------- | ----------------------------------------- |
| `SENTINEL_MAX_POLL_LOG` | unlimited | Max poll log entries per task (FIFO trim) |
| `SENTINEL_TASK_TTL_MS`  | unlimited | Auto-cleanup completed tasks after N ms   |

## License

MIT
