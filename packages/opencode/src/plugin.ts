/**
 * Plugin module entry — the file opencode loads when it discovers this
 * plugin.
 *
 * Imports the plugin factory from `index.js` and re-exports it with the
 * `id` from `package.json`. The `{ type: "json" }` import attribute also
 * inlines `version` at compile time (used for MCP client identification
 * in `core/connection-pool.ts`), ensuring no hardcoded version strings
 * exist anywhere.
 *
 * @module
 */

import type { PluginModule } from "@opencode-ai/plugin";
import pkg from "../package.json" with { type: "json" };

const { OpenCodeSentinelPlugin } = await import("./index.js");

/** Plugin identifier, derived from `package.json#name`. */
export const id = pkg.name?.trim() || "@gcszhn/mcp-sentinel-opencode-plugin";

/**
 * Re-exported plugin factory.
 *
 * @see {@link OpenCodeSentinelPlugin} in `./index.js` for full
 *      documentation of the tool registration logic.
 */
export { OpenCodeSentinelPlugin };

/**
 * Default plugin module export consumed by the opencode plugin host.
 *
 * Bundles the plugin identifier and the {@link OpenCodeSentinelPlugin}
 * factory into the standard {@link PluginModule} shape:
 * - `id` — plugin name from `package.json#name`
 * - `server` — the plugin factory that registers sentinel tools
 */
export default { id, server: OpenCodeSentinelPlugin } satisfies PluginModule;
