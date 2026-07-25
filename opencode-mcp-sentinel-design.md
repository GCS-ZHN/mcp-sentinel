# opencode-mcp-sentinel

A plugin for [OpenCode](https://opencode.ai) that acts as a **sentinel** between the AI agent and MCP servers — polling long-running tasks on the agent's behalf so that token-costly status loops never enter the LLM inference path.

## Motivation

When an agent submits a long-running job through an MCP tool (CI pipeline, data processing, model training, etc.), it must repeatedly call the MCP server to check progress:

```
agent → MCP tool (check status) → LLM inference (tokens consumed)
agent → MCP tool (check status) → LLM inference (tokens consumed)
agent → MCP tool (check status) → LLM inference (tokens consumed)
...
agent → result received
```

Each round-trip burns context window tokens. For tasks that run minutes or hours, this is both expensive and wasteful — the agent isn't reasoning, it's just waiting.

**opencode-mcp-sentinel** moves the polling loop out of the agent and into the plugin runtime:

```
agent → poll_mcp({ server, tool, args, until }) → LLM inference (once)
plugin → MCP server (poll silently, zero tokens)
plugin → agent (prompt notification with result)
agent → continues work → LLM inference (once, with result)
```

## Design Principles

### 1. The agent writes the condition; the sentinel enforces it

The sentinel has no domain knowledge and makes no decisions. Conditions are **declarative data structures** authored by the agent, which understands the output schema of the MCP tool it's calling.

### 2. No executable code in conditions

Conditions are pure data — key paths, comparison operators, and literal values. No `eval`, no function strings, no expression DSL that compiles to code. This eliminates injection surface entirely.

### 3. One plugin, any MCP server

The sentinel is server-agnostic. It reads MCP configurations from OpenCode's own config, connects independently via `@modelcontextprotocol/sdk`, and polls any tool on any server. No per-service adapter code.

### 4. Token-minimal interaction model

- Agent calls `poll_mcp` once → 1 inference unit
- Plugin polls silently until condition met → 0 inference units
- Plugin notifies agent with result → 1 inference unit

Total: 2 inference units regardless of task duration.

## Condition Model

```typescript
type PollCondition =
  | {
      path: string;
      is: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "match";
      value: unknown;
    }
  | { not: PollCondition }
  | { and: PollCondition[] }
  | { or: PollCondition[] };
```

Key design choices:

- **`path`** uses property-access notation (`"status"`, `"tasks[0].exit_code"`). Plugin resolves it with `lodash.get` against the MCP tool result.
- **`is`** defines the comparison. `"match"` accepts a regex string; the plugin compiles it via `new RegExp(value).test(data)` — still no code execution.
- **`not` / `and` / `or`** provide logical composition without nesting ambiguity.

The agent writes conditions naturally because it knows the tool's output schema. Example:

```jsonc
{
  "server": "pipeline",
  "tool": "get_task",
  "args": { "task_id": "abc" },
  "interval": 3000,
  "until": {
    "and": [
      { "path": "status", "is": "eq", "value": "completed" },
      { "path": "tasks[0].exit_code", "is": "ne", "value": null },
    ],
  },
}
```

## Architecture

```
┌──────────┐     poll_mcp()      ┌────────────────────┐
│  Agent   │ ──────────────────> │  opencode-mcp-     │
│  (LLM)   │ <── prompt(result)  │  sentinel           │
└──────────┘                     │                     │
                                 │  ┌───────────────┐  │
                                 │  │ Config reader │  │
                                 │  │ (from opencode│  │
                                 │  │  config.mcp)  │  │
                                 │  └───────┬───────┘  │
                                 │          │          │
                                 │  ┌───────▼───────┐  │
                                 │  │ MCP client    │  │
                                 │  │ (@model-      │  │
                                 │  │  context/     │  │
                                 │  │  protocol/sdk)│  │
                                 │  └───────┬───────┘  │
                                 │          │          │
                                 │  ┌───────▼───────┐  │
                                 │  │ Poll loop     │  │
                                 │  │ + condition   │  │
                                 │  │ evaluator     │  │
                                 │  └───────────────┘  │
                                 └─────────────────────┘
                                          │
                                    MCP Protocol
                                          │
                                 ┌─────────────────────┐
                                 │  MCP Server         │
                                 │  (any server)       │
                                 └─────────────────────┘
```

1. **Config reader** extracts MCP server definitions from OpenCode config (`client.config.get()`)
2. **MCP client** independently connects to target servers via the official SDK
3. **Poll loop** calls the MCP tool at `interval`, evaluates `until` against each response
4. On match, notifies the agent via `client.session.prompt()` — same pattern as opencode-pty's `notifyOnExit`

## Related Work

The `notifyOnExit` pattern from [opencode-pty](https://github.com/shekohex/opencode-pty) inspired the notification model. Where opencode-pty watches for `process.exit`, the sentinel watches for arbitrary data conditions.

## Status

Design phase. Not yet implemented.

## License

MIT
