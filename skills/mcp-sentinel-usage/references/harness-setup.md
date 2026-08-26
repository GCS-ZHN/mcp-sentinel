# Harness setup reference

How mcp-sentinel is installed and registered in each harness. The core
principle: zero MCP re-configuration — the sentinel reuses the MCP servers the
harness already exposes.

## The CLI (any harness)

Install: bun/npm package @gcszhn/mcp-sentinel-cli (bin: mcp-sentinel).

```bash
mcp-sentinel mcp --harness <codex|opencode|custom|none> [--mcp-config <file>]
```

| --harness | Discovery                                 |
| --------- | ----------------------------------------- |
| codex     | codex mcp list --json                     |
| opencode  | opencode debug config (JSON "mcp" object) |
| custom    | a JSON file via --mcp-config              |
| none      | empty config                              |

The sentinel skips its own entry and entries the harness disabled. Version:
the CLI reports its version in MCP server info at startup. There is no
--version flag yet — do not invent one.

## Codex

One-click install script (builds and registers [mcp_servers.mcp-sentinel] in
the Codex config file, running mcp-sentinel mcp --harness codex):

```bash
scripts/install-codex-mcp.sh
```

Start a new thread afterwards. Manual equivalent: register an MCP server entry
that runs mcp-sentinel mcp --harness codex. Codex exposes its MCP servers via
codex mcp list --json; the sentinel polls exactly those. Codex has no push
channel, so use the command notifier (references/notifications.md) or
attach / status / read.

## OpenCode

```bash
opencode plugin -g @gcszhn/mcp-sentinel-opencode-plugin
```

Or add to opencode.jsonc (project or global): "plugin":
["@gcszhn/mcp-sentinel-opencode-plugin"]. The plugin reads the host MCP config
(client.config.get().mcp), exposes the four mcp_sentinel_* tools, and pushes
completion notifications automatically via promptAsync. No extra MCP setup.

## DeepSeek Harness

```bash
dsh plugin --profile <name> add @gcszhn/mcp-sentinel-deepseek-harness-plugin
```

External-invoker mode: the plugin calls the mcp__<server>__<tool> tools already
registered by the harness's @deepseek-ai/dsh-mcp-client bridge. In
mcp_sentinel_poll, server is the dsh-mcp-client instance's serverName and tool
is that server's raw tool name. Completions are pushed via Agent.followup
automatically. Verify the layer: dsh --profile <name> --dump-config.

## Custom / other harnesses

Register the CLI as an ordinary stdio MCP server in the harness's MCP config:

```bash
mcp-sentinel mcp --harness custom --mcp-config ./mcp.json
```

The custom config file uses OpenCode-style field names: command (string[]),
environment, headers, url, cwd. A JSON Schema ships with the package
(schema/mcp-config.schema.json). After registration, the mcp_sentinel_* tools
appear as any other MCP tools; collect results with attach / status / read or
the command notifier.

## Environment variables

| Variable              | Default   | Purpose                                   | 0/unset/NaN |
| --------------------- | --------- | ----------------------------------------- | ----------- |
| SENTINEL_MAX_POLL_LOG | unlimited | Max poll-log entries per task (FIFO trim) | unlimited   |
| SENTINEL_TASK_TTL_MS  | unlimited | Auto-cleanup completed tasks after N ms   | no cleanup  |

Both accept positive integers only; zero, negative, or non-numeric values mean
unlimited/disabled.
