# @gcszhn/mcp-sentinel-deepseek-harness-plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin
that acts as a **sentinel** between the AI agent and MCP servers — polling
long-running tasks on the agent's behalf so that token-costly status loops never
enter the LLM inference path.

This package is the DeepSeek Harness adapter for `@gcszhn/mcp-sentinel-core`.

## Install

Requires **DeepSeek Harness 0.2.2 or newer in the 0.2.x line**
(`engines.dsh: >=0.2.2-rc.1 <0.3.0`). 0.2.2 introduced the batched
`ctx.tools.execute` call shape this adapter uses (earlier 0.2.x releases expose
the single-call shape); `1.4.0` is the last release for older DSH runtimes.

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
`tool` is the server's raw tool name; the sentinel invokes the registry name
`mcp__<server>__<tool>` (e.g. `mcp__ci__get_status`). If the raw identity needs
character replacement or exceeds the 64-character function-name budget,
`dsh-mcp-client` appends a 12-hex SHA-256 suffix; the sentinel mirrors that
normalization, so dotted or long MCP tool names still resolve instead of failing
as `UNKNOWN_TOOL`. Anything you already bridged with `dsh-mcp-client` is
immediately pollable — no extra step.

On DSH 0.2.2+ the plugin submits one raw `tool-call` block to
`ctx.tools.execute({ calls, signal, agent })` and reads the settled batch
result. The adapter chooses the agent per call:

- With a normal permission preset, the originating agent is passed through, so
  the call stays inside that agent's executor, tool restrictions, and
  `tools/pre-execute` policies.
- With the **Auto** permission preset, the agent is omitted by default. DSH's
  auto-review gate reviews agent-bound calls by looking up an open model step;
  a sentinel poll runs from a background timer and has no step, so the call
  would always fail with `AUTO_REVIEW_FAILED`. Agentless polls still check the
  agent's tool visibility mask (allow/deny) before executing.

### Auto permission preset

`SENTINEL_DSH_PASS_AGENT` selects the behavior:

| Value                            | Behavior                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) / unset / empty | Pass the agent unless the session uses the Auto permission preset.                                                   |
| `always` / `1` / `true` / `on`   | Always pass the agent. Keeps full scope, but `mcp_sentinel_poll` fails with `AUTO_REVIEW_FAILED` on the Auto preset. |
| `never` / `0` / `false` / `off`  | Never pass the agent. Always uses the deployment executor and the visibility guard.                                  |

Invalid values fail plugin load with a clear error. The agentless path does not
run auto-review or other `tools/pre-execute` policies; it still refuses a tool
that the agent is restricted from calling. This is a workaround for a DSH host
limitation, not a replacement for the Auto preset's review: the upstream fix is
for auto-review to skip calls that have no open model step.

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
| `args`     | object | `{}`       | JSON object of arguments for the tool       |
| `interval` | number | `5000`     | Poll interval in milliseconds               |
| `timeout`  | number | _optional_ | Max poll duration in ms (unset = no limit)  |
| `until`    | object | _required_ | JSON condition object                       |

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
