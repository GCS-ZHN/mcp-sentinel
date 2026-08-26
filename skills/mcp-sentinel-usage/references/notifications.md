# Completion notifications (per harness)

How a resolved sentinel reaches you differs by harness. Read the row for YOUR
harness; the CLI notifier section is the full guide for the command-based
notifier.

## Delivery matrix

| Harness                 | Default delivery                              | Notifier tool available? |
| ----------------------- | --------------------------------------------- | ------------------------ |
| OpenCode plugin         | Automatic push (promptAsync) on completion    | No (not needed)          |
| DeepSeek Harness plugin | Automatic push (Agent.followup) on completion | No (not needed)          |
| Codex via CLI           | None                                          | Yes, CLI >= 1.4.0        |
| Any harness via CLI     | None                                          | Yes, CLI >= 1.4.0        |

OpenCode and DeepSeek Harness plugins deliver the same message shapes
(## Sentinel Complete / Failed / Timeout). Nothing to configure — just submit
the poll. Use mcp_sentinel_attach only when you specifically want to block.

## CLI command-based notifier (mcp_sentinel_set_notifier_commands)

Available only when the tool is visible in your tool list (CLI >= 1.4.0).
Otherwise fall back to attach / status / read.

### Template contract

commands is a non-empty array of command template strings. Each template:

- Must contain EXACTLY one {} placeholder. The notification message is
  substituted verbatim in its place (the whole message, not a value).
- Every other argument must be a concrete literal. A template never resolves
  environment variables — the command runs through a shell inside the MCP
  server process, which is a single GLOBAL process shared by all sessions. Any
  $VAR there resolves against the server process's environment, not yours.
  Read real values in your session first and inline them.
- Wrap the {} placeholder in SINGLE QUOTES ('{}'). The message may contain
  double quotes, backticks, and $ (it embeds a JSON result in a code fence);
  with double quotes the shell would interpret those as substitutions.
- May be any command at all; it need not send a message
  (echo '{}' is valid).
- Commands run sequentially, each with a 30-second timeout. A failing command
  is logged and NEVER affects the sentinel task — the task stays queryable.

### The notifier_id flow

1. Call mcp_sentinel_set_notifier_commands { "commands": [...] }.
2. It returns a notifier_id (a uuid) and registers your templates under it.
   Per-session isolation: each registration has its own id, so notifications
   never leak across sessions sharing the same global server.
3. Pass that exact notifier_id as notifier_id to mcp_sentinel_poll. On
   resolution the dispatcher runs YOUR registered commands with the message.

### Notification message formats

- Completed: "## Sentinel Complete" + server, tool, poll count, duration,
  result JSON in a code fence.
- Failed: "## Sentinel Failed" + server, tool, poll count, error.
- Timeout: "## Sentinel Timeout" + server, tool, poll count, last result.

### Multi-channel stacking

Register several templates; they run in order on EVERY resolution (completed,
failed, timeout). Example — push to a webhook AND message your own Codex
thread:

```jsonc
mcp_sentinel_set_notifier_commands {
  "commands": [
    "curl -sS -X POST -H 'Content-Type: application/json' -d '{"text":"{}"}' https://your-webhook.example/hook",
    "codex queue --thread 01a036b4-7382-7a10-ba33-570f62878829 --message '{}'"
  ]
}
```

The webhook URL is your own endpoint — the skill defines the template rules,
not the destination.

## Codex self-notification recipe (verified)

Goal: a sentinel messages the Codex thread it was started from when it
resolves, so you never poll.

1. Read your thread id — it MUST be inlined as a literal, because the notifier
   shell runs in the global server process and cannot see your session's
   environment:

   ```bash
   echo $CODEX_THREAD_ID
   # e.g. 01a036b4-7382-7a10-ba33-570f62878829
   ```

2. Register the notifier with the concrete thread id baked in and the
   placeholder single-quoted:

   ```jsonc
   mcp_sentinel_set_notifier_commands {
     "commands": [
       "codex queue --thread 01a036b4-7382-7a10-ba33-570f62878829 --message '{}'"
     ]
   }
   ```

   codex queue --thread <uuid-or-name> --message <text> is the Codex CLI
   command that delivers a message to an existing session.

3. Pass the returned notifier_id to the poll:

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

Result: on completion the notifier runs codex queue --message '{}', and the

## Sentinel Complete summary (with the JSON result) arrives in your thread.

Failures and timeouts notify the same way (## Sentinel Failed / Timeout), so
condition mismatches reach you too.

## Fallback: collect without a notifier

If the notifier tool is absent or you choose not to install one:

1. mcp_sentinel_attach { id } — block until completion (zero token cost).
2. mcp_sentinel_status { action: "status", id } — pull the summary.
3. mcp_sentinel_read { id } — raw poll log when debugging.

Never implement a manual polling loop over the underlying MCP status tool, and
never loop mcp_sentinel_status — both defeat the sentinel's purpose.
