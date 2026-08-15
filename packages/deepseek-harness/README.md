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

## Configure MCP servers

The plugin declares its own MCP server map (it does not reuse the harness's
`@deepseek-ai/dsh-mcp-client` service, because the sentinel core owns its MCP
connections). Override the `servers` map in your profile's `cordis.patch.yml`:

```yaml
- id: mcp-sentinel
  name: "@gcszhn/mcp-sentinel-deepseek-harness-plugin"
  config:
    servers:
      mock-ci:
        transport: stdio
        command: bun
        args: ["/path/to/mock-mcp-server.ts", "--port", "0"]
      remote:
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: "Bearer ${TOKEN}"
```

Both `stdio` and `streamable-http` transports are supported. Every server
defaults to `enabled: true`; set `enabled: false` to exclude one from sentinel
lookups.

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
| `server`   | string | _required_ | MCP server name (from the `servers` config) |
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
{ "path": "status", "is": "eq", "value": "completed" }        // leaf comparison
{ "path": "tasks[0].exit_code", "is": "ne", "value": 0 }     // array-index path
{ "not": { "path": "status", "is": "eq", "value": "error" } } // negation
{ "and": [ /* conditions */ ] }                               // logical AND
{ "or": [ /* conditions */ ] }                                // logical OR
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `match`.

## License

MIT
