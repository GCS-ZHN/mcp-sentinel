---
name: mcp-sentinel-usage
description: >-
  Use mcp-sentinel to offload long-running MCP tool calls: submit a job with
  mcp_sentinel_poll, let the sentinel poll silently in the background until an
  until condition matches, and collect the result with mcp_sentinel_attach,
  mcp_sentinel_status, or mcp_sentinel_read — instead of the agent looping
  status calls and burning tokens. Also covers writing until condition objects,
  setting up completion self-notification across agent harnesses (Codex via
  codex queue + mcp_sentinel_set_notifier_commands, OpenCode, DeepSeek Harness,
  or any CLI harness), and debugging failed conditions. Trigger whenever the
  user submits a long-running job and wants to wait for completion, mentions
  sentinel / async MCP polling / mcp_sentinel_* tools / notifier / waiting for
  an async result without burning tokens — even if they do not name the skill.
metadata:
  author: GCS-ZHN
  version: "1.0"
compatibility: |
  mcp-sentinel CLI or harness plugins (opencode / deepseek-harness).
  mcp_sentinel_set_notifier_commands requires the CLI at version >= 1.4.0.
  The validator script needs node >= 18.
---

# mcp-sentinel usage

mcp-sentinel is a background polling service for MCP tools. You submit a
long-running call once with mcp_sentinel_poll, and the sentinel polls the
underlying MCP server silently (zero token cost) until an until condition
matches or the deadline elapses. Then you collect the result — either pushed to
you automatically (harness-dependent) or via mcp_sentinel_attach /
mcp_sentinel_status / mcp_sentinel_read.

## When to use this skill

Use it whenever a task involves an MCP tool that starts a job and returns a
status you must wait for (CI runs, batch jobs, async renders, remote
executions, ...). If you catch yourself calling a status tool in a loop, stop —
that is exactly the token cost this skill removes.

## The core workflow

Always follow this shape. Only the delivery step varies by harness.

1. **Submit** the job through its MCP tool (e.g. submit_job) and note the
   job id it returns.
2. **Optionally install a notifier** (see references/notifications.md) and
   keep its notifier_id.
3. **Poll** with mcp_sentinel_poll, targeting the status tool and an
   until condition; pass notifier_id if you installed one:

   ```jsonc
   mcp_sentinel_poll {
     server: "mock-ci",
     tool: "get_job_status",
     args: { "job_id": "e2e-features" },
     interval: 1000,             // ms; default 5000, minimum 1000
     timeout: 300000,            // ms; 0 or unset = no limit
     until: { "path": "status", "is": "eq", "value": "completed" }
     // notifier_id: "<uuid>"   // CLI >= 1.4.0 only
   }
   ```

   This returns a sentinel id immediately — do not poll the MCP tool
   yourself.

4. **Wait for completion** by doing nothing (a notifier delivers the result),
   or by calling mcp_sentinel_attach { id }, which blocks with zero token
   cost. Never loop mcp_sentinel_status — that is the anti-pattern this
   skill exists to avoid.
5. **Collect and use the result** from the sentinel's lastResult (status or
   notification message).

## The tools (closed set)

These are the only sentinel tools that exist. Do not invent others.

| Tool                               | Purpose                                     | Key parameters                                                                                                                     |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| mcp_sentinel_poll                  | Submit a poll                               | server, tool, args (object, default {}), interval (>=1000), timeout, until (required condition object), notifier_id (CLI >= 1.4.0) |
| mcp_sentinel_status                | Query / list / cancel                       | action (status                                                                                                                     | list | cancel), id (for status/cancel) |
| mcp_sentinel_attach                | Block until completion                      | id, timeout (ms, 0/unset = indefinite)                                                                                             |
| mcp_sentinel_read                  | Read raw poll outputs                       | id, offset (0-based, default from end), limit (default 5)                                                                          |
| mcp_sentinel_set_notifier_commands | Install a command-based notifier (CLI only) | commands (non-empty array of templates, each with exactly one {})                                                                  |

args and until are native JSON values in the tool arguments (JSON objects,
not JSON strings). interval is clamped to a minimum of 1000 ms; a positive
timeout to a minimum of 5000 ms.

## Writing until conditions

until is a pure-declarative condition object (no code, no expressions).
Quick rules — the full reference is references/conditions.md:

- **Leaf compare:** { "path": "status", "is": "eq", "value": "completed" }.
  path is dot-notation with [n] array indices (tasks[0].exit_code).
- **Empty path** (omitted or "") compares against the tool's entire return
  value. Plain-text (non-JSON) results can only be matched this way.
- **Operators:** eq, ne, gt, gte, lt, lte, contains, match.
- **Combinators:** { "not": ... }, { "and": [...] }, { "or": [...] }.
- **Leaf-only:** the resolved value must be a string / number / boolean / null.
  Pointing a condition at an array or object fails the poll (status error).
- **Missing keys and out-of-range indices throw** (status error), they never
  silently return undefined — a typo'd path must reach you, not poll forever.

Before submitting a non-trivial until, validate it deterministically (do not
eyeball it):

```bash
node scripts/validate-condition.mjs /path/to/until.json   # exit 0 = valid
echo '{"path":"status","is":"eq","value":"completed"}' | node scripts/validate-condition.mjs -
```

See scripts/README.md in this skill for the exact rules the validator enforces.

## Choosing how you are notified (harness routing)

Pick your harness's row; details in references/notifications.md.

| Harness                                | Delivery on completion          | What to do                                                                                                                                                        |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode (plugin)                      | Automatic (promptAsync push)    | Nothing — just poll. attach only if you want to block.                                                                                                            |
| DeepSeek Harness (plugin)              | Automatic (Agent.followup push) | Nothing — just poll. attach only if you want to block.                                                                                                            |
| Codex (CLI)                            | None by default                 | Install a notifier: echo $CODEX_THREAD_ID → inline the id → mcp_sentinel_set_notifier_commands with a codex queue template → pass notifier_id to poll. Or attach. |
| Any harness via CLI (mcp-sentinel mcp) | None by default                 | Same as Codex row with a delivery command of your choice, or attach / status / read.                                                                              |

## Self-notification recipe (Codex, verified)

The MCP server is a single **global process shared by all sessions**. A
notifier template runs through a shell inside that process, so any $VAR in a
template resolves against the **server process's** environment — never your
session's. Read real values in your session first and inline them as literals.

1. Read your thread id (it must be inlined, not referenced as $VAR):

   ```bash
   echo $CODEX_THREAD_ID   # e.g. 01a036b4-7382-7a10-ba33-570f62878829
   ```

2. Register a notifier. The message is substituted verbatim into the single
   {} placeholder and may contain quotes, backticks, or $ (it embeds a JSON
   result) — wrap the placeholder in **single quotes**:

   ```jsonc
   mcp_sentinel_set_notifier_commands {
     "commands": [
       "codex queue --thread 01a036b4-7382-7a10-ba33-570f62878829 --message '{}'"
     ]
   }
   ```

   This returns a notifier_id (a uuid). Multiple templates are allowed and
   run in order (e.g. a webhook push plus the Codex self-notification);
   a failing command is logged and never affects the sentinel task.

3. Pass the id to the poll:

   ```jsonc
   mcp_sentinel_poll {
     server: "mock-ci",
     tool: "get_job_status",
     args: { "job_id": "e2e" },
     interval: 1000,
     until: { "path": "status", "is": "eq", "value": "completed" },
     notifier_id: "<uuid-from-step-2>"
   }
   ```

The notification fires on completed, failed, and timeout alike (headings

## Sentinel Complete / ## Sentinel Failed / ## Sentinel Timeout with the

result or error), so you learn about condition mismatches too.

## Error handling at a glance

Full taxonomy and debugging flow in references/error-handling.md. The
sentinel never hides failures — every error surfaces as a clear string or as
the task's error status:

| Symptom                                                    | Meaning                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Error: Unknown MCP server: X                               | server is not in the harness's MCP config                                                  |
| Error: server and tool must be non-empty strings.          | Empty server/tool                                                                          |
| Error: until must be a JSON object describing a condition. | until is not an object (e.g. a string)                                                     |
| Raw MCP error (e.g. -32602: Tool X not found)              | The underlying server rejected tool/args — passed through verbatim                         |
| Task status error                                          | Condition misconfiguration: non-leaf target, missing key, bad path, or an invalid operator |

When a task reports error or timeout, read its raw poll log with
mcp_sentinel_read { id } to see exactly what the tool returned, then fix the
condition.

## Structured validation

- Run scripts/validate-condition.mjs on any non-trivial until before
  submitting (see above). It exits non-zero with a specific message on invalid
  conditions — do not declare a condition correct until the script passes.
- Resolvability against the live result (missing keys, wrong field names) can
  only be proven by the running poll — that surfaces as error, which you debug
  with mcp_sentinel_read.

## Scope & Boundaries

> - Capabilities, commands, subcommands, flags, parameters, environment
>   variables, endpoints, and file paths **not mentioned in this skill are not
>   part of this skill**. Do not guess or extrapolate them from related tools,
>   documentation memory, or pattern-matching across similar CLIs.
> - If the user asks for functionality outside this skill, stop and ask — do
>   not invent it.
> - The consuming agent is not responsible for completing or improving the
>   skill. Discovering missing functionality is a signal to **ask the user**,
>   not to fill the gap silently.
> - If the skill's instructions appear wrong, contradictory, outdated, or
>   produce errors when executed, stop and consult the user before proceeding.
>   Do not "fix" the skill on the fly, substitute an alternative command, or
>   retry with guessed parameters.
> - Modifying or extending the skill itself requires explicit user permission
>   and should be routed back through skill-creator.

The tool set is closed at the five tools listed above. In particular:

- mcp_sentinel_set_notifier_commands and poll's notifier_id exist **only in
  the CLI (>= 1.4.0)**. The OpenCode and DeepSeek Harness plugins push
  completion automatically and do not expose them — do not look for them
  there.
- There is **no** --version flag or version subcommand in the mcp-sentinel
  CLI yet; the CLI's version is reported in its MCP server info. Do not invent
  a version command.
- Command templates in the notifier run in the **server process's** shell;
  session environment variables are never available there. Inline concrete
  values.

## Reference documents

Open the relevant file only when you need it:

| File                         | Contents                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| references/conditions.md     | Full until DSL: operators, combinators, path syntax, leaf rules, error semantics, examples            |
| references/notifications.md  | Per-harness notification matrix and the complete notifier-commands guide                              |
| references/harness-setup.md  | Installing / registering mcp-sentinel in each harness (Codex, OpenCode, DeepSeek Harness, custom CLI) |
| references/error-handling.md | Error taxonomy, exact messages, debugging workflow, environment variables                             |

---

If a step fails or a tool behaves unexpectedly, consult the user instead of
improvising a workaround.
