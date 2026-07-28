/**
 * Mock CI/CD MCP server — supports both stdio and Streamable HTTP transports.
 *
 * --transport stdio  (default): stdio mode, as before
 * --transport http   : Streamable HTTP on port 19879, session expires after N tool calls
 *
 * get_job_status: auto-advances a simulated job on each poll.
 * Progresses through 8 stages over ~16 polls before completing.
 *
 * In HTTP mode, session expires after EXPIRE_AFTER tool calls, producing
 * the exact "Session not found" / 404 error from the SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const STAGES = [
  "init",
  "lint",
  "build",
  "unit-test",
  "integration-test",
  "package",
  "deploy-staging",
  "deploy-prod",
];
const POLLS_PER_STAGE = 2;
const RUNNING_POLLS = STAGES.length * POLLS_PER_STAGE;

const EXPIRY_PORT = 19879;
const EXPIRE_AFTER_TOOL_CALLS = 3;

let globalPollCount = 0;
let serverStartTime = Date.now();

function createServer() {
  const server = new McpServer(
    { name: "mock-ci-cd", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "submit_job",
    {
      description:
        "Submit a CI job. Returns a job_id immediately. The job progresses asynchronously through multiple stages — poll get_job_status to track completion.",
      inputSchema: z
        .object({
          name: z.string().describe("Job name"),
        })
        .strict(),
    },
    async ({ name }) => {
      const id = `job-${Date.now()}`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              job_id: id,
              name,
              status: "pending",
              progress: 0,
              stages: STAGES.length,
              message: `Job '${name}' submitted. Poll get_job_status to track ${STAGES.length} stages.`,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_job_status",
    {
      description:
        "Get the current status of a CI job. Progresses automatically on each call through 8 stages. Works with any job_id — state advances globally per poll.",
      inputSchema: z
        .object({
          job_id: z.string().describe("The job ID to check"),
        })
        .strict(),
    },
    async ({ job_id }) => {
      globalPollCount++;

      const elapsed = ((Date.now() - serverStartTime) / 1000).toFixed(1);

      if (globalPollCount <= RUNNING_POLLS) {
        const currentStageIdx = Math.min(
          Math.floor((globalPollCount - 1) / POLLS_PER_STAGE),
          STAGES.length - 1
        );
        const stageProgress = ((globalPollCount - 1) % POLLS_PER_STAGE) + 1;
        const progress = Math.round((globalPollCount / (RUNNING_POLLS + 1)) * 100);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                job_id,
                status: "running",
                progress,
                current_stage: STAGES[currentStageIdx],
                stage_progress: `${stageProgress}/${POLLS_PER_STAGE}`,
                steps: buildSteps(globalPollCount),
                poll_count: globalPollCount,
                elapsed_seconds: elapsed,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              job_id,
              status: "completed",
              progress: 100,
              steps: STAGES.map((name) => ({ name, status: "completed", exit_code: 0 })),
              poll_count: globalPollCount,
              elapsed_seconds: elapsed,
            }),
          },
        ],
      };
    }
  );

  return server;
}

function buildSteps(
  currentPoll: number
): Array<{ name: string; status: string; exit_code: number | null }> {
  return STAGES.map((name, i) => {
    const stageStart = i * POLLS_PER_STAGE;
    const stageEnd = stageStart + POLLS_PER_STAGE;
    if (currentPoll > stageEnd) {
      return { name, status: "completed", exit_code: 0 };
    }
    if (currentPoll > stageStart) {
      return { name, status: "running", exit_code: null };
    }
    return { name, status: "pending", exit_code: null };
  });
}

// --- Streamable HTTP mode with session expiry ---
// The MCP SDK's WebStandardStreamableHTTPServerTransport manages sessions
// internally and doesn't easily support forced expiry. Instead we implement
// a minimal Streamable HTTP server that accepts initialize requests, creates
// sessions, and expires them after EXPIRE_AFTER tool calls by returning
// 404 "Session not found" — the exact signal from the issue.
async function startHttpServer() {
  let requestCount = 0;
  const sessions = new Map<string, { callCount: number }>();

  Bun.serve({
    port: EXPIRY_PORT,
    async fetch(req) {
      requestCount++;
      const sessionId = req.headers.get("mcp-session-id");
      const accept = req.headers.get("accept");

      let body: any;
      try {
        body = await req.json();
      } catch {
        body = {};
      }

      console.error(
        `[mock-http] #${requestCount} ${req.method} sess=${sessionId?.slice(0, 8) ?? "-"} method=${body.method ?? "-"} accept=${accept?.slice(0, 30) ?? "-"}`
      );

      // MCP Streamable HTTP spec: GET for SSE streaming.
      // We don't support SSE — reject with 405 per spec.
      if (req.method === "GET") {
        return new Response("SSE not supported", { status: 405 } as any);
      }

      try {
        if (!sessionId) {
          const newId = `mock-sess-${Date.now()}-${requestCount}`;
          sessions.set(newId, { callCount: 0 });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 0,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-ci-cd", version: "1.0.0" },
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Mcp-Session-Id": newId,
              },
            } as any
          );
        }

        let session = sessions.get(sessionId);
        if (!session) {
          // Unknown session — let server handle it with 404
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "server-error",
              error: { code: -32600, message: "Session not found" },
            }),
            { status: 404, headers: { "Content-Type": "application/json" } } as any
          );
        }

        const isToolCall = body.method === "tools/call";

        if (isToolCall) {
          session.callCount++;

          if (session.callCount > EXPIRE_AFTER_TOOL_CALLS) {
            sessions.delete(sessionId);
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "server-error",
                error: { code: -32600, message: "Session not found" },
              }),
              { status: 404, headers: { "Content-Type": "application/json" } } as any
            );
          }
        }

        // Handle tool execution using the actual McpServer logic
        // (we parse method/params and route to our tool implementations)
        let toolResult: any;
        if (body.method === "tools/call") {
          const { name, arguments: args } = body.params ?? {};
          if (name === "submit_job") {
            const id = `job-${Date.now()}`;
            toolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    job_id: id,
                    name: args?.name,
                    status: "pending",
                    progress: 0,
                    stages: STAGES.length,
                  }),
                },
              ],
            };
          } else if (name === "get_job_status") {
            globalPollCount++;
            const elapsed = ((Date.now() - serverStartTime) / 1000).toFixed(1);
            const complete = globalPollCount > RUNNING_POLLS;
            const currentStageIdx = complete
              ? STAGES.length - 1
              : Math.min(Math.floor((globalPollCount - 1) / POLLS_PER_STAGE), STAGES.length - 1);
            toolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    job_id: args?.job_id,
                    status: complete ? "completed" : "running",
                    progress: complete
                      ? 100
                      : Math.round((globalPollCount / (RUNNING_POLLS + 1)) * 100),
                    current_stage: complete ? undefined : STAGES[currentStageIdx],
                    steps: buildSteps(globalPollCount),
                    poll_count: globalPollCount,
                    elapsed_seconds: elapsed,
                  }),
                },
              ],
            };
          } else {
            toolResult = {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            };
          }
        } else if (body.method === "tools/list") {
          toolResult = {
            tools: [
              {
                name: "submit_job",
                description: "Submit a CI job.",
                inputSchema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
              {
                name: "get_job_status",
                description: "Get the current status of a CI job.",
                inputSchema: {
                  type: "object",
                  properties: { job_id: { type: "string" } },
                  required: ["job_id"],
                },
              },
            ],
          };
        } else if (body.method === "notifications/initialized") {
          // Just acknowledge
          return new Response(null, {
            status: 202,
            headers: { "Mcp-Session-Id": sessionId },
          } as any);
        } else {
          // Generic success for other protocol messages (ping, etc.)
          toolResult = {};
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 0,
            result: toolResult,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Mcp-Session-Id": sessionId,
            },
          } as any
        );
      } catch (err) {
        console.error("Mock server fetch error:", err);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: `Internal error: ${String(err)}` },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } } as any
        );
      }
    },
  });

  console.error(`Mock MCP Streamable HTTP server started on port ${EXPIRY_PORT}`);
  console.error(`Session expires after ${EXPIRE_AFTER_TOOL_CALLS} tool calls`);
}

// --- Entry point ---
const transportArg = Bun.argv[2];

if (transportArg === "--transport=http") {
  await startHttpServer();
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
