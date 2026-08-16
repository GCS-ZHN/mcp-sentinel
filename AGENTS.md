# Repository Instructions

## GitHub Flow

- Never make changes directly on `main`. Create or switch to a feature branch first.
- Do not commit, amend, rebase, or push unless explicitly asked.
- Pushing to remote and creating releases/tags requires explicit user authorization.
- **Code must be reviewed and approved before asking about git operations.** Don't preemptively ask for commit/push — wait for user to confirm the changes look good.

## Harness plugin development

- **Core principle: zero MCP re-configuration.** A harness plugin reuses the MCP
  servers the harness already exposes — never a sentinel-specific MCP config or a
  bundled mock/demo MCP. Either read the host's MCP config (connection-pool mode,
  like OpenCode's `client.config.get().mcp`) or call the harness's
  already-registered MCP tools through its SDK (external-invoker mode, like
  DeepSeek Harness's `ctx.tools.execute`). Installing the plugin is the whole
  setup; the user does not add a `servers` map for the sentinel.
- A **new harness plugin** (`packages/<harness>`) is developed in its **own git
  worktree**, never directly on the main repo's working branch. Each harness
  plugin is independently publishable (`@gcszhn/mcp-sentinel-<harness>-plugin`), so its
  branch, review, and release lifecycle stays isolated from the core and from
  other harnesses.
- The shared core (`packages/core`) and existing harnesses are developed in the
  main repo.
- **Adding a new harness plugin must also update `.github/workflows/release.yml`:**
  the lockstep version verification loop and the plugin publish step (published
  in parallel with the other plugins, after `packages/core`). A plugin omitted
  from CI will neither be published nor version-checked.
- **Harness-specific notes live in each package's own `AGENTS.md`**
  (`packages/<harness>/AGENTS.md`): SDK constraints, reference-doc URLs, local
  testing commands, and published dependency versions. Keep only the shared,
  cross-cutting guidance here.

## Commands

```bash
bun run typecheck          # tsc --noEmit
bun run build              # rm -rf dist && bunx tsc
bun test                   # bun test (73 tests)
bun run format             # prettier --write
```

Pre-commit hook runs `typecheck && lint-staged` (prettier). Build **before** test if source changed.

## Mock MCP server (`packages/core/tests/mock-mcp-server.ts`)

Self-contained stdio server with `submit_job` and `get_job_status`. State advances globally per poll: 8 stages, 2 polls each → ~17 polls to reach `status=completed`. `{env:PWD}` paths work in opencode MCP config.

## Environment variable configuration

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

## TypeScript

- `verbatimModuleSyntax: true` → use `import type` for type-only imports.
- `skipLibCheck: true` because the plugin's zod v3/v4 compat types don't resolve cleanly.
- `noUncheckedIndexedAccess: true`.

## Release

```bash
# 1. Bump every package to the SAME version (lockstep):
#      packages/core/package.json
#      packages/opencode/package.json          (+ its `@gcszhn/mcp-sentinel-core` dep, pinned to the same version)
#      packages/deepseek-harness/package.json  (+ its `@gcszhn/mcp-sentinel-core` dep, pinned to the same version)
# 2. Commit, tag, push
git tag vX.Y.Z && git push origin main vX.Y.Z
```

Tag push triggers `.github/workflows/release.yml` (typecheck → build → test →
verify versions → publish `@gcszhn/mcp-sentinel-core`, then publish every plugin
(`opencode`, `deepseek-harness`) in parallel → GitHub release).

**No hardcoded version strings.** The MCP client info (`name`/`version`) is imported from `package.json` with `{ type: "json" }` at compile time. Updating `package.json` version is the only required change for a release.

**Lockstep versioning.** Every package in the monorepo carries the **same
version**, even if a package itself did not change. Each plugin pins
`@gcszhn/mcp-sentinel-core` to that **exact** version (no `^`/`~` range). Release fails
unless `packages/core`, every plugin, and each plugin's core dependency all
match the tag exactly. The git pre-commit hook runs `scripts/verify-versions.ts`
to reject a commit that breaks this invariant (unequal package versions, or a
plugin pinning the core to a different version).

**Monorepo layout.** `packages/core` publishes `@gcszhn/mcp-sentinel-core`;
`packages/opencode` publishes `@gcszhn/mcp-sentinel-opencode-plugin`;
`packages/deepseek-harness` publishes `@gcszhn/mcp-sentinel-deepseek-harness-plugin`.

## Tool development standards

### Core principle: surface errors, never hide them

- **Every error must reach the agent** as a clear, actionable tool output string. The agent is the debugger — don't deprive it of information.
- **Never blindly try/catch** unless you have a specific recovery strategy. Let exceptions propagate so they become visible. The only acceptable silent catch is for truly non-fatal side effects (e.g., prompt notification failure).
- **Be strict about parameter validation.** Loose validation leads to mysterious failures that the agent can't diagnose. Validate types, shapes, and constraints upfront and return explicit `"Error: ..."` messages.
- **When the MCP server rejects arguments, pass the raw error through verbatim** — field names, error codes, and all. Don't wrap or rewrite it.
- **Never leak `undefined` from a missing array index / object key.** Reading a
  non-existent array element or object property must throw a clear error (which
  surfaces as the sentinel's `error` status) — never silently yield `undefined`
  and poll forever. A typo'd path or out-of-range index is a misconfiguration
  the agent must learn about immediately. Code review must flag any silent
  `undefined`/`null` propagation as a finding.

### Input validation

All tools MUST validate their inputs and return **clean error strings** (`"Error: ..."`) to the agent — never let JS exceptions propagate.

- Validate required fields: non-empty strings, valid JSON parse, correct types.
- Wrap `startSentinel` and other fallible calls in `try/catch` — return `"Error: ${String(err)}"`.
- For `until`: validate it's a JSON object (not string, number, array, null).
- For `args`: validate JSON parse before passing to MCP.
- When the MCP server rejects wrong arguments, the raw MCP error (including field names and error codes) must be passed through to the agent verbatim — do not wrap or obscure it.

### Condition semantics

The `until` condition is a leaf-compare DSL. `evaluateCondition` enforces four
rules, and unit tests must cover each:

- **Empty `path`** (omitted, or an empty string) compares `is` against the MCP
  tool's entire returned value — no JSON-path resolution is performed.
- **Non-JSON payloads** (plain text) are treated as a single string; such a
  result is only comparable with an empty `path`.
- **Leaves only.** The resolved value (the `path` target, or the raw result when
  `path` is empty) must be a leaf — string, number, boolean, or `null`. An
  array/object throws during polling and surfaces as the sentinel's `error`
  status, so the agent learns the condition is misconfigured instead of it
  silently never matching.
- **Missing keys / indices throw.** Resolving a `path` to a key that does not
  exist, an out-of-range array index, or a property read off a `null`/primitive
  node throws (surfacing as `error`) instead of silently returning
  `undefined` — a typo'd field name must reach the agent, not poll forever.

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

Harness plugins are tested two ways:

- **Unit tests** — in-code, fixed assertions under `packages/<pkg>/tests/*.test.ts`.
  `packages/core` is unit-test heavy; every plugin package must also carry
  unit tests for its own logic (e.g. result extraction, notification text).
- **E2E tests** — agent-level semantic judgments, driven by a JSON case file plus
  a script, never fixed string matching.

**The test entrypoint is `bun test` everywhere** (root and each package runs its
own `*.test.ts`). E2E cases are deliberately NOT `*.test.ts`: they need an agent
and credentials, which CI does not have. CI runs `bun test` only (unit tests);
the scripted E2E harness below is run locally.

### Scripted E2E harness

Each harness ships `packages/<pkg>/tests/e2e-cases.json` — a JSON array of cases:

```json
{
  "id": "dsh-poll-attach-completes",
  "harness_name": "deepseek-harness",
  "headless_test_command": "npx @deepseek-ai/dsh --profile headless {prompt}",
  "input_prompt": "…",
  "expect_result": "…"
}
```

- `headless_test_command` is the harness's run command (e.g. `opencode run`,
  `dsh --profile headless`); `{prompt}` marks where `input_prompt` is injected.
- `expect_result` is a **natural-language** expectation. `scripts/run-e2e.ts`
  runs the command, then asks a judge model (DeepSeek) to decide semantically
  whether the actual output satisfies it — no keyword matching.
- Each case writes a JSON report under `e2e-results/` (gitignored); the script
  aggregates a pass rate into `e2e-results/summary.json`.

```bash
bun scripts/run-e2e.ts                          # all harnesses
bun scripts/run-e2e.ts --harness deepseek-harness
bun scripts/run-e2e.ts --dry-run                # print commands only
```

Judge config: `DEEPSEEK_API_KEY` (or `~/.dsh/.credentials.yaml`),
`DEEPSEEK_BASE_URL`, `E2E_JUDGE_MODEL`.

### E2E case authoring requirements

- **The pass rate is counted per case, not per file.** Each object in the JSON
  array is one case; `summary.json` counts cases.
- **Balanced harness coverage.** Every non-harness-specific behavior — the
  poll + attach happy path, timeout, invalid `args`/`until`, non-leaf condition,
  and a real stdio MCP — must have a case in **every** harness. Only
  harness-specific behavior (OpenCode's synchronous `Unknown MCP server`,
  DeepSeek Harness's `UNKNOWN_TOOL`) may exist in a single harness.
- **Test timeout**, not just success/error: a sentinel whose deadline elapses
  before the job completes must surface `timeout`.
- **Test boundaries and invalid inputs**: invalid JSON `args`, non-object
  `until`, empty server/tool, and the non-leaf-condition error.
- **Test a real stdio MCP, not only the mock** — e.g. `codegraph serve --mcp`;
  its `codegraph_explore` tool returns plain text, which also exercises the
  non-JSON / empty-`path` handling.

### Unit tests must cover

- Normal flow (happy path)
- Invalid inputs (empty strings, wrong types, missing fields)
- Error paths (MCP server returns errors, connection failures)
- Edge cases (null/undefined values, array index paths, nested conditions)
- Condition leaf constraint: a `path` (or empty-path root) resolving to an array
  or object must throw, not silently mismatch
- Environment variable parsing: valid positive int, 0, negative, non-numeric, unset
- Logger: all 4 levels, unset client, client.app.log throws
- TTL cleanup: error task cleanup, cancelled task cleanup, no cleanup when unset
- `cleanup()` clears both interval timers and TTL timeout timers

### End-to-end tests must cover

**Group 1 — Core features**

- `mcp_sentinel_poll`: submit job, poll until completed
- `mcp_sentinel_attach`: blocking wait for completion
- `mcp_sentinel_read`: offset/limit pagination (first N, later polls)
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

The prompts below exercise the groups above against the `mock-ci` MCP server.
They are harness-agnostic in substance (any harness that registers the
`mcp_sentinel_*` tools can run them); only the launcher command differs per
harness (see each package's own `AGENTS.md`).

**Group 1 — Core features**

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
