# Repository Instructions

## GitHub Flow

- Never make changes directly on `main`. Create or switch to a feature branch first.
- Do not commit, amend, rebase, or push unless explicitly asked.
- Pushing to remote and creating releases/tags requires explicit user authorization.
- **Code must be reviewed and approved before asking about git operations.** Don't preemptively ask for commit/push — wait for user to confirm the changes look good.

## Harness plugin development

- A **new harness plugin** (`packages/<harness>`) is developed in its **own git
  worktree**, never directly on the main repo's working branch. Each harness
  plugin is independently publishable (`mcp-sentinel-<harness>-plugin`), so its
  branch, review, and release lifecycle stays isolated from the core and from
  other harnesses.
- The shared core (`packages/core`) and existing harnesses are developed in the
  main repo.

## Commands

```bash
bun run typecheck          # tsc --noEmit
bun run build              # rm -rf dist && bunx tsc
bun test                   # bun test (73 tests)
bun run format             # prettier --write
```

Pre-commit hook runs `typecheck && lint-staged` (prettier). Build **before** test if source changed.

## End-to-end testing

Run with `--log-level DEBUG` to see plugin internal logs (poll events, cleanup timers, etc.):

```bash
opencode run "..." --dir . --print-logs --log-level DEBUG --model opencode/deepseek-v4-flash-free
```

Use `pty_spawn` for concurrent E2E runs — it's a background PTY that doesn't block:

```bash
pty_spawn command=bash args=["-c","export ENV=VALUE && opencode run '...' --dir . --log-level DEBUG ..."]
```

Set `notifyOnExit=true` and wait for `<pty_exited>` — do NOT poll `pty_read` in a sleep loop.

The repo's `.opencode/opencode.jsonc` loads the plugin from source (`{env:PWD}/packages/opencode/src/plugin.ts`) and includes a `mock-ci` MCP server for testing.

### Mock MCP server (`packages/core/tests/mock-mcp-server.ts`)

Self-contained stdio server with `submit_job` and `get_job_status`. State advances globally per poll: 8 stages, 2 polls each → ~17 polls to reach `status=completed`. `{env:PWD}` paths work in opencode MCP config.

### Environment variable configuration

| Variable                | Purpose                                 | 0/unset/NaN |
| ----------------------- | --------------------------------------- | ----------- |
| `SENTINEL_MAX_POLL_LOG` | Max poll log entries per task (FIFO)    | unlimited   |
| `SENTINEL_TASK_TTL_MS`  | Auto-cleanup completed tasks after N ms | no cleanup  |

Both accept positive integers only. Zero, negative, or non-numeric values are treated as unlimited/disabled.

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
# 1. Update version in packages/core/package.json and packages/opencode/package.json
#    (and the mcp-sentinel-core dependency range in packages/opencode/package.json)
# 2. Commit, tag, push
git tag vX.Y.Z && git push origin main vX.Y.Z
```

Tag push triggers `.github/workflows/release.yml` (typecheck → build → test →
verify both package versions → publish `mcp-sentinel-core` then
`mcp-sentinel-opencode-plugin` → GitHub release). Both
`packages/core/package.json` and `packages/opencode/package.json` must carry the
same version as the tag.

**No hardcoded version strings.** The MCP client info (`name`/`version`) is imported from `package.json` with `{ type: "json" }` at compile time. Updating `package.json` version is the only required change for a release.

**Monorepo layout.** `packages/core` publishes `mcp-sentinel-core`;
`packages/opencode` publishes `mcp-sentinel-opencode-plugin`. The OpenCode
package depends on `mcp-sentinel-core` via an explicit `^` range (not
`workspace:*`), so bumping core's version requires bumping that dependency range
in `packages/opencode/package.json` too.

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
- Environment variable parsing: valid positive int, 0, negative, non-numeric, unset
- Logger: all 4 levels, unset client, client.app.log throws
- TTL cleanup: error task cleanup, cancelled task cleanup, no cleanup when unset
- `cleanup()` clears both interval timers and TTL timeout timers

### End-to-end tests must cover

Run concurrently via `pty_spawn` with `notifyOnExit=true`. Three test groups:

**Group 1 — Old features (no env vars)**

- `mcp_sentinel_poll`: submit job, poll until completed
- `mcp_sentinel_attach`: blocking wait for completion
- `mcp_sentinel_read`: offset/limit pagination (first 5, later polls)
- `mcp_sentinel_status`: status query, list action
- `mcp_sentinel_status action=cancel`: cancel a running sentinel

**Group 2 — Environment limits**

- `export SENTINEL_MAX_POLL_LOG=100 SENTINEL_TASK_TTL_MS=10000`
- Poll until completed, verify status still accessible after completion
- Verify pollLog count matches total polls (no trimming when under limit)
- Wait for TTL to expire, verify task is auto-cleaned from list

**Group 3 — Error handling**

- `server=nonexistent` → `Unknown MCP server: nonexistent`
- `tool=nonexistent` → raw MCP error `-32602: Tool nonexistent not found` verbatim
- `args=invalid-json` → `Invalid JSON for args parameter.`
- `server=""` → `server and tool must be non-empty strings.`
- `until=not-an-object` → `Invalid JSON for until parameter.`

### E2E prompt templates

**Group 1 — Old features**

```
Step 1: submit job e2e-features via mock-ci/submit_job.
Step 2: use mcp_sentinel_poll server=mock-ci tool=get_job_status args={"job_id":"e2e-features"} until={"path":"status","is":"eq","value":"completed"} interval=1000.
Step 3: use mcp_sentinel_attach on the sentinel ID to block-wait.
Step 4: use mcp_sentinel_read offset=0 limit=5 to read first 5 polls.
Step 5: use mcp_sentinel_read offset=10 limit=5 to read later polls.
Step 6: use mcp_sentinel_status action=status on the ID.
Step 7: use mcp_sentinel_status action=list.
Step 8: submit another job e2e-cancel, start a sentinel polling it, then cancel it with mcp_sentinel_status action=cancel. Verify the cancel succeeded.
```

**Group 2 — Environment limits**

```
# Run with: export SENTINEL_MAX_POLL_LOG=100 SENTINEL_TASK_TTL_MS=10000
Submit job e2e-params via mock-ci/submit_job.
Poll mock-ci/get_job_status job_id=e2e-params interval=1000 until status=completed.
After it completes, use mcp_sentinel_status to confirm task still exists (TTL not yet expired).
Use mcp_sentinel_read to count all poll outputs — should be 17 total since MAX_POLL_LOG=100 allows them all.
Wait 11 seconds. Use mcp_sentinel_status again — task should be gone.
Use mcp_sentinel_status action=list to confirm no active tasks.
```

**Group 3 — Error handling**

```
Test these error cases with mcp_sentinel_poll:
1) server=nonexistent tool=get_job_status until={"path":"status","is":"eq","value":"completed"}
   → expect Unknown MCP server.
2) server=mock-ci tool=nonexistent args={"job_id":"err-test"} until={"path":"status","is":"eq","value":"completed"}
   → expect MCP error passed through.
3) server=mock-ci tool=get_job_status args=invalid-json until={"path":"status","is":"eq","value":"completed"}
   → expect Invalid JSON for args.
4) server="" tool=get_job_status until={"path":"x","is":"eq","value":1}
   → expect non-empty strings error.
5) server=mock-ci tool=get_job_status args={} until=not-an-object
   → expect Invalid JSON for until.
Run each and verify the error messages are clear and actionable.
```
