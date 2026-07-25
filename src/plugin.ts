import type { PluginModule } from "@opencode-ai/plugin";
import pkg from "../package.json" with { type: "json" };
const { OpenCodeSentinelPlugin } = await import("./index.js");
export const id = pkg.name?.trim() || "opencode-mcp-sentinel";
export { OpenCodeSentinelPlugin };
export default { id, server: OpenCodeSentinelPlugin } satisfies PluginModule;
