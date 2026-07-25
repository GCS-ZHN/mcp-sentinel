import { evaluateCondition } from "./condition-evaluator.js";
import { getOrCreateClient, callTool } from "./mcp-connection-manager.js";
import { lookupServer } from "./config-reader.js";
import type { PollRequest, PollTask, McpConfig } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

const activePolls = new Map<string, PollTask>();
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

let _client: OpencodeClient | null = null;

export function setNotifyFn(client: OpencodeClient): void {
  _client = client;
}

function generateId(): string {
  return `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function startPoll(request: PollRequest, mcpConfig: McpConfig): Promise<string> {
  const id = generateId();
  const interval = request.interval ?? 5000;
  const timeout = request.timeout; // undefined = no limit

  const serverConfig = lookupServer(mcpConfig, request.server);
  if (!serverConfig) {
    throw new Error(`Unknown MCP server: ${request.server}`);
  }

  const task: PollTask = {
    id,
    request,
    createdAt: Date.now(),
    pollCount: 0,
    lastResult: null,
    status: "polling",
  };

  activePolls.set(id, task);

  const poll = async () => {
    const t = activePolls.get(id);
    if (!t || t.status !== "polling") return;

    try {
      const client = await getOrCreateClient(request.server, serverConfig);
      const result = await callTool(client, request.tool, request.args);

      t.pollCount++;
      t.lastResult = result;

      if (evaluateCondition(request.until, result)) {
        await resolvePoll(id, result);
        return;
      }
    } catch (err) {
      t.status = "error";
      t.error = String(err);
      t.resolvedAt = Date.now();
      stopTimers(id);
      await notify(id, request.sessionID, "failed", String(err));
    }

    if (timeout && Date.now() - t.createdAt >= timeout) {
      t.status = "timeout";
      t.resolvedAt = Date.now();
      stopTimers(id);
      await notify(id, request.sessionID, "timeout", null);
    }
  };

  const timer = setInterval(poll, interval);
  activeTimers.set(id, timer);

  void poll();

  return id;
}

async function resolvePoll(id: string, result: unknown): Promise<void> {
  const task = activePolls.get(id);
  if (!task) return;

  task.status = "completed";
  task.resolvedAt = Date.now();
  task.lastResult = result;
  stopTimers(id);

  await notify(id, task.request.sessionID, "completed", result);
}

async function notify(
  id: string,
  sessionID: string,
  type: "completed" | "failed" | "timeout",
  data: unknown
): Promise<void> {
  const task = activePolls.get(id);
  if (!task || !_client) return;

  if (!sessionID) return;

  let text: string;
  switch (type) {
    case "completed":
      text = `## Sentinel Poll Complete\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Duration:** ${((task.resolvedAt! - task.createdAt) / 1000).toFixed(1)}s\n**Result:**\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
      break;
    case "failed":
      text = `## Sentinel Poll Failed\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Error:** ${data}`;
      break;
    case "timeout":
      text = `## Sentinel Poll Timeout\n\n**Server:** ${task.request.server}\n**Tool:** ${task.request.tool}\n**Poll count:** ${task.pollCount}\n**Last result:**\n\`\`\`json\n${JSON.stringify(task.lastResult, null, 2)}\n\`\`\``;
      break;
  }

  try {
    await _client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ id: `prt-sentinel-${id}-${Date.now()}`, type: "text", text }],
      },
    });
  } catch {
    // prompt notification failure is non-fatal
  }
}

function stopTimers(id: string): void {
  const timer = activeTimers.get(id);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

export function cancelPoll(id: string): boolean {
  const task = activePolls.get(id);
  if (!task || task.status !== "polling") return false;

  task.status = "completed";
  task.resolvedAt = Date.now();
  stopTimers(id);
  return true;
}

export function getPollTask(id: string): PollTask | undefined {
  return activePolls.get(id);
}

export function getActivePolls(): PollTask[] {
  return Array.from(activePolls.values()).filter((t) => t.status === "polling");
}

export function cleanup(): void {
  for (const [id] of activeTimers) {
    stopTimers(id);
  }
  activePolls.clear();
}
