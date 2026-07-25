# Repository Instructions

## GitHub Flow

- Never make changes directly on `main`. Create or switch to a feature branch first.
- Do not commit, amend, rebase, or push unless explicitly asked.

## Commands

```bash
bun run typecheck          # tsc --noEmit
bun run build              # rm -rf dist && bunx tsc
bun test                   # bun test (47 tests)
bun run format             # prettier --write
```

Pre-commit hook runs `typecheck && lint-staged` (prettier). Build **before** test if source changed.

## End-to-end testing

```bash
opencode run "..." --dir . --print-logs --model opencode/deepseek-v4-flash-free
```

The repo's `.opencode/opencode.jsonc` loads the plugin from source (`{env:PWD}/src/plugin.ts`) and includes a `mock-ci` MCP server for testing.

## Naming convention

- **Tool names**: `mcp_sentinel_poll`, `mcp_sentinel_status`, `mcp_sentinel_attach`, `mcp_sentinel_read`
- **Types**: `SentinelCondition`, `SentinelRequest`, `SentinelTask`
- **Functions**: `startSentinel`, `cancelSentinel`, `getSentinelTask`, `getActiveSentinels`
- Files use `.js` extension in imports (ESM + bundler resolution)

## Plugin SDK constraints

- `@opencode-ai/plugin` is pinned to **1.3.13**. Use `tool()` + `tool.schema` for tool definitions.
- `tool.execute(args, ctx)` returns `Promise<string>`. `ctx.sessionID` provides the session ID.
- `ctx.abort` signals user cancellation — return `""` on abort.
- Notification: `client.session.promptAsync({ path: { id: sessionID }, body: { parts: [...] } })` — NOT `prompt()`.
- Part IDs must start with `prt-`.
- `client.config.get()` returns `{ data: Config }` — use `.data`.

## TypeScript

- `verbatimModuleSyntax: true` → use `import type` for type-only imports.
- `skipLibCheck: true` because the plugin's zod v3/v4 compat types don't resolve cleanly.
- `noUncheckedIndexedAccess: true`.

## MCP config parsing

OpenCode stores MCP servers as flat keys under `mcp`:

```jsonc
{ "mcp": { "servername": { "type": "local", "command": [...], "enabled": true } } }
```

NOT `mcp.servers.{name}`. `type` is `"local"` or `"remote"`. `local.command` is a `string[]`.

## Release

```bash
# 1. Update version in package.json
# 2. Commit, tag, push
git tag vX.Y.Z && git push origin main vX.Y.Z
```

Tag push triggers `.github/workflows/release.yml` (typecheck → build → test → version verify → npm publish → GitHub release). Version in `package.json` must match the tag exactly.

## Mock MCP server (`tests/mock-mcp-server.ts`)

Self-contained stdio server with `submit_job` and `get_job_status`. State advances globally per poll (8 stages, 2 polls each). `{env:PWD}` paths work in opencode MCP config.
