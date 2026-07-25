# opencode-mcp-sentinel

A plugin for [OpenCode](https://opencode.ai) that acts as a **sentinel** between the AI agent and MCP servers — polling long-running tasks on the agent's behalf so that token-costly status loops never enter the LLM inference path.

## Motivation

When an agent submits a long-running job through an MCP tool (CI pipeline, data processing, model training, etc.), it must repeatedly call the MCP server to check progress:

```
agent → MCP tool (check status) → LLM inference (tokens consumed)
agent → MCP tool (check status) → LLM inference (tokens consumed)
...
agent → result received
```

Each round-trip burns context window tokens. For tasks that run minutes or hours, this is both expensive and wasteful.

**opencode-mcp-sentinel** moves the polling loop out of the agent and into the plugin runtime — 2 inference calls regardless of task duration.

## Installation

```bash
npm install opencode-mcp-sentinel
```

## Configuration

Add to your `opencode.jsonc` (project-level `.opencode/opencode.jsonc` or global `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugin": ["opencode-mcp-sentinel"],
}
```

The plugin reads your existing MCP server configs — no additional setup needed.

## Tools

### `poll_mcp`

Submit a long-running MCP tool call and poll it at regular intervals until a condition is met.

| Parameter  | Type   | Default    | Description                            |
| ---------- | ------ | ---------- | -------------------------------------- |
| `server`   | string | _required_ | MCP server name (from opencode config) |
| `tool`     | string | _required_ | Tool name to call on the server        |
| `args`     | string | `"{}"`     | JSON string of arguments for the tool  |
| `interval` | number | `5000`     | Poll interval in milliseconds          |
| `timeout`  | number | `600000`   | Maximum poll duration in milliseconds  |
| `until`    | string | _required_ | JSON condition object                  |

Returns a poll ID immediately. The agent is notified via prompt injection when the condition is met or the poll times out.

### `poll_status`

Check the status of sentinel polls.

| Parameter | Type                                 | Description                                  |
| --------- | ------------------------------------ | -------------------------------------------- |
| `action`  | `"status"` \| `"list"` \| `"cancel"` | Action to perform                            |
| `poll_id` | string                               | Poll ID (required for `status` and `cancel`) |

## Condition Model

Conditions are **pure declarative data** — no executable code, no injection surface.

```typescript
// Simple comparison
{ "path": "status", "is": "eq", "value": "completed" }

// Array index access
{ "path": "[0].data.path", "is": "eq", "value": "found" }

// Regex match
{ "path": "log", "is": "match", "value": "^error" }

// Logical composition
{
  "and": [
    { "path": "status", "is": "eq", "value": "completed" },
    { "path": "tasks[0].exit_code", "is": "eq", "value": 0 }
  ]
}
```

### Operators

| Operator   | Description                                  |
| ---------- | -------------------------------------------- |
| `eq`       | Strict equality                              |
| `ne`       | Not equal                                    |
| `gt`       | Greater than (numeric)                       |
| `gte`      | Greater than or equal                        |
| `lt`       | Less than                                    |
| `lte`      | Less than or equal                           |
| `contains` | String contains                              |
| `match`    | Regex match (`new RegExp(value).test(data)`) |

### Logical combinators

| Combinator               | Description    |
| ------------------------ | -------------- |
| `{ "not": <condition> }` | Negation       |
| `{ "and": [...] }`       | All must match |
| `{ "or": [...] }`        | Any must match |

### Path syntax

Uses property-access notation with array index support:

```
status               → obj.status
tasks[0].exit_code   → obj.tasks[0].exit_code
[0].data.path        → obj[0].data.path
items[2].name        → obj.items[2].name
```

## Architecture

```
┌──────────┐     poll_mcp()      ┌────────────────────┐
│  Agent   │ ──────────────────> │  opencode-mcp-     │
│  (LLM)   │ <── promptAsync()   │  sentinel           │
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
```

## License

MIT
