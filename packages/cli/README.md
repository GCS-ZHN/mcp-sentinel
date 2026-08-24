# @gcszhn/mcp-sentinel-cli

A harness-agnostic **MCP stdio CLI** that acts as a sentinel between any AI
agent and MCP servers: it polls long-running MCP tool calls on the agent's
behalf so token-costly status loops never enter the LLM inference path.

This is the harness-neutral adapter for `@gcszhn/mcp-sentinel-core`. Register
it as an ordinary MCP server in whatever harness you use (Codex, OpenCode,
DeepSeek Harness, …) — it auto-discovers the MCP servers that harness already
exposes.

## Usage

```bash
mcp-sentinel mcp --harness <codex|opencode|custom|none> [--mcp-config <file>]
```

The `mcp` subcommand starts the sentinel as a stdio MCP server exposing the
four `mcp_sentinel_*` tools. The MCP servers it can poll are discovered from
the selected harness:

| Harness    | Source                                       |
| ---------- | -------------------------------------------- |
| `codex`    | `codex mcp list --json`                      |
| `opencode` | `opencode debug config` (JSON `mcp` object)  |
| `custom`   | a JSON file passed via `--mcp-config`        |
| `none`     | no discovery (empty config)                  |

The sentinel skips entries the harness has disabled (`enabled: false`, or
Codex's `disabled_reason`) and its own entry so it never polls a disabled
server or itself. Self-detection compares the entry's launch command against
the sentinel's own `process.argv` — never the server name — so a self entry
registered under any name is still skipped. No sentinel-specific MCP setup is
ever required.

### Custom config (`--harness custom`)

The custom config is a JSON file whose entries follow **OpenCode's MCP config
field names** (local servers use `command` (array) + `cwd` + `environment`;
remote servers use `url` + `headers`). The top-level `servers` map is required;
the Codex `.mcp.json` shape (`mcpServers`) and a bare `{ name: entry }` map are
also accepted.

A JSON Schema ships with the package at
[`schema/mcp-config.schema.json`](./schema/mcp-config.schema.json) (also
available on npm as
`node_modules/@gcszhn/mcp-sentinel-cli/schema/mcp-config.schema.json`). Point
your editor at it via `$schema` for validation and autocomplete:

```jsonc
// mcp.json
{
  "$schema": "./node_modules/@gcszhn/mcp-sentinel-cli/schema/mcp-config.schema.json",
  "servers": {
    "mock-ci": {
      "type": "local",
      "command": ["bun", "run", "mock-server.ts"],
      "cwd": "/tmp",
      "environment": { "KEY": "v" },
      "enabled": true
    },
    "remote": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "X-Api-Key": "..." }
    }
  }
}
```

```bash
mcp-sentinel mcp --harness custom --mcp-config ./mcp.json
```

`enabled: false` entries are skipped. Like every harness, the sentinel also
skips its own entry (matched by launch `command`, not by name).

## Install (Codex, one command)

```bash
scripts/install-codex-mcp.sh
```

Builds the package and registers `[mcp_servers.mcp-sentinel]` in
`~/.codex/config.toml` running `mcp-sentinel mcp --harness codex`. Start a new
Codex thread afterwards. For other harnesses, register
`mcp-sentinel mcp --harness <harness>` (or `--mcp-config`) as an MCP server in
that harness's config.

## Tools

### `mcp_sentinel_poll`

Submit a long-running MCP tool call and poll it at regular intervals until a
condition is met. Returns a sentinel ID immediately.

| Parameter  | Type   | Default    | Description                                |
| ---------- | ------ | ---------- | ------------------------------------------ |
| `server`   | string | _required_ | MCP server name (from the harness config)  |
| `tool`     | string | _required_ | Tool name to call on the server            |
| `args`     | object | `{}`       | Arguments for the tool                     |
| `interval` | number | `5000`     | Poll interval in milliseconds              |
| `timeout`  | number | _optional_ | Max poll duration in ms (unset = no limit) |
| `until`    | object | _required_ | Condition object                           |

### `mcp_sentinel_status`

Check status, list active tasks, or cancel a running task (`action` =
`status` | `list` | `cancel`).

### `mcp_sentinel_attach`

Block the agent, waiting for a sentinel to complete. Zero token cost during
the wait.

### `mcp_sentinel_read`

Read raw poll outputs with offset/limit pagination.

### `mcp_sentinel_set_notifier_commands`

Install a command-based notification handler. The CLI has no harness message
channel, so by default background sentinel completions are collected with
`mcp_sentinel_attach` / `status` / `read`. This tool registers a notifier
that, when a sentinel resolves, builds a notification message and runs each
command template in order to deliver it.

| Parameter | Type          | Default    | Description                         |
| --------- | ------------- | ---------- | ----------------------------------- |
| `commands` | string[] | _required_ | Command templates, each with exactly one `{}` placeholder for the message |

Each template must contain exactly one `{}` placeholder where the notification
message is injected. Every other argument must be a concrete literal. **Important:**
environment variables are session-scoped, but the MCP server is a single global
process shared by all sessions. A template runs via a shell inside that server
process, so any `$VAR` in a template resolves against the **server process's**
environment — not your session's. This tool never resolves environment variables.
To target your own session (e.g. a Codex thread id), read the real value first and
inline it as a literal. It can target an agent, a user, or anything else; the
command need not actually send a message:

```jsonc
// 1) Read the real session value in your session, then inline it:
//    echo $CODEX_THREAD_ID   -->  cd1234-...
// 2) Register with the concrete value baked in:
{ "commands": ["codex queue --thread \"cd1234-...\" --message \"{}\""] }

// Just echo the message (no delivery at all).
{ "commands": ["echo \"{}\""] }
```


Commands run sequentially. A failing command is logged but never affects the
sentinel task state — the task remains queryable via the other tools.

The call returns a `notifier_id` (a uuid). Because the MCP server is loaded
globally (shared by every session), each session's command list is registered
under its own id; a single dispatcher reads the task's `sessionID` (set from
the `notifier_id` you pass to `mcp_sentinel_poll`) and runs only that session's
commands. This keeps notifications from leaking across sessions. Pass the
`notifier_id` to `mcp_sentinel_poll` to associate the two:

```jsonc
{ "server": "mock-ci", "tool": "get_job_status", "args": { "job_id": "e2e" }, "interval": 1000, "notifier_id": "<uuid from above>", "until": { "path": "status", "is": "eq", "value": "completed" } }
```


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
| `CODEX_BIN`             | resolved  | Override the `codex` CLI binary path      |

## License

MIT
