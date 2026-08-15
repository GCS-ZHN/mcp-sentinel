# mcp-sentinel-core

The harness-agnostic core of **mcp-sentinel** — polls long-running MCP tools
on the agent's behalf so that token-costly status loops never enter the LLM
inference path.

This package has **zero host dependencies**. It exposes the polling engine,
tool handlers, condition evaluator, MCP connection pool, env parsing, logger,
and types. Host plugins (`mcp-sentinel-opencode-plugin`, and future Codex /
Claude Code / DeepSeek adapters) layer their own tool registration, config
discovery, and notification channel on top of it.

## Install

```bash
npm install mcp-sentinel-core
```

> You normally do **not** install this directly — install a host plugin such as
> `mcp-sentinel-opencode-plugin`, which brings this package in as a dependency.

## Usage (harness authors)

The only seam between the core and a host is `ServerResolver`:

```ts
import {
  makeServerResolver,
  handlePoll,
  handleStatus,
  handleAttach,
  handleRead,
  setNotifier,
  cleanup,
  disconnectAll,
} from "mcp-sentinel-core";
import type { McpConfig, ServerResolver, SentinelTask, SentinelEvent } from "mcp-sentinel-core";

// 1. Parse the host's own MCP config into a McpConfig.
const mcpConfig: McpConfig = parseMyHostMcpConfig(rawConfig);
const resolveServer: ServerResolver = makeServerResolver(mcpConfig);

// 2. Register the four tools, delegating to the core handlers.
const result = await handlePoll(
  { server, tool, args, interval, timeout, until, sessionID },
  resolveServer
);

// 3. Deliver completion notifications through the host's message channel.
setNotifier(async (task: SentinelTask, event: SentinelEvent) => {
  await myHost.notify(task.request.sessionID, render(task, event));
});

// 4. Shut down cleanly.
cleanup();
await disconnectAll();
```

## Environment variables

| Variable                | Default   | Description                               |
| ----------------------- | --------- | ----------------------------------------- |
| `SENTINEL_MAX_POLL_LOG` | unlimited | Max poll log entries per task (FIFO trim) |
| `SENTINEL_TASK_TTL_MS`  | unlimited | Auto-cleanup completed tasks after N ms   |

Both accept positive integers only. Zero, negative, or non-numeric values are
treated as unlimited/disabled.

## Tools

The core exposes four handlers that a host registers as native tools:

- `handlePoll` — start a poll loop until a condition is met
- `handleStatus` — status / list / cancel
- `handleAttach` — block until a task resolves
- `handleRead` — read raw poll outputs (offset/limit pagination)

See the repository root `README.md` for the condition model, operators, and
path syntax.

## License

MIT
