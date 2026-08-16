# OpenCode harness plugin

An [OpenCode](https://opencode.ai) harness adapter for
`@gcszhn/mcp-sentinel-core`. It runs in **connection-pool mode**: it reads the
host's MCP config and lets the core own the MCP connections.

Supplements the repository-root `AGENTS.md`, which governs git flow, lockstep
versioning, CI, and the project-wide tool/testing standards.

## E2E testing

Run with `--log-level DEBUG` to see plugin internal logs (poll events, cleanup
timers, etc.):

```bash
opencode run "..." --dir . --print-logs --log-level DEBUG --model opencode/deepseek-v4-flash-free
```

Use `pty_spawn` for concurrent E2E runs — a background PTY that doesn't block:

```bash
pty_spawn command=bash args=["-c","export ENV=VALUE && opencode run '...' --dir . --log-level DEBUG ..."]
```

Set `notifyOnExit=true` and wait for `<pty_exited>` — do NOT poll `pty_read` in
a sleep loop.

The repo's `.opencode/opencode.jsonc` loads the plugin from source
(`{env:PWD}/packages/opencode/src/plugin.ts`) and includes a `mock-ci` MCP server
for testing.

## Plugin SDK constraints

- `@opencode-ai/plugin` is pinned to **1.3.13**. Use `tool()` + `tool.schema` for
  tool definitions.
- `tool.execute(args, ctx)` returns `Promise<string>`. `ctx.sessionID` provides
  the session ID.
- Notification:
  `client.session.promptAsync({ path: { id: sessionID }, body: { parts: [...] } })`
  — NOT `prompt()`.
- Part IDs must start with `prt-`.
- `client.config.get()` returns `{ data: Config }` — use `.data`.

## MCP config parsing

OpenCode stores MCP servers as flat keys under `mcp`:

```jsonc
{ "mcp": { "servername": { "type": "local", "command": [...], "enabled": true } } }
```

NOT `mcp.servers.{name}`. `type` is `"local"` or `"remote"`. `local.command` is a
`string[]`.
