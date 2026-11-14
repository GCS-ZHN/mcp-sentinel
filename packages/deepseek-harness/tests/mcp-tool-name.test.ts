import { describe, it, expect } from "bun:test";
import { mcpToolName } from "../src/index.js";

describe("mcpToolName", () => {
  it("keeps a clean identity verbatim", () => {
    expect(mcpToolName("mock-ci", "get_job_status")).toBe("mcp__mock-ci__get_job_status");
  });

  it("matches the harness normalization for a dotted raw tool name", () => {
    expect(mcpToolName("srv", "a.b")).toBe("mcp__srv__a_b_df0974cd1f1e");
  });

  it("hashes identities that normalize to the same text so they cannot collide", () => {
    const dot = mcpToolName("srv", "a.b");
    const slash = mcpToolName("srv", "a/b");
    expect(dot.startsWith("mcp__srv__a_b_")).toBe(true);
    expect(slash.startsWith("mcp__srv__a_b_")).toBe(true);
    expect(dot).not.toBe(slash);
  });

  it("truncates long names to the 64-char harness budget and appends a hash", () => {
    const name = mcpToolName("srv", "x".repeat(70));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/_[0-9a-f]{12}$/);
  });
});
