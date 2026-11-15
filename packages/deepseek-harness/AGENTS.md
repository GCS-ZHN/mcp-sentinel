# DeepSeek Harness plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) adapter
for `@gcszhn/mcp-sentinel-core`. It runs in **external-invoker mode**: it reuses
the MCP tools already registered by `@deepseek-ai/dsh-mcp-client` (through
`ctx.tools.execute`) instead of owning MCP connections.

Supplements the repository-root `AGENTS.md`, which governs git flow, lockstep
versioning, CI, and the project-wide tool/testing standards.

## Reference (开发参考手册)

- Plugin authoring — https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/
  - Your first plugin — `.../en/develop/basic/`
  - Build a tool — `.../en/develop/basic/tool`
  - Plugin configuration — `.../en/develop/basic/config`
  - Package and install — `.../en/develop/basic/publish`
- Framework — https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/
  - Plugin lifecycle — `.../en/develop/framework/`
  - Services and dependencies — `.../en/develop/framework/service`
  - Event system — `.../en/develop/framework/events`
- Reference — https://deepseek-harness.github.io/deepseek-harness/en/reference/
- Source — https://github.com/deepseek-ai/deepseek-harness

## Supported DSH versions

- `engines.dsh` is `>=0.2.2-rc.1 <0.3.0`; installation and profile startup use
  that range alone (DSH ignores the `@deepseek-ai/dsh-*` peers when
  `engines.dsh` exists).
- The floor is `0.2.2-rc.1` because that release introduced the raw-call batch
  shape of `ctx.tools.execute` (`{ calls, signal, agent?, ... }`). Earlier
  `0.1.x` and `0.2.0`/`0.2.1` releases expose the single-call
  `execute({ callId, name, arguments, signal })` shape and cannot run this
  adapter; `1.4.0` remains their last compatible release.
- The declared peers (`^0.2.2-rc.1`, cordis `^4.1.0`) keep pnpm resolution
  aligned with that range. Do not widen `engines.dsh` without testing the API
  floor.

## Auto preset / auto-review

DSH's `@deepseek-ai/dsh-experimental-auto-review` bundle prepends a
`tools/pre-execute` listener. It intervenes only when the call carries an agent
**and** the session's effective permission preset is `auto` (the exported
`AUTO_PRESET` from `@deepseek-ai/dsh-permission-presets`). It then reviews the
call by locating its open model step in the session log; a background sentinel
poll has no step, so it throws and the call becomes:

```text
AUTO_REVIEW_FAILED: ... auto-review: the pending call has no open step in the session log
```

The adapter must not fabricate a step or disable auto-review. It selects the
agent per call in `makeDshInvoker`:

- `SENTINEL_DSH_PASS_AGENT=auto` (default): pass the agent unless
  `permissionPresets.current(agent.session) === "auto"`.
- `always` / `1` / `true` / `on`: always pass the agent. Full scope, but polls
  fail on the Auto preset.
- `never` / `0` / `false` / `off`: never pass the agent.

Malformed values fail plugin load. The host service is structural
(`PermissionPresetLookup`); do not import `@deepseek-ai/dsh-permission-presets`
into the adapter. An absent service is treated as non-Auto.

When the agent is omitted, `assertToolVisibleToAgent` calls
`ctx.tools.get(toolName, agent)` first. A tool present globally but absent from
the agent view is a restriction, not an unknown name, and must throw instead of
silently bypassing the mask. A tool absent from both views proceeds so the
executor can return its raw `UNKNOWN_TOOL` error. The agentless path does not
run auto-review or other `tools/pre-execute` policies; that is the documented
cost of keeping background polls functional on Auto.

Unit tests: `tests/agent-selection.test.ts` covers env parsing, the per-preset
decision, the visibility guard, and the exact `agent` field in the batch.
Live Auto-preset E2E cannot be exercised from a danger-full-access session;
switch a Desktop session to Auto and run poll + attach to verify the host path.

## Key facts

- Plugins are **Cordis plugins**: a module exporting `name`, `inject`, and
  `apply(ctx, config)` (or object/class form).
- Tools: `ctx.tools.register(defineTool({ name, description, parameters, output,
execute }))` from `@deepseek-ai/dsh-tools`.
- This plugin takes **no config**: the bundle layer (`cordis.patch.yml`) adds a
  config-less insert, so there is no Schemastery `Config` type or schema to
  maintain. (Keep it that way — sentinel behavior is env-driven, not config-driven.)
- The harness's MCP bridge is `@deepseek-ai/dsh-mcp-client`; it registers each
  server's tools on `ctx.tools` under `mcp__<serverName>__<rawName>`. When the
  raw identity contains characters outside `[A-Za-z0-9_-]` or exceeds 64 chars,
  the bridge normalizes it and appends a 12-hex SHA-256 suffix; `mcpToolName()`
  in `src/index.ts` mirrors that function so the sentinel addresses the exact
  registered name.
- Tool invocation (0.2.2+): `ctx.tools.execute({ calls, signal, agent? })`
  returns a `ToolBatchResult`; the sentinel submits exactly one `tool-call`
  block and reads `results[0].result`. `makeDshInvoker` resolves the originating
  agent from the core's optional `context.sessionID` and then decides whether to
  attach it (see [Auto preset / auto-review](#auto-preset--auto-review)).
- Notification: push to the originating agent via
  `agent.followup(createUserMessage(...))`; `ctx.agents.get(SessionId(...))`
  resolves the agent by its session id. (`followup` — not
  `inject`/`steer`/`send` — is used because it queues an ordinary turn and wakes
  the driver.) There is no shared `plugin` source kind in 0.2.x; declare your
  own merge-extensible kind:

  ```ts
  declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
      "mcp-sentinel": { kind: "mcp-sentinel" } & ContextFormed;
    }
  }
  ```

  Use `form: "notice"` with a `boundContextSummary(...)` summary.

- Install: ship a `dsh.bundle` manifest (`dsh.bundle.patch` →
  `cordis.patch.yml`), then `dsh plugin --profile <name> add <pkg>`.

## Local testing

- One-shot run: `npx @deepseek-ai/dsh --profile headless "<task>"`.
- Scripted E2E: run the root AGENTS.md's E2E harness with
  `--harness deepseek-harness`.
- The `mock-ci` and `codegraph` stdio servers are configured in the profile's
  `cordis.patch.yml` under `$DSH_HOME/profiles/<name>/`.
- Verify against the running Desktop build without installing into the live
  profile: use its embedded CLI and a writable `DSH_HOME`, with an overlay that
  inserts `packages/deepseek-harness/dist/index.js` by absolute path:

  ```sh
  DSH_HOME=/tmp/dsh-e2e-home \
    ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
    "$DSH_INSTALL_DIR/lib/bin.js" --profile <test> --patch <overlay>
  ```

  This exercises the real 0.2.2 runtime (including completion notices) while
  leaving `~/.dsh` untouched.

## Published peer-dependency versions

- `@deepseek-ai/cordis` — `^4.1.0`
- `@deepseek-ai/dsh-tools` — `^0.2.2-rc.1`
- `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session` —
  `^0.2.2-rc.1`
- `@deepseek-ai/schemastery` — transitive (via `dsh-tools`/`cordis`); not a
  declared dependency of this package.
