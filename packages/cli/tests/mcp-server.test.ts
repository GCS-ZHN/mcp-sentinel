/**
 * Integration tests for the sentinel CLI MCP server.
 *
 * Boots the built `cli.js mcp --harness custom --mcp-config <file>` over stdio
 * (the exact artifact a harness would launch) and drives it with an MCP client
 * to verify tool registration, handler wiring, and a full poll against a real
 * stdio MCP server via the custom config.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI_PATH = join(import.meta.dir, "..", "cli.js");
// Portable: spawn mock-ci with the bun binary running these tests (CI installs
// bun outside the macOS Homebrew path).
const BUN_BIN = process.execPath;
const MOCK_SERVER_PATH = join(import.meta.dir, "..", "..", "core", "tests", "mock-mcp-server.ts");

let client: Client | null = null;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractText(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

describe.skipIf(!existsSync(CLI_PATH))("cli mcp stdio integration", () => {
  beforeAll(async () => {
    const projectDir = makeTempDir("cli-project-");
    const mcpConfigFile = join(projectDir, "mcp.json");
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        servers: {
          "mock-ci": {
            type: "local",
            command: [BUN_BIN, MOCK_SERVER_PATH],
            enabled: true,
          },
        },
      })
    );

    const transport = new StdioClientTransport({
      command: "bun",
      args: [CLI_PATH, "mcp", "--harness", "custom", "--mcp-config", mcpConfigFile],
      cwd: projectDir,
      env: { ...process.env },
    });

    client = new Client({ name: "cli-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    client = null;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the mcp_sentinel_* tools", async () => {
    const tools = await client!.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "mcp_sentinel_attach",
      "mcp_sentinel_poll",
      "mcp_sentinel_read",
      "mcp_sentinel_set_notifier_commands",
      "mcp_sentinel_status",
    ]);
  });

  it("mcp_sentinel_set_notifier_commands installs a command notifier", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_set_notifier_commands",
      arguments: { commands: ['echo "{}"'] },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toContain("Command notifier installed");
  });

  it("mcp_sentinel_set_notifier_commands rejects a missing placeholder", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_set_notifier_commands",
      arguments: { commands: ["no placeholder here"] },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toContain('exactly one "{}"');
  });

  it("mcp_sentinel_status action=list reports no active tasks", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_status",
      arguments: { action: "list" },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toBe("No active sentinel tasks.");
  });

  it("mcp_sentinel_poll returns a clean error for an empty server", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_poll",
      arguments: {
        server: "",
        tool: "get_job_status",
        until: { path: "status", is: "eq", value: "completed" },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toBe("Error: server and tool must be non-empty strings.");
  });

  it("mcp_sentinel_poll returns a clean error for an unknown server", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_poll",
      arguments: {
        server: "nonexistent",
        tool: "get_job_status",
        until: { path: "status", is: "eq", value: "completed" },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toBe("Error: Unknown MCP server: nonexistent");
  });

  it("mcp_sentinel_poll returns a clean error for a non-object until", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_poll",
      arguments: {
        server: "mock-ci",
        tool: "get_job_status",
        until: "not-an-object",
      },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toBe("Error: until must be a JSON object describing a condition.");
  });

  it("runs a full poll against a real stdio MCP server", async () => {
    const result = await client!.callTool({
      name: "mcp_sentinel_poll",
      arguments: {
        server: "mock-ci",
        tool: "get_job_status",
        args: { job_id: "e2e" },
        interval: 1000,
        until: { path: "status", is: "eq", value: "running" },
      },
    });
    expect(result.isError).toBeUndefined();
    const started = extractText(result);
    expect(started).toContain("Sentinel started.");

    const id = started.match(/\*\*ID:\*\* `([^`]+)`/)?.[1];
    expect(id).toBeTruthy();

    let statusText = "";
    for (let i = 0; i < 40; i++) {
      const status = await client!.callTool({
        name: "mcp_sentinel_status",
        arguments: { action: "status", id },
      });
      statusText = extractText(status);
      if (statusText.includes("**Status:** completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(statusText).toContain("**Status:** completed");
  });
  // mock-ci needs ~16 polls to reach "completed"; with interval=1000 that is
  // ~16s, so give this case a generous timeout instead of the 5s default.
  it("runs the per-session command notifier when polled with notifier_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-notifier-"));
    tempDirs.push(dir);
    const out = join(dir, "notified.txt");
    const notifier = await client!.callTool({
      name: "mcp_sentinel_set_notifier_commands",
      arguments: { commands: ["printf '%s' '{}' > " + out] },
    });
    expect(notifier.isError).toBeUndefined();
    const notifierText = extractText(notifier);
    const notifierId = notifierText.split("**notifier_id:** `")[1].split("`")[0];
    expect(notifierId).toMatch(/^[0-9a-f-]{36}$/);
    const result = await client!.callTool({
      name: "mcp_sentinel_poll",
      arguments: { server: "mock-ci", tool: "get_job_status", args: { job_id: "e2e-notify" }, interval: 1000, notifier_id: notifierId, until: { path: "status", is: "eq", value: "completed" } },
    });
    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toContain("Sentinel started.");
    const id = extractText(result).match(/\*\*ID:\*\* `([^`]+)`/)?.[1];
    expect(id).toBeTruthy();
    let statusText = "";
    // mock-ci needs ~16 polls to reach "completed"; allow up to 22s (> 90x250ms).
    for (let i = 0; i < 90; i++) {
      const status = await client!.callTool({
        name: "mcp_sentinel_status",
        arguments: { action: "status", id },
      });
      statusText = extractText(status);
      if (statusText.includes("**Status:** completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(statusText).toContain("**Status:** completed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readFileSync(out, "utf8")).toContain("Sentinel Complete");
  }, 30_000);
});
