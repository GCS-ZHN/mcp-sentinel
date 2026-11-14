import { describe, it, expect } from "bun:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolBatchInput, ToolBatchResult, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import {
  PASS_AGENT_ENV,
  assertToolVisibleToAgent,
  makeDshInvoker,
  passAgentModeFromEnv,
  resolveExecutionAgent,
} from "../src/index.js";
import type { DshInvokerDeps } from "../src/index.js";

const agent = { id: "session-1", session: {} } as unknown as Agent;

function successBatch(callId: ReturnType<typeof ToolCallId>): ToolBatchResult {
  const result: ToolExecutionResult = {
    isError: false,
    value: { content: [{ type: "text", text: '{"status":"running"}' }] },
    content: [{ type: "text", text: '{"status":"running"}' }],
  };
  return { results: [{ callId, result }], additionalContexts: [], concluded: false };
}

function failureBatch(
  callId: ReturnType<typeof ToolCallId>,
  code: string,
  message: string
): ToolBatchResult {
  const result: ToolExecutionResult = {
    isError: true,
    error: { message, info: { name: "test", code } },
    content: [{ type: "text", text: `Error: ${message}` }],
  };
  return { results: [{ callId, result }], additionalContexts: [], concluded: false };
}

function deps(overrides: Partial<DshInvokerDeps> = {}): {
  readonly value: DshInvokerDeps;
  readonly captured: () => ToolBatchInput | undefined;
  readonly agentless: () => number;
} {
  let captured: ToolBatchInput | undefined;
  let agentless = 0;
  const value: DshInvokerDeps = {
    async execute(input) {
      captured = input;
      const call = input.calls[0];
      if (call === undefined) throw new Error("test batch had no call");
      return successBatch(call.id);
    },
    tools: { get: () => ({}) },
    agents: { get: () => agent },
    passAgent: "never",
    presetOf: () => undefined,
    onAgentless: () => {
      agentless += 1;
    },
    ...overrides,
  };
  return { value, captured: () => captured, agentless: () => agentless };
}

describe("passAgentModeFromEnv", () => {
  it("defaults to auto when unset or empty", () => {
    expect(passAgentModeFromEnv(undefined)).toBe("auto");
    expect(passAgentModeFromEnv("")).toBe("auto");
    expect(passAgentModeFromEnv("  ")).toBe("auto");
  });

  it("accepts the explicit auto mode", () => {
    expect(passAgentModeFromEnv("auto")).toBe("auto");
    expect(passAgentModeFromEnv("AUTO")).toBe("auto");
  });

  it("accepts every always alias", () => {
    for (const value of ["always", "1", "true", "on", "ALWAYS"]) {
      expect(passAgentModeFromEnv(value)).toBe("always");
    }
  });

  it("accepts every never alias", () => {
    for (const value of ["never", "0", "false", "off", "NEVER"]) {
      expect(passAgentModeFromEnv(value)).toBe("never");
    }
  });

  it("fails loudly on an unknown value", () => {
    expect(() => passAgentModeFromEnv("sometimes")).toThrow(PASS_AGENT_ENV);
  });
});

describe("resolveExecutionAgent", () => {
  it("returns undefined without an agent", () => {
    expect(resolveExecutionAgent(undefined, "always", "auto")).toBeUndefined();
  });

  it("honors the never override", () => {
    expect(resolveExecutionAgent(agent, "never", "danger-full-access")).toBeUndefined();
  });

  it("honors the always override", () => {
    expect(resolveExecutionAgent(agent, "always", "auto")).toBe(agent);
  });

  it("drops the agent only on the Auto preset in auto mode", () => {
    expect(resolveExecutionAgent(agent, "auto", "auto")).toBeUndefined();
    expect(resolveExecutionAgent(agent, "auto", "danger-full-access")).toBe(agent);
    expect(resolveExecutionAgent(agent, "auto", undefined)).toBe(agent);
  });
});

describe("assertToolVisibleToAgent", () => {
  it("accepts a tool visible to the agent", () => {
    expect(() => assertToolVisibleToAgent({ get: () => ({}) }, "tool", agent)).not.toThrow();
  });

  it("rejects a tool the agent is restricted from", () => {
    const tools = {
      get: (_name: string, scope?: Agent) => (scope === undefined ? {} : undefined),
    };
    expect(() => assertToolVisibleToAgent(tools, "tool", agent)).toThrow(
      'tool "tool" is not available to this agent'
    );
  });

  it("lets an unknown tool reach the executor for its raw UNKNOWN_TOOL error", () => {
    expect(() => assertToolVisibleToAgent({ get: () => undefined }, "tool", agent)).not.toThrow();
  });
});

describe("makeDshInvoker", () => {
  it("runs without an agent in never mode", async () => {
    const state = deps({ passAgent: "never" });
    const result = await makeDshInvoker(state.value)(
      "mock-ci",
      "get_job_status",
      {},
      {
        sessionID: "session-1",
      }
    );
    expect(result).toEqual({ status: "running" });
    expect(state.captured()?.agent).toBeUndefined();
    expect(state.captured()?.calls[0]?.name).toBe("mcp__mock-ci__get_job_status");
    expect(state.agentless()).toBe(0);
  });

  it("passes the agent when always mode resolves it", async () => {
    const state = deps({ passAgent: "always" });
    await makeDshInvoker(state.value)(
      "mock-ci",
      "get_job_status",
      {},
      {
        sessionID: "session-1",
      }
    );
    expect(state.captured()?.agent).toBe(agent);
  });

  it("drops the agent on the Auto preset in auto mode", async () => {
    const state = deps({ passAgent: "auto", presetOf: () => "auto" });
    await makeDshInvoker(state.value)(
      "mock-ci",
      "get_job_status",
      {},
      {
        sessionID: "session-1",
      }
    );
    await makeDshInvoker(state.value)(
      "mock-ci",
      "submit_job",
      {},
      {
        sessionID: "session-1",
      }
    );
    expect(state.captured()?.agent).toBeUndefined();
    expect(state.agentless()).toBe(2);
  });

  it("keeps the agent on a non-Auto preset in auto mode", async () => {
    const state = deps({ passAgent: "auto", presetOf: () => "danger-full-access" });
    await makeDshInvoker(state.value)(
      "mock-ci",
      "get_job_status",
      {},
      {
        sessionID: "session-1",
      }
    );
    expect(state.captured()?.agent).toBe(agent);
    expect(state.agentless()).toBe(0);
  });

  it("refuses an agent-restricted tool instead of bypassing the mask", async () => {
    let executed = false;
    const state = deps({
      passAgent: "never",
      tools: {
        get: (_name, scope) => {
          if (scope === undefined) return {};
          return undefined;
        },
      },
      execute: async () => {
        executed = true;
        return successBatch(ToolCallId("call-1"));
      },
    });
    await expect(
      makeDshInvoker(state.value)("mock-ci", "get_job_status", {}, { sessionID: "session-1" })
    ).rejects.toThrow('tool "mcp__mock-ci__get_job_status" is not available to this agent');
    expect(executed).toBe(false);
  });

  it("preserves a raw UNKNOWN_TOOL failure from the executor", async () => {
    const state = deps({
      passAgent: "never",
      tools: { get: () => undefined },
      execute: async () => failureBatch(ToolCallId("call-1"), "UNKNOWN_TOOL", "unknown tool"),
    });
    await expect(
      makeDshInvoker(state.value)("mock-ci", "get_job_status", {}, { sessionID: "session-1" })
    ).rejects.toThrow("UNKNOWN_TOOL: unknown tool");
  });
});
