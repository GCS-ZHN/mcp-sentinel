import { describe, it, expect } from "bun:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolBatchResult, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { extractSingleResult } from "../src/index.js";

function success(value: unknown, content: unknown[]): ToolExecutionResult {
  return { isError: false, value, content } as unknown as ToolExecutionResult;
}

function failure(message: string, code?: string): ToolExecutionResult {
  const error = code ? { message, info: { name: "x", code } } : { message };
  return { isError: true, error } as unknown as ToolExecutionResult;
}

function batch(result: ToolExecutionResult): ToolBatchResult {
  return {
    results: [{ callId: ToolCallId("call-1"), result }],
    additionalContexts: [],
    concluded: false,
  };
}

describe("extractSingleResult", () => {
  it("extracts the only settled result from a batch", () => {
    const result = success({ content: [{ type: "text", text: '{"status":"completed"}' }] }, [
      { type: "text", text: '{"status":"completed"}' },
    ]);
    expect(extractSingleResult(batch(result))).toEqual({ status: "completed" });
  });

  it("throws with the error code when the only call failed", () => {
    const result = failure("unknown tool", "UNKNOWN_TOOL");
    expect(() => extractSingleResult(batch(result))).toThrow("UNKNOWN_TOOL: unknown tool");
  });

  it("throws a clear error when the batch contains no result", () => {
    const empty: ToolBatchResult = { results: [], additionalContexts: [], concluded: false };
    expect(() => extractSingleResult(empty)).toThrow(
      "tool execution returned no result for the sentinel call"
    );
  });
});
