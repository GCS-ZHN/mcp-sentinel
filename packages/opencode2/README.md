# @gcszhn/mcp-sentinel-opencode2-plugin

An [OpenCode 2](https://opencode.ai) (**V2**) plugin that acts as a **sentinel**
between the AI agent and MCP servers — polling long-running tasks on the agent's
behalf so that token-costly status loops never enter the LLM inference path.

This package is the OpenCode 2 harness adapter for `@gcszhn/mcp-sentinel-core`.
It uses the V2 plugin API (`Plugin.define` / `ctx.tool.transform` /
`ctx.mcp.transform` / `ctx.session.synthetic`) and is independent from the V1
`@gcszhn/mcp-sentinel-opencode-plugin`.

## Install

Add the plugin to your OpenCode 2 config (`opencode.jsonc`):

```jsonc
{
  "plugins": ["@gcszhn/mcp-sentinel-opencode2-plugin"],
}
```

The plugin discovers the MCP servers already configured under `mcp.servers` in
your OpenCode config and opens its own connections to them. **No sentinel-specific
MCP configuration is required.**

Why its own connections: the V2 plugin SDK (`@opencode/plugin` 2.3.0) has no API
for invoking a host MCP tool. `ctx.mcp` only exposes `list` / `transform` /
`reload` (server config and status), and the host client's `mcp.*` API is
limited to `list`, `resource.catalog`, `add`, `remove`, `connect`, `disconnect`,
and `client.token`. `ctx.tool` can register and inspect plugin tools, and hooks
can observe agent tool calls, but nothing can execute a host MCP tool
programmatically. The adapter therefore runs in connection-pool mode: it reads
the server config from the host and lets the shared core own the MCP client.

Unlike V1, V2 config declares servers under `mcp.servers.{name}`:

```jsonc
{
  "mcp": {
    "servers": {
      "my-server": {
        "type": "local",
        "command": ["bun", "run", "./server.ts"],
      },
    },
  },
}
```

## Tools

### `mcp_sentinel_poll`

Submit a long-running MCP tool call and poll it at regular intervals until a
condition is met. Returns a sentinel ID immediately; the agent is notified in
its session when the sentinel resolves.

| Parameter  | Type   | Default    | Description                                |
| ---------- | ------ | ---------- | ------------------------------------------ |
| `server`   | string | _required_ | MCP server name (from `mcp.servers`)       |
| `tool`     | string | _required_ | Tool name to call on the server            |
| `args`     | object | `{}`       | JSON object of arguments for the tool      |
| `interval` | number | `5000`     | Poll interval in milliseconds              |
| `timeout`  | number | _optional_ | Max poll duration in ms (unset = no limit) |
| `until`    | object | _required_ | JSON condition object                      |

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

## Options

Options are read from the plugin entry in V2 config:

```jsonc
{
  "plugins": [
    {
      "package": "@gcszhn/mcp-sentinel-opencode2-plugin",
      "options": { "delivery": "queue", "resume": true },
    },
  ],
}
```

| Option     | Type      | Default   | Description                                                           |
| ---------- | --------- | --------- | --------------------------------------------------------------------- |
| `delivery` | `string`  | `"queue"` | How completion notices enter the session: `"queue"` or `"steer"`.     |
| `resume`   | `boolean` | `true`    | Whether a completion notice resumes a session that is currently idle. |

Notifications are delivered with `ctx.session.synthetic`, so they appear as a
background system notice rather than a user prompt.

## OAuth limitation

The sentinel opens its **own** MCP connection using the connection details in
`mcp.servers`, so it cannot reuse credentials that OpenCode obtained through an
interactive OAuth flow. If a remote server is reported as `needs_auth` and has
no static `headers`, `mcp_sentinel_poll` returns an explicit error explaining
that static headers must be configured instead of failing later with an opaque 401.

## Environment variables

| Variable                | Default   | Description                               |
| ----------------------- | --------- | ----------------------------------------- |
| `SENTINEL_MAX_POLL_LOG` | unlimited | Max poll log entries per task (FIFO trim) |
| `SENTINEL_TASK_TTL_MS`  | unlimited | Auto-cleanup completed tasks after N ms   |

## License

MIT
