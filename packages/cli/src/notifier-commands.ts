/**
 * CLI-only command-based notifier.
 *
 * The generic MCP CLI has no harness message channel, so it installs the command
 * dispatcher via `setNotifier` by default (see `src/mcp-server.ts`) and provides
 * the opt-in `mcp_sentinel_set_notifier_commands`
 * tool. Because the MCP server is loaded globally (shared by all sessions), a
 * single global notifier would cross-talk between sessions. Instead each call
 * registers a command list under a generated `notifier_id` (a uuid) and the
 * agent passes that id to `mcp_sentinel_poll`, which stores it as the task's
 * `sessionID`. A single dispatcher installed via the core's `setNotifier`
 * reads `task.request.sessionID` (the notifier_id) on resolution, looks up that
 * session's command list, and runs it — so messages never leak across sessions.
 *
 * Each command template carries the message where the content goes as a single
 * `{}` placeholder; every other argument must be a concrete literal. Important:
 * environment variables are per-session, but the MCP server is a single global
 * process shared by all sessions. Templates run via a shell (`/bin/sh`) inside the
 * MCP server process, so any `$VAR` in a template resolves against the **server
 * process's** environment — not the agent session's. An agent targeting its own
 * session (e.g. `$CODEX_THREAD_ID`) must read the real value first (`echo $CODEX_THREAD_ID`)
 * and inline it as a literal before registering. This tool never resolves environment
 * variables; only the notification message is injected from `buildNotificationText`.
 * A template may be any command at all — it need not actually send a message
 * (`echo "{}"` is valid).
 *
 * Notification delivery failures are non-fatal: the sentinel task state stays
 * queryable via `mcp_sentinel_attach` / `status` / `read`.
 *
 * @module
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { logError, logInfo } from "@gcszhn/mcp-sentinel-core";
import type { SentinelEvent, SentinelNotifier, SentinelTask } from "@gcszhn/mcp-sentinel-core";

/** Promisified `child_process.exec`, used to run each template through a shell. */
const execAsync = promisify(exec);

/** Default per-command timeout so a hung command never blocks sentinel resolution. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Markdown code fence marker used when embedding a JSON result. */
const CODE_FENCE = "```";

/**
 * Per-session command registries, keyed by `notifier_id` (which is stored as
 * the sentinel task's `request.sessionID`). Each CLI MCP server process is
 * shared across sessions; keying by id keeps each session's notifications
 * isolated (no cross-session leakage).
 */
const notifierRegistry = new Map<string, string[]>();

/**
 * Install (or replace) the command list for a session.
 *
 * This is the per-session side of the notifier contract. It does not touch the
 * core's global notifier — the CLI MCP server already installed a single
 * dispatcher via `setNotifier` that routes by `task.request.sessionID`.
 *
 * @param notifierId - The uuid identifying this session's notifier.
 * @param commands - Validated command templates.
 */
export function registerNotifierCommands(notifierId: string, commands: string[]): void {
  // Defensive: handleSetNotifierCommands always passes a validated string[],
  // but a stray caller might pass a single string. Without this guard,
  // runCommands would for..of the string and execute it char-by-char.
  const list: string[] = typeof commands === "string" ? [commands] : commands;
  notifierRegistry.set(notifierId, list);
}

/**
 * Remove a session's command registry. Used to clear stale state.
 *
 * @param notifierId - The uuid identifying the session's notifier.
 */
export function unregisterNotifierCommands(notifierId: string): void {
  notifierRegistry.delete(notifierId);
}

/**
 * Build the global dispatcher installed via `setNotifier`.
 *
 * On resolution it reads `task.request.sessionID` (the notifier_id the agent
 * passed to `mcp_sentinel_poll`), looks up that session's command list, and
 * runs the templates in order. A task without a matching registry (e.g. the
 * agent never installed a notifier, or registered a different id) is skipped
 * silently.
 *
 * @returns A `SentinelNotifier`.
 */
export function buildCommandNotifierDispatcher(): SentinelNotifier {
  return async (task: SentinelTask, event: SentinelEvent) => {
    const notifierId = task.request.sessionID;
    if (!notifierId) return;
    const commands = notifierRegistry.get(notifierId);
    if (!commands) {
      logInfo("No command list for notifier_id; skipping notification", {
        notifierId,
        sentinel: task.id,
        event,
      });
      return;
    }
    await runCommands(commands, task, event);
  };
}

/**
 * Run a validated command list against a resolved task, injecting the
 * notification message into each template's `{}` placeholder. Failures are
 * logged (via the core logger) and swallowed — they never disturb the sentinel
 * task.
 *
 * @param commands - Validated command templates.
 * @param task - The resolved sentinel task.
 * @param event - The resolution event.
 */
export async function runCommands(
  commands: string[],
  task: SentinelTask,
  event: SentinelEvent
): Promise<void> {
  const message = buildNotificationText(task, event);
  for (const template of commands) {
    const command = hydrateCommandTemplate(template, message);
    logInfo("Running notifier command", {
      command,
      sentinel: task.id,
      notifierId: task.request.sessionID,
      event,
    });
    try {
      const { stdout, stderr } = await execAsync(command, {
        shell: "/bin/sh",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout.trim()) {
        logInfo("Notifier command output", { output: stdout.trim(), sentinel: task.id });
      }
      if (stderr.trim()) {
        logInfo("Notifier command stderr", { output: stderr.trim(), sentinel: task.id });
      }
    } catch (err) {
      logError("Notifier command failed", { command, sentinel: task.id, error: String(err) });
    }
  }
}

/** Parameter description for the `commands` argument of the notifier tool. */
export const NOTIFIER_COMMANDS_DESCRIPTION =
  'A non-empty list of command templates. Each template must contain exactly one `{}` placeholder where the notification message is injected; all other arguments are concrete literals. Environment variables are session-scoped but the MCP server is a shared global process, so do NOT rely on `$VAR` in a template - read the real value first (e.g. `echo $CODEX_THREAD_ID`) and inline it, e.g. `codex queue --thread "<real-thread-id>" --message "{}"`.';

/** Tool-level description for `mcp_sentinel_set_notifier_commands`. */
export const SET_NOTIFIER_TOOL_DESCRIPTION =
  "Install a command-based notification handler.\n\n" +
  "The CLI has no harness message channel by default, so background sentinel " +
  "completions are collected via mcp_sentinel_attach / status / read. This tool " +
  "registers a notifier that, when a sentinel resolves, builds a notification " +
  "message and runs each command template in order to deliver it.\n\n" +
  "Recommended: set up a notifier and pass its notifier_id to mcp_sentinel_poll so " +
  "the sentinel notifies you (e.g. messages your thread) on completion. Only fall back " +
  "to blocking mcp_sentinel_attach if you cannot or do not know how to configure a " +
  "notifier - and loop mcp_sentinel_status as a last resort.\n\n" +
  "Parameters:\n" +
  "- commands: " +
  NOTIFIER_COMMANDS_DESCRIPTION +
  "\n\n" +
  "Examples:\n" +
  '  - codex queue --thread "<thread-id-read-from-echo>" --message "{}"\n' +
  '  - echo "{}"\n' +
  '  - notify-send "Sentinel" "{}"\n\n' +
  "Each command is run through a shell. The message is substituted verbatim into " +
  'the single "{}" placeholder - quote it in the template so it is passed as one ' +
  "argument. Command failures are logged but never affect the sentinel task state.\n\n" +
  "Because the message may contain quotes, backticks and `$` (e.g. a JSON result wrapped " +
  "in a markdown code fence), wrap the `{}` placeholder in single quotes - e.g. " +
  "`printf '%s' '{}'` or `codex queue --message '{}'`. With double quotes the shell " +
  "would interpret `$` and backticks inside the message as substitutions.\n\n" +
  "IMPORTANT: The shell executes inside the MCP server process, which is global and " +
  "shared by all sessions. Any $VAR in a template resolves against that process's " +
  "environment, NOT your session's - this tool does not resolve environment variables. " +
  "Read the real value in your session (e.g. `echo $CODEX_THREAD_ID`) and inline it as a " +
  "literal before registering.\n\n" +
  "Case study - self-notify your own Codex thread:\n" +
  "In a Codex session an agent can read its thread id with `echo $CODEX_THREAD_ID`. " +
  "To have a sentinel message that thread on completion, read the id and register " +
  '`codex queue --thread "<your-thread-id>" --message "{}"` as the command list. ' +
  "The agent resolves the id itself and passes it in as a literal - the notifier never " +
  "resolves it. Use cases are just commands (notify, webhook, hello, ...); a template " +
  'need not send a message at all (`echo "{}"` is sufficient).';
/**
 * Build the notification message for a resolved sentinel.
 *
 * This is the text substituted into each command template's `{}` placeholder.
 * Mirrors the markdown summary the host-specific harnesses deliver.
 *
 * @param task - The resolved sentinel task.
 * @param event - The resolution event.
 * @returns The markdown notification message.
 */
export function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return `## Sentinel Complete

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Duration:** ${task.resolvedAt != null ? ((task.resolvedAt - task.createdAt) / 1000).toFixed(1) : "—"}s
**Result:**
${CODE_FENCE}json
${JSON.stringify(task.lastResult, null, 2)}
${CODE_FENCE}`;
    case "failed":
      return `## Sentinel Failed

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Error:** ${task.error}`;
    case "timeout":
      return `## Sentinel Timeout

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}
**Last result:**
${CODE_FENCE}json
${JSON.stringify(task.lastResult, null, 2)}
${CODE_FENCE}`;
    default:
      return `## Sentinel ${event}

**Server:** ${task.request.server}
**Tool:** ${task.request.tool}
**Poll count:** ${task.pollCount}`;
  }
}

/**
 * Substitute the notification message into a command template.
 *
 * Replaces the single `{}` placeholder with `message`. The replacer function
 * (rather than a string argument) means `$` sequences in the message — e.g. a
 * JSON result containing `$&"` — are inserted verbatim, never interpreted as
 * substitution patterns. A template with zero or more than one `{}` placeholder
 * is rejected by `validateNotifierCommands` before this is ever called.
 *
 * @param template - Command template containing exactly one `{}`.
 * @param message - The notification message to inject.
 * @returns The executable command string.
 */
export function hydrateCommandTemplate(template: string, message: string): string {
  return template.replace("{}", () => message);
}

/**
 * Validate a command list returned by the MCP tool.
 *
 * Enforces: a non-empty array, every entry a non-empty string, and every
 * template containing exactly one `{}` placeholder. Returns `null` when valid,
 * otherwise a clear `"Error: ..."` string for the agent.
 *
 * @param commands - The raw command list from the tool call.
 * @returns `null` if valid, or an error string.
 */
export function validateNotifierCommands(commands: unknown): string | null {
  if (!Array.isArray(commands) || commands.length === 0) {
    return "Error: commands must be a non-empty array of command template strings.";
  }
  for (const [index, template] of commands.entries()) {
    if (typeof template !== "string" || template.trim() === "") {
      return `Error: commands[${index}] must be a non-empty string.`;
    }
    const placeholders = template.split("{}").length - 1;
    if (placeholders !== 1) {
      return `Error: commands[${index}] must contain exactly one "{}" placeholder (found ${placeholders}).`;
    }
  }
  return null;
}

/**
 * `mcp_sentinel_set_notifier_commands` handler.
 *
 * Validates the command list, generates a `notifier_id` (a uuid) for this
 * session, and registers the list under it. It does not call the core's
 * `setNotifier` directly — the CLI MCP server already installed the global
 * dispatcher (`buildCommandNotifierDispatcher`) at startup. The agent passes
 * the returned `notifier_id` to `mcp_sentinel_poll`, which stores it as the
 * task's `sessionID`; the dispatcher reads that on resolution.
 *
 * @param commands - Command templates to run on sentinel resolution.
 * @returns A confirmation carrying the `notifier_id`, or an `"Error: ..."` message.
 */
export function handleSetNotifierCommands(commands: unknown): string {
  const validationError = validateNotifierCommands(commands);
  if (validationError) return validationError;

  const list = commands as string[];
  const notifierId = randomUUID();
  registerNotifierCommands(notifierId, list);

  const templates = list.map((c) => "- " + c).join("\n");
  return (
    "Command notifier installed.\n\n**notifier_id:** `" +
    notifierId +
    "`\n**Templates:** " +
    list.length +
    "\n\n" +
    templates
  );
}
