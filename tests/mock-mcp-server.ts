/**
 * Mock CI/CD MCP server — self-contained, no shared state needed.
 *
 * get_job_status: auto-advances a simulated job on each poll.
 *   - Polls 1-4: running (progress 20→40→60→80)
 *   - Poll 5+: completed (progress 100)
 *
 * Any job_id works — state is derived from poll count since server start.
 * This makes it compatible with poll_mcp which starts an independent
 * stdio connection.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

let globalPollCount = 0;

const server = new McpServer(
  { name: "mock-ci-cd", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "submit_job",
  {
    description:
      "Submit a CI job. Returns a job_id immediately. The job progresses asynchronously — poll get_job_status to track completion.",
    inputSchema: {
      name: z.string().describe("Job name"),
    },
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
            message: `Job '${name}' submitted. Use get_job_status to poll.`,
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
      "Get the current status of a CI job. Progresses automatically on each call (simulating real async work). Works with any job_id — state advances globally per poll.",
    inputSchema: {
      job_id: z.string().describe("The job ID to check"),
    },
  },
  async ({ job_id }) => {
    globalPollCount++;

    if (globalPollCount <= 4) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              job_id,
              status: "running",
              progress: globalPollCount * 20,
              steps: [
                {
                  name: "lint",
                  status: globalPollCount >= 1 ? "completed" : "running",
                  exit_code: 0,
                },
                {
                  name: "build",
                  status: globalPollCount >= 2 ? "completed" : "pending",
                  exit_code: globalPollCount >= 2 ? 0 : null,
                },
                {
                  name: "test",
                  status: globalPollCount >= 3 ? "completed" : "pending",
                  exit_code: globalPollCount >= 3 ? 0 : null,
                },
                {
                  name: "deploy",
                  status: globalPollCount >= 4 ? "completed" : "pending",
                  exit_code: globalPollCount >= 4 ? 0 : null,
                },
              ],
              poll_count: globalPollCount,
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
            steps: [
              { name: "lint", status: "completed", exit_code: 0 },
              { name: "build", status: "completed", exit_code: 0 },
              { name: "test", status: "completed", exit_code: 0 },
              { name: "deploy", status: "completed", exit_code: 0 },
            ],
            poll_count: globalPollCount,
          }),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
