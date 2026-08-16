/**
 * Harness MCP config auto-discovery for the sentinel CLI.
 *
 * Each source reads a different input format — `codex mcp list --json`,
 * `opencode debug config`, or a custom JSON file — and maps it into the same
 * unified {@link McpConfig}. The field-name differences live entirely inside
 * each source's `load()`; there is no shared per-entry parser, because the
 * three harnesses name the same concepts differently:
 *
 * - Codex stdio:  `command` (string) + `args` + `env` + `env_vars` + `cwd`.
 * - Codex remote: `type: "streamable_http"` with `url`, `http_headers`,
 *   `bearer_token_env_var`, `env_http_headers`.
 * - OpenCode:     `mcp.<name>` entries; local `command` (array) + `cwd` +
 *   `environment`; remote `url` + `headers`.
 * - Custom:       OpenCode-style entries (`environment`, `headers`) from a
 *   JSON file (`servers` / `mcpServers` / bare map).
 *
 * Entries the harness has disabled (`enabled: false`, or Codex's
 * `disabled_reason`) and the sentinel's own entry (matched by command, never by
 * name) are skipped, so the sentinel never polls a disabled server or itself.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  McpServerConfig,
  McpLocalConfig,
  McpRemoteConfig,
  McpConfig,
} from "@gcszhn/mcp-sentinel-core";

/** Options for {@link createMcpConfigSource}. */
export interface DiscoverOptions {
  /** Harness name: `codex`, `opencode`, `custom`, or `none`. */
  harness?: string;
  /** Path to a custom MCP config JSON file (used with `--harness custom`). */
  mcpConfigPath?: string;
}

/** A source of MCP server configs; every source outputs a unified {@link McpConfig}. */
export interface McpConfigSource {
  load(): McpConfig;
}

/** A JSON object with unknown keys, for reading untrusted harness output. */
type RawObject = Record<string, unknown>;

/**
 * The sentinel's own launch command (`[executable, script, ...args]`), used to
 * recognize a self-reference among discovered MCP entries.
 */
export function selfProcessCommand(): string[] {
  return [process.execPath, ...process.argv.slice(1)];
}

/**
 * Whether two argv arrays refer to the same command. The executable and script
 * (indices 0 and 1) are canonicalized through symlinks so `/opt/homebrew/bin/bun`
 * matches Bun's real exec path; the remaining arguments are compared verbatim.
 */
export function sameCommand(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonicalCommandPart(a[i]!, i) !== canonicalCommandPart(b[i]!, i)) return false;
  }
  return true;
}

function canonicalCommandPart(part: string, index: number): string {
  if (index > 1) return part;
  try {
    return realpathSync(part);
  } catch {
    return part;
  }
}

/**
 * Codex source: `codex mcp list --json`.
 *
 * Each entry is `{ name, enabled, disabled_reason, transport }`; `transport`
 * is `{ type: "stdio", command, args, env, env_vars, cwd }` or
 * `{ type: "streamable_http", url, http_headers, bearer_token_env_var,
 * env_http_headers }`.
 *
 * @param codexBinary - Optional `codex` binary override (used by tests).
 * @param selfCommand - Optional self-launch command (used by tests).
 */
export class CodexMcpConfigSource implements McpConfigSource {
  constructor(
    private readonly codexBinary?: string,
    private readonly selfCommand: string[] = selfProcessCommand()
  ) {}

  load(): McpConfig {
    const binary = this.codexBinary ?? resolveCodexBinary();
    let raw: unknown;
    try {
      raw = JSON.parse(
        execFileSync(binary, ["mcp", "list", "--json"], {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      );
    } catch {
      return { servers: {} };
    }

    const servers: Record<string, McpServerConfig> = Object.create(null);
    if (!Array.isArray(raw)) return { servers };

    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const entry = item as RawObject;
      if (typeof entry.name !== "string" || !entry.name) continue;
      if (entry.enabled === false || entry.disabled_reason != null) continue;
      if (!entry.transport || typeof entry.transport !== "object") continue;
      const t = entry.transport as RawObject;

      if (t.type === "stdio") {
        if (typeof t.command !== "string" || !t.command) continue;
        const command = [t.command, ...(Array.isArray(t.args) ? t.args.map(String) : [])];
        if (sameCommand(command, this.selfCommand)) continue;

        // `env` is the explicit map; `env_vars` forwards named vars from the
        // sentinel process (the child of Codex). Remote-sourced vars cannot be
        // resolved from a child process, so they are skipped.
        // Null-prototype so an env var literally named `__proto__` (an own key
        // from untrusted harness output) is stored, not routed to the setter.
        const env: Record<string, string> = Object.create(null);
        if (t.env && typeof t.env === "object") {
          for (const [key, value] of Object.entries(t.env as RawObject)) {
            if (typeof value === "string") env[key] = value;
          }
        }
        if (Array.isArray(t.env_vars)) {
          for (const item of t.env_vars) {
            let name: string | undefined;
            let source: string | undefined;
            if (typeof item === "string") {
              name = item;
            } else if (item && typeof item === "object") {
              const cfg = item as RawObject;
              if (typeof cfg.name === "string") name = cfg.name;
              if (typeof cfg.source === "string") source = cfg.source;
            }
            if (!name || source === "remote") continue;
            const value = process.env[name];
            if (value !== undefined) env[name] = value;
          }
        }

        servers[entry.name] = {
          type: "local",
          command,
          cwd: typeof t.cwd === "string" && t.cwd ? t.cwd : undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
          enabled: true,
        } as McpLocalConfig;
      } else if (t.type === "streamable_http") {
        if (typeof t.url !== "string" || !t.url) continue;

        // `http_headers` are static; `env_http_headers` map a header name to an
        // env var whose value supplies the header; `bearer_token_env_var` names
        // an env var holding the bearer token.
        // Null-prototype so a header literally named `__proto__` is stored.
        const headers: Record<string, string> = Object.create(null);
        if (t.http_headers && typeof t.http_headers === "object") {
          for (const [key, value] of Object.entries(t.http_headers as RawObject)) {
            if (typeof value === "string") headers[key] = value;
          }
        }
        if (t.env_http_headers && typeof t.env_http_headers === "object") {
          for (const [header, envVar] of Object.entries(t.env_http_headers as RawObject)) {
            if (typeof envVar !== "string" || !envVar) continue;
            const value = process.env[envVar];
            if (value !== undefined) headers[header] = value;
          }
        }
        if (typeof t.bearer_token_env_var === "string" && t.bearer_token_env_var) {
          const token = process.env[t.bearer_token_env_var];
          if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
        }

        servers[entry.name] = {
          type: "remote",
          url: t.url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          enabled: true,
        } as McpRemoteConfig;
      }
    }
    return { servers };
  }
}

/**
 * OpenCode source: `opencode debug config`, JSON `mcp` object.
 *
 * Entries are raw server configs per the OpenCode schema: local
 * `{ type: "local", command: string[], cwd, environment, enabled }`, remote
 * `{ type: "remote", url, headers, enabled }`. Note the local env map is named
 * `environment`, not `env`.
 *
 * @param opencodeBinary - Optional `opencode` binary override (used by tests).
 * @param selfCommand - Optional self-launch command (used by tests).
 */
export class OpencodeMcpConfigSource implements McpConfigSource {
  constructor(
    private readonly opencodeBinary?: string,
    private readonly selfCommand: string[] = selfProcessCommand()
  ) {}

  load(): McpConfig {
    const binary = this.opencodeBinary ?? "opencode";
    let raw: unknown;
    try {
      raw = JSON.parse(
        execFileSync(binary, ["debug", "config"], {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      );
    } catch {
      return { servers: {} };
    }

    const servers: Record<string, McpServerConfig> = Object.create(null);
    const mcp = raw && typeof raw === "object" ? (raw as RawObject).mcp : undefined;
    if (!mcp || typeof mcp !== "object") return { servers };

    for (const [name, config] of Object.entries(mcp as RawObject)) {
      if (!config || typeof config !== "object") continue;
      const c = config as RawObject;
      if (c.enabled === false) continue;

      if (c.type === "local") {
        if (!Array.isArray(c.command) || c.command.length === 0) continue;
        const command = c.command.map(String);
        if (sameCommand(command, this.selfCommand)) continue;
        servers[name] = {
          type: "local",
          command,
          cwd: typeof c.cwd === "string" && c.cwd ? c.cwd : undefined,
          env:
            c.environment && typeof c.environment === "object"
              ? (c.environment as Record<string, string>)
              : undefined,
          enabled: true,
        } as McpLocalConfig;
      } else if (c.type === "remote") {
        if (typeof c.url !== "string" || !c.url) continue;
        servers[name] = {
          type: "remote",
          url: c.url,
          headers:
            c.headers && typeof c.headers === "object"
              ? (c.headers as Record<string, string>)
              : undefined,
          enabled: true,
        } as McpRemoteConfig;
      }
    }
    return { servers };
  }
}

/**
 * Custom source: a user-supplied JSON file via `--mcp-config`.
 *
 * Accepts the core {@link McpConfig} shape (`{ "servers": {...} }`), the
 * Codex `.mcp.json` shape (`{ "mcpServers": {...} }`), or a bare
 * `{ name: entry }` map. Entries use the OpenCode field names: local
 * `{ type: "local", command: string[], cwd, environment, enabled }`, remote
 * `{ type: "remote", url, headers, enabled }`.
 *
 * @param mcpConfigPath - Path to the config file.
 * @param selfCommand - Optional self-launch command (used by tests).
 */
export class CustomMcpConfigSource implements McpConfigSource {
  constructor(
    private readonly mcpConfigPath?: string,
    private readonly selfCommand: string[] = selfProcessCommand()
  ) {}

  load(): McpConfig {
    if (!this.mcpConfigPath) return { servers: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.mcpConfigPath, "utf8"));
    } catch {
      return { servers: {} };
    }
    if (!raw || typeof raw !== "object") return { servers: {} };
    const root = raw as RawObject;
    const map: RawObject =
      (root.servers && typeof root.servers === "object"
        ? (root.servers as RawObject)
        : undefined) ??
      (root.mcpServers && typeof root.mcpServers === "object"
        ? (root.mcpServers as RawObject)
        : undefined) ??
      root;

    const servers: Record<string, McpServerConfig> = Object.create(null);
    for (const [name, config] of Object.entries(map)) {
      if (!config || typeof config !== "object") continue;
      const c = config as RawObject;
      if (c.enabled === false) continue;

      if (c.type === "local") {
        if (!Array.isArray(c.command) || c.command.length === 0) continue;
        const command = c.command.map(String);
        if (sameCommand(command, this.selfCommand)) continue;
        servers[name] = {
          type: "local",
          command,
          cwd: typeof c.cwd === "string" && c.cwd ? c.cwd : undefined,
          env:
            c.environment && typeof c.environment === "object"
              ? (c.environment as Record<string, string>)
              : undefined,
          enabled: true,
        } as McpLocalConfig;
      } else if (c.type === "remote") {
        if (typeof c.url !== "string" || !c.url) continue;
        servers[name] = {
          type: "remote",
          url: c.url,
          headers:
            c.headers && typeof c.headers === "object"
              ? (c.headers as Record<string, string>)
              : undefined,
          enabled: true,
        } as McpRemoteConfig;
      }
    }
    return { servers };
  }
}

/** No discovery: empty config. */
export class EmptyMcpConfigSource implements McpConfigSource {
  load(): McpConfig {
    return { servers: {} };
  }
}

/**
 * Pick the config source for the selected harness.
 *
 * @param opts - Harness name and optional custom config path.
 * @returns A source that loads a unified {@link McpConfig}. Unknown harnesses
 *          yield the empty source.
 */
export function createMcpConfigSource(opts?: DiscoverOptions): McpConfigSource {
  const harness = opts?.harness ?? (opts?.mcpConfigPath ? "custom" : "none");
  switch (harness) {
    case "codex":
      return new CodexMcpConfigSource();
    case "opencode":
      return new OpencodeMcpConfigSource();
    case "custom":
      return new CustomMcpConfigSource(opts?.mcpConfigPath);
    default:
      return new EmptyMcpConfigSource();
  }
}

/**
 * Discover and load the MCP server config for the selected harness.
 *
 * @param opts - Harness name and optional custom config path.
 */
export function discoverMcpConfig(opts?: DiscoverOptions): McpConfig {
  return createMcpConfigSource(opts).load();
}

/**
 * Resolve the `codex` CLI binary (env override, PATH, common locations).
 */
export function resolveCodexBinary(): string {
  const fromEnv = process.env.CODEX_BIN ?? process.env.CODEX_CLI_PATH;
  if (fromEnv) return fromEnv;
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return "codex";
  } catch {
    // fall through
  }
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".codex", "bin", "codex"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
}
