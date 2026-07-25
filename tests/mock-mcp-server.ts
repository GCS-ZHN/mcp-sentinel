/**
 * Mock CI/CD MCP server — self-contained, no shared state needed.
 *
 * get_job_status: auto-advances a simulated job on each poll.
 * Progresses through 8 stages over ~16 polls before completing.
 *
 * Any job_id works — state is derived from poll count since server start.
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
const POLLS_PER_STAGE = 2; // ~2 polls per stage for realistic pacing
const RUNNING_POLLS = STAGES.length * POLLS_PER_STAGE;

let globalPollCount = 0;
let serverStartTime = Date.now();

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

const transport = new StdioServerTransport();
await server.connect(transport);
