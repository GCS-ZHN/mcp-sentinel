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

## Key facts

- Plugins are **Cordis plugins**: a module exporting `name`, `inject`, and
  `apply(ctx, config)` (or object/class form).
- Tools: `ctx.tools.register(defineTool({ name, description, parameters, output,
execute }))` from `@deepseek-ai/dsh-tools`.
- This plugin takes **no config**: the bundle layer (`cordis.patch.yml`) adds a
  config-less insert, so there is no Schemastery `Config` type or schema to
  maintain. (Keep it that way — sentinel behavior is env-driven, not config-driven.)
- The harness's MCP bridge is `@deepseek-ai/dsh-mcp-client`; it registers each
  server's tools on `ctx.tools` under `mcp__<serverName>__<rawName>`.
- Notification: push to the originating agent via `agent.followup(
createUserMessage(...) )`; `ctx.agents.get(SessionId(...))` resolves the agent
  by its session id. (`followup` — not `inject`/`steer`/`send` — is used because
  it queues an ordinary turn and wakes the driver.)
- Install: ship a `dsh.bundle` manifest (`dsh.bundle.patch` →
  `cordis.patch.yml`), then `dsh plugin --profile <name> add <pkg>`.

## Local testing

- One-shot run: `npx @deepseek-ai/dsh --profile headless "<task>"`.
- Scripted E2E: run the root AGENTS.md's E2E harness with
  `--harness deepseek-harness`.
- The `mock-ci` and `codegraph` stdio servers are configured in the profile's
  `cordis.patch.yml` under `$DSH_HOME/profiles/<name>/`.

## Published peer-dependency versions

- `@deepseek-ai/cordis` — `^4.0.1`
- `@deepseek-ai/dsh-tools` — `^0.1.0-rc.6`
- `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session` —
  `^0.1.0-rc.6`
- `@deepseek-ai/schemastery` — transitive (via `dsh-tools`/`cordis`); not a
  declared dependency of this package.
