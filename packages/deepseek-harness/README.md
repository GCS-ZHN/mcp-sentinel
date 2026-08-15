# @gcszhn/mcp-sentinel-deepseek-harness-plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin
that acts as a **sentinel** between the AI agent and MCP servers — polling
long-running tasks on the agent's behalf so that token-costly status loops never
enter the LLM inference path.

This package is the DeepSeek Harness adapter for `@gcszhn/mcp-sentinel-core`.

## Install

Install into a profile with the `dsh` CLI:

```bash
dsh plugin --profile <name> add @gcszhn/mcp-sentinel-deepseek-harness-plugin
```

The package ships a `dsh.bundle` manifest, so `dsh plugin add` appends it to the
profile's `dsh.profile.bundles` list and activates its `cordis.patch.yml` layer.
Verify the layer without booting:

```bash
dsh --profile <name> --dump-config
```

## How it talks to MCP

The plugin runs in **external-invoker mode**: it reuses the MCP tools already
registered by the harness's `@deepseek-ai/dsh-mcp-client` bridge and never owns
MCP connections itself, so there is no separate `servers` config and no
sentinel-specific MCP wiring. You keep configuring MCP exactly as you already do
for the harness — one `dsh-mcp-client` instance per server:

```yaml
# This is ordinary dsh-mcp-client config, not sentinel config.
- insert:
    - id: mcp-ci
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: ci
        transport: stdio
        command: bun
        args: ["/path/to/ci-mcp-server.ts"]
```

When calling `mcp_sentinel_poll`, `server` is the mcp-client `serverName` and
`tool` is the server's raw tool name; the sentinel invokes
`mcp__<server>__<tool>` (e.g. `mcp__ci__get_status`) through the harness tool
registry. Anything you already bridged with `dsh-mcp-client` is immediately
pollable — no extra step.

## Tools

### `mcp_sentinel_poll`

Submit a long-running MCP tool call and poll it at regular intervals until a
condition is met. Returns a sentinel ID immediately; when the sentinel
resolves, the plugin pushes a completion notice into the originating agent's
inbox (`Agent.followup`) so the driver wakes and the agent can collect the
result with `mcp_sentinel_attach` (blocking), `mcp_sentinel_status`, or
`mcp_sentinel_read`.

| Parameter  | Type   | Default    | Description                                 |
| ---------- | ------ | ---------- | ------------------------------------------- |
| `server`   | string | _required_ | `serverName` of a `dsh-mcp-client` instance |
| `tool`     | string | _required_ | Tool name to call on the server             |
| `args`     | string | `"{}"`     | JSON string of arguments for the tool       |
| `interval` | number | `5000`     | Poll interval in milliseconds               |
| `timeout`  | number | _optional_ | Max poll duration in ms (unset = no limit)  |
| `until`    | string | _required_ | JSON condition object                       |

### `mcp_sentinel_status`

Check status, list active tasks, or cancel a running task (`action` =
`status` | `list` | `cancel`).

### `mcp_sentinel_attach`

Block the agent, waiting for a sentinel to complete. Zero token cost during the
wait.

### `mcp_sentinel_read`

Read raw poll outputs with offset/limit pagination.

## Condition model

Conditions are pure declarative data:

```jsonc
{ "path": "status", "is": "eq", "value": "completed" }        // path leaf
{ "is": "eq", "value": "completed" }                          // no path: compare the raw result
{ "path": "tasks[0].exit_code", "is": "ne", "value": 0 }     // array-index path
{ "not": { "path": "status", "is": "eq", "value": "error" } } // negation
{ "and": [ /* conditions */ ] }                               // logical AND
{ "or": [ /* conditions */ ] }                                // logical OR
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `match`.
Omit `path` (or leave it empty) to match a non-JSON tool result directly.

## License

MIT
