import { describe, it, expect } from "bun:test";
import { extractToolResult } from "../src/index.js";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";

function success(value: unknown, content: unknown[]): ToolExecutionResult {
  return { isError: false, value, content } as unknown as ToolExecutionResult;
}

function failure(message: string, code?: string): ToolExecutionResult {
  const error = code ? { message, info: { name: "x", code } } : { message };
  return { isError: true, error } as unknown as ToolExecutionResult;
}

describe("extractToolResult", () => {
  it("parses a JSON text block from the rendered content", () => {
    const result = success({ content: [{ type: "text", text: '{"status":"completed"}' }] }, [
      { type: "text", text: '{"status":"completed"}' },
    ]);
    expect(extractToolResult(result)).toEqual({ status: "completed" });
  });

  it("returns a lone non-JSON text block verbatim", () => {
    const result = success({ content: [] }, [{ type: "text", text: "completed" }]);
    expect(extractToolResult(result)).toBe("completed");
  });

  it("prefers structuredContent when present", () => {
    const result = success({ content: [], structuredContent: { ok: true } }, [
      { type: "text", text: "" },
    ]);
    expect(extractToolResult(result)).toEqual({ ok: true });
  });

  it("throws with the error code on failure", () => {
    const result = failure("Tool not found", "UNKNOWN_TOOL");
    expect(() => extractToolResult(result)).toThrow("UNKNOWN_TOOL: Tool not found");
  });

  it("throws with the message when no code", () => {
    const result = failure("boom");
    expect(() => extractToolResult(result)).toThrow("boom");
  });
});
