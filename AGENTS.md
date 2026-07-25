# Repository Instructions

## GitHub Flow

- Never make changes directly on `main`. Create or switch to a feature branch first.
- Do not commit, amend, rebase, or push unless explicitly asked.
- Pushing to remote and creating releases/tags requires explicit user authorization.
- **Code must be reviewed and approved before asking about git operations.** Don't preemptively ask for commit/push — wait for user to confirm the changes look good.

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

**No hardcoded version strings.** The MCP client info (`name`/`version`) is imported from `package.json` with `{ type: "json" }` at compile time. Updating `package.json` version is the only required change for a release.

## Mock MCP server (`tests/mock-mcp-server.ts`)

Self-contained stdio server with `submit_job` and `get_job_status`. State advances globally per poll (8 stages, 2 polls each). `{env:PWD}` paths work in opencode MCP config.

## Tool development standards

### Core principle: surface errors, never hide them

- **Every error must reach the agent** as a clear, actionable tool output string. The agent is the debugger — don't deprive it of information.
- **Never blindly try/catch** unless you have a specific recovery strategy. Let exceptions propagate so they become visible. The only acceptable silent catch is for truly non-fatal side effects (e.g., prompt notification failure).
- **Be strict about parameter validation.** Loose validation leads to mysterious failures that the agent can't diagnose. Validate types, shapes, and constraints upfront and return explicit `"Error: ..."` messages.
- **When the MCP server rejects arguments, pass the raw error through verbatim** — field names, error codes, and all. Don't wrap or rewrite it.

### Input validation

All tools MUST validate their inputs and return **clean error strings** (`"Error: ..."`) to the agent — never let JS exceptions propagate.

- Validate required fields: non-empty strings, valid JSON parse, correct types.
- Wrap `startSentinel` and other fallible calls in `try/catch` — return `"Error: ${String(err)}"`.
- For `until`: validate it's a JSON object (not string, number, array, null).
- For `args`: validate JSON parse before passing to MCP.
- When the MCP server rejects wrong arguments, the raw MCP error (including field names and error codes) must be passed through to the agent verbatim — do not wrap or obscure it.

### Error handling patterns

```typescript
// ✅ Correct: return error string to agent
return "Error: server and tool must be non-empty strings.";

// ✅ Correct: wrap with try/catch
try { await startSentinel(...); } catch (err) { return `Error: ${String(err)}`; }

// ❌ Wrong: let exception propagate — agent gets cryptic JS error
await startSentinel(...);
```

### Defaults and fallbacks

- Optional parameters must have sensible defaults in the handler (not just the schema).
- All `switch` statements must have a `default` case returning an error string.
- `ctx.abort` must be checked — return `""` on abort.

## Testing requirements

### Unit tests must cover

- Normal flow (happy path)
- Invalid inputs (empty strings, wrong types, missing fields)
- Error paths (MCP server returns errors, connection failures)
- Edge cases (null/undefined values, array index paths, nested conditions)

### End-to-end tests must cover

- Agent passing wrong MCP server name, tool name, or arguments — verify the error message is clear and includes the original MCP error
- Agent using correct parameters — verify the full polling pipeline works
- `mcp_sentinel_read` offset/limit pagination
- `mcp_sentinel_attach` blocking wait with `ctx.abort`
- `mcp_sentinel_status` list/cancel actions
- Long-running task simulation (mock-ci 8-stage progression)
