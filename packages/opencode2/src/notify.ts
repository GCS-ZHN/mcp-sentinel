/**
 * OpenCode 2 (V2) harness — completion notification text.
 *
 * The message format is host-specific and therefore lives in the adapter, not
 * in the core. It is delivered through the V2 session inbox as a synthetic
 * message (see `src/index.ts`), not as a user prompt.
 *
 * @module
 */

import type { SentinelEvent, SentinelTask } from "@gcszhn/mcp-sentinel-core";

/**
 * Build the Markdown notification delivered to the originating session when a
 * sentinel resolves.
 *
 * @param task - The resolved task (already carries `lastResult`/`error`).
 * @param event - The resolution event: `completed`, `failed`, or `timeout`.
 */
export function buildNotificationText(task: SentinelTask, event: SentinelEvent): string {
  switch (event) {
    case "completed":
      return [
        "## Sentinel Complete",
        "",
        `**ID:** \`${task.id}\``,
        `**Server:** ${task.request.server}`,
        `**Tool:** ${task.request.tool}`,
        `**Poll count:** ${task.pollCount}`,
        `**Duration:** ${task.resolvedAt != null ? ((task.resolvedAt - task.createdAt) / 1000).toFixed(1) : "—"}s`,
        "**Result:**",
        "```json",
        JSON.stringify(task.lastResult, null, 2),
        "```",
      ].join("\n");
    case "failed":
      return [
        "## Sentinel Failed",
        "",
        `**ID:** \`${task.id}\``,
        `**Server:** ${task.request.server}`,
        `**Tool:** ${task.request.tool}`,
        `**Poll count:** ${task.pollCount}`,
        `**Error:** ${task.error}`,
      ].join("\n");
    case "timeout":
      return [
        "## Sentinel Timeout",
        "",
        `**ID:** \`${task.id}\``,
        `**Server:** ${task.request.server}`,
        `**Tool:** ${task.request.tool}`,
        `**Poll count:** ${task.pollCount}`,
        "**Last result:**",
        "```json",
        JSON.stringify(task.lastResult, null, 2),
        "```",
      ].join("\n");
  }
}
