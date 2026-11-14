# OpenCode 2 (V2) harness plugin

An OpenCode 2 (**V2**) harness adapter for `@gcszhn/mcp-sentinel-core`. It runs
in **connection-pool mode**: it reads the host's MCP config and lets the core
own the MCP connections.

Supplements the repository-root `AGENTS.md`, which governs git flow, lockstep
versioning, CI, and the project-wide tool/testing standards.

This package is intentionally separate from `packages/opencode` (the V1
adapter). Do not import V1-only APIs (`@opencode-ai/plugin`, `tool()`,
`client.config.get()`, `session.promptAsync`) here.

## Plugin SDK constraints

- `@opencode/plugin` is pinned to the exact version of the running OpenCode 2
  release (`2.3.0` at time of writing). Re-verify the API after upgrading.
- The plugin is defined with `Plugin.define({ id, setup(ctx) })`; `setup`
  returns an optional cleanup function.
- Tools are registered through `ctx.tool.transform(editor => editor.add(...))`
  using **JSON Schema** (`input: { type: "object", properties, required }`), not
  zod.
- Tool `execute(raw, context)` returns `{ content: string }`;
  `context.sessionID` identifies the calling session and `context.signal` is the
  abort signal used by `mcp_sentinel_attach`.
- Notifications use:
  `ctx.session.synthetic({ sessionID, text, description, delivery, resume })`.
  `delivery` is `"steer"` or `"queue"` (default `"queue"`); `resume` defaults to
  `true`.
- Logging has no host logger in the V2 seam used here, so the log sink writes
  through `console.*`.

## MCP config discovery

V2 exposes MCP **connection status** through `ctx.mcp.list()`, but MCP
**configuration** only through a transform callback. The plugin captures the
current entries with a synchronous, replayable transform:

```ts
let mcpEntries: readonly Opencode2McpEntry[] = [];
await ctx.mcp.transform((editor) => {
  mcpEntries = editor.list();
});
```

The captured `[name, config]` entries are normalized by `src/config.ts` into the
core's `McpConfig`.

### No host MCP invocation API (verified on 2.3.0)

Connection-pool mode is not a shortcut — V2 offers no way to execute a host MCP
tool from a plugin:

- `ctx.mcp` is `Pick<McpApi, "list">` plus `transform` / `reload`; it exposes
  server config and status only.
- The host client's `mcp.*` namespace is `list`, `resource.catalog`, `add`,
  `remove`, `connect`, `disconnect`, `client.token`. There is no `callTool`.
- `ctx.tool` is `transform` / `list` / `hook`; the `execute.before` /
  `execute.after` hooks observe agent tool calls but cannot start one.
- `@opencode/client/mcp`'s `connectClientMcp` goes the other direction: it
  exposes _plugin_ tools to the host.

Re-check this list when upgrading `@opencode/plugin`; if a host invocation API
appears, the adapter could switch to external-invoker mode like the DeepSeek
Harness one.

V2 server config shape:

```jsonc
{
  "mcp": {
    "servers": {
      "name": {
        "type": "local",
        "command": ["bun", "run", "server.ts"],
        "environment": { "KEY": "value" },
        "disabled": false,
      },
      "remote-name": {
        "type": "remote",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer ..." },
        "oauth": false,
      },
    },
  },
}
```

Differences from V1:

- servers live under `mcp.servers.{name}`, **not** flat `mcp.{name}`;
- `environment` replaces `env`;
- `disabled` is the inverse of V1's `enabled`;
- a remote server may require OAuth (`oauth` not `false`).

The plugin cannot reuse OpenCode's OAuth credentials because the core opens its
own connection. When `ctx.mcp.list()` reports `needs_auth` and the server has no
static `headers`, the plugin rejects the poll up front with an actionable error
instead of letting it fail with a 401.

### Multi-instance host binding

V2 may load one plugin instance per location in the same process, all sharing
the core's module-level notifier/log sink. `src/host-registry.ts` keeps every
instance's channels, routes notifications by `task.request.sessionID`, and runs
the core's global `cleanup()` / `disconnectAll()` only when the last instance
unloads.

## E2E testing

Build the core and this package first, then run a headless V2 session with an
isolated config:

```bash
bun run build

OPENCODE_DISABLE_PROJECT_CONFIG=1 \
OPENCODE_CONFIG="$PWD/packages/opencode2/tests/e2e-opencode.jsonc" \
opencode run "<prompt>" --standalone \
  --model opencode/deepseek-v4.1-flash-free --auto
```

`tests/e2e-opencode.jsonc` loads the built plugin from
`{env:PWD}/packages/opencode2` and registers the shared `mock-ci` MCP server.

Notes:

- `--log-level` values are lowercase (`debug`, not `DEBUG`).
- Add `--print-logs` to see plugin output.
- macOS has no `timeout` command; rely on the harness's own limits.
- Do **not** put `plugins` in the root `.opencode` config: these runs are meant
  to be isolated from the repository's V1 setup.

## Live self-test (hot reload)

V2 reloads plugins and MCP configs while the TUI is running. To install this
adapter into the current session, point the project `.opencode/opencode.jsonc`
at this package by absolute path:

```jsonc
{
  "plugins": ["/abs/path/to/packages/opencode2"],
  "mcp": {
    "servers": {
      "mock-ci": {
        "type": "local",
        "command": ["bun", "run", "/abs/path/to/packages/core/tests/mock-mcp-server.ts"],
      },
    },
  },
}
```

Use absolute MCP paths: the long-running server's `{env:PWD}` may resolve to the
daemon's start directory (often `$HOME`), not the worktree. After `bun run
build`, the plugin file watcher reloads `dist/` automatically and the
`mcp_sentinel_*` tools appear in the running session.

**Hot reload re-evaluates the plugin module, not the core.** Bun keeps
`@gcszhn/mcp-sentinel-core` (a workspace symlink into `packages/core/dist`) in
its module cache, so core edits are invisible until the server restarts — and
in-flight state such as the core's connection cache survives every reload.
To live-test core changes without restarting the TUI, build a single-file
bundle as the plugin entry:

```bash
cd packages/opencode2
bun build src/index.ts --outfile dist/live/index.js --target bun --external @opencode/plugin
printf '{"name":"mcp-sentinel-opencode2-live","private":true,"type":"module","main":"index.js"}\n' > dist/live/package.json
```

then point `plugins` at the **directory** `packages/opencode2/dist/live` (a file
path is rejected: "configured plugin path must be a directory"). The bundle
inlines the core, so every rebuild re-evaluates both modules. Restore the
package entry and delete `dist/live` afterwards.

That config file is tracked by the repository — treat the change as a local test
aid and revert it before committing unrelated work.
