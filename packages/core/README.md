# @gcszhn/mcp-sentinel-core

The harness-agnostic core of **mcp-sentinel** — polls long-running MCP tools
on the agent's behalf so that token-costly status loops never enter the LLM
inference path.

This package has **zero host dependencies**. It exposes the polling engine,
tool handlers, condition evaluator, MCP connection pool, env parsing, logger,
and types. Host adapters (`@gcszhn/mcp-sentinel-opencode-plugin`,
`@gcszhn/mcp-sentinel-deepseek-harness-plugin`, the harness-agnostic
`@gcszhn/mcp-sentinel-cli`, and future hosts) layer their own tool registration,
config discovery, and notification channel on top of it.

## Install

```bash
npm install @gcszhn/mcp-sentinel-core
```

> You normally do **not** install this directly — install a host plugin such as
> `@gcszhn/mcp-sentinel-opencode-plugin`, which brings this package in as a dependency.

## Usage (harness authors)

The only seam between the core and a host is `ToolInvoker` — a
`(server, tool, args) => result` function the engine calls once per poll. Build
it one of two ways:

### Mode 1 — connection pool (the core owns MCP connections)

Register the host's MCP config and let `makeConnectionInvoker` resolve, connect
(reusing the shared cache), and call the tool:

```ts
import {
  makeServerResolver,
  makeConnectionInvoker,
  handlePoll,
  handleStatus,
  handleAttach,
  handleRead,
  setNotifier,
  cleanup,
  disconnectAll,
} from "@gcszhn/mcp-sentinel-core";
import type { McpConfig, SentinelTask, SentinelEvent } from "@gcszhn/mcp-sentinel-core";

// 1. Parse the host's own MCP config into a McpConfig.
const mcpConfig: McpConfig = parseMyHostMcpConfig(rawConfig);
const invoke = makeConnectionInvoker(makeServerResolver(mcpConfig));

// 2. Register the four tools, delegating to the core handlers.
const result = await handlePoll(
  { server, tool, args, interval, timeout, until, sessionID },
  invoke
);
```

### Mode 2 — external invoker (the host already owns MCP)

Pass your own `(server, tool, args) => result` function; the core never opens a
connection and never parses MCP config. This is how a host that already bridges
MCP (e.g. registering `mcp__<server>__<tool>` on its own tool registry) reuses
that bridge instead of connecting twice:

```ts
import { handlePoll } from "@gcszhn/mcp-sentinel-core";
import type { ToolInvoker } from "@gcszhn/mcp-sentinel-core";

const invoke: ToolInvoker = async (server, tool, args) => {
  return myHost.callMcpTool(server, tool, args); // host-owned MCP call
};

const result = await handlePoll(
  { server, tool, args, interval, timeout, until, sessionID },
  invoke
);
```

`invoke` must return the canonical result the condition evaluator inspects: a
parsed JSON object, or a raw non-JSON value for tools that return plain text,
numbers, or booleans. Use the exported `parseMcpContent` helper to normalize a
raw MCP `content` array (text blocks → parsed JSON, or verbatim text).

Both modes share the notification and shutdown wiring:

```ts
// 3. Deliver completion notifications through the host's message channel.
setNotifier(async (task: SentinelTask, event: SentinelEvent) => {
  await myHost.notify(task.request.sessionID, render(task, event));
});

// 4. Shut down cleanly. `disconnectAll` only matters in Mode 1 (it closes the
//    cached connections); calling it in Mode 2 is a harmless no-op.
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
