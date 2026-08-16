# mcp-sentinel-core — development notes

The shared, harness-agnostic engine. Every adapter (`opencode`,
`deepseek-harness`, `cli`) depends on this package and runs against its
published `dist/` — treat the public API as a contract, not an implementation
detail.

Supplements the repository-root `AGENTS.md`, which governs git flow, lockstep
versioning, CI, and the project-wide tool/testing standards.

## Keep it harness-agnostic

- **Zero host dependencies**: only `@modelcontextprotocol/sdk` is a runtime
  dependency. Never import a host SDK (`@opencode-ai/*`, `@deepseek-ai/*`,
  codex, …) or touch host config / notification channels from the core.
- The engine talks to MCP **only** through the injected `ToolInvoker`
  (`startSentinel(request, invoke)`) and notifies **only** via `setNotifier`.
  Any other back channel breaks the dual-mode design (connection-pool /
  external-invoker).
- Public API changes ripple to every adapter (types, handlers,
  `descriptions.ts` consts): keep all three compiling and their READMEs in sync.

## Shared fixtures other packages depend on

- `tests/mock-mcp-server.ts` is the E2E fixture for every harness (opencode
  config, dsh profile, CLI workdirs), registered as `mock-ci`. Behavioral
  spec: state advances globally per poll; a job runs through 8 stages × 2
  polls and reports `status=completed` on the 17th poll. A `--transport=http`
  mode (session expiry) exercises reconnection. Don't change its poll
  progression or transports casually — E2E assertions rely on it.
- Handler error strings are asserted by adapter tests and `e2e-cases.json`;
  rewording them means updating those too.
