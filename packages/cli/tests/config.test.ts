import { describe, it, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexMcpConfigSource,
  OpencodeMcpConfigSource,
  CustomMcpConfigSource,
  EmptyMcpConfigSource,
  createMcpConfigSource,
  discoverMcpConfig,
  resolveCodexBinary,
  sameCommand,
  selfProcessCommand,
} from "../src/config.js";
import { makeServerResolver } from "@gcszhn/mcp-sentinel-core";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeBinary(name: string, stdout: string): string {
  const dir = makeTempDir(`fake-${name}-`);
  const file = join(dir, name);
  const payload = join(dir, "payload.json");
  writeFileSync(payload, stdout);
  writeFileSync(file, `#!/bin/sh\ncat '${payload}'\n`);
  chmodSync(file, 0o755);
  return file;
}

// A self command that will never collide with the real test process argv.
const SELF = ["/opt/homebrew/bin/bun", "/abs/sentinel/cli.js", "mcp", "--harness", "codex"];

afterEach(() => {
  delete process.env.CODEX_BIN;
  delete process.env.CODEX_CLI_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sameCommand / selfProcessCommand", () => {
  it("compares argv verbatim except the executable and script, which are canonicalized", () => {
    const dir = makeTempDir("samecmd-");
    const real = join(dir, "real.sh");
    const link = join(dir, "link.sh");
    writeFileSync(real, "#!/bin/sh\n");
    symlinkSync(real, link);

    expect(
      sameCommand([link, "mcp", "--harness", "codex"], [real, "mcp", "--harness", "codex"])
    ).toBe(true);
    expect(
      sameCommand([link, "mcp", "--harness", "codex"], [real, "mcp", "--harness", "opencode"])
    ).toBe(false);
    expect(sameCommand([link], [real, "extra"])).toBe(false);
  });

  it("selfProcessCommand is the full argv starting from the executable", () => {
    const cmd = selfProcessCommand();
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd.slice(1)).toEqual(process.argv.slice(1));
  });
});

describe("CodexMcpConfigSource", () => {
  it("maps stdio command/args/env/cwd and remote http_headers/url", () => {
    const fake = makeFakeBinary(
      "codex",
      JSON.stringify([
        {
          name: "mock-ci",
          enabled: true,
          disabled_reason: null,
          transport: {
            type: "stdio",
            command: "bun",
            args: ["mock.ts"],
            env: { KEY: "value" },
            env_vars: [],
            cwd: "/tmp",
          },
        },
        {
          name: "remote",
          enabled: true,
          disabled_reason: null,
          transport: {
            type: "streamable_http",
            url: "https://x/mcp",
            http_headers: { "X-Api-Key": "abc" },
          },
        },
      ])
    );
    const config = new CodexMcpConfigSource(fake, SELF).load();
    expect(Object.keys(config.servers).sort()).toEqual(["mock-ci", "remote"]);

    const local = config.servers["mock-ci"] as {
      type: string;
      command: string[];
      cwd?: string;
      env?: Record<string, string>;
    };
    expect(local.command).toEqual(["bun", "mock.ts"]);
    expect(local.cwd).toBe("/tmp");
    expect(local.env).toEqual({ KEY: "value" });

    const remote = config.servers["remote"] as { type: string; url: string; headers?: object };
    expect(remote.type).toBe("remote");
    expect(remote.url).toBe("https://x/mcp");
    expect(remote.headers).toEqual({ "X-Api-Key": "abc" });
  });

  it("resolves bearer_token_env_var and env_http_headers into headers", () => {
    process.env.SENTINEL_TEST_TOKEN = "tok123";
    process.env.SENTINEL_TEST_HEADER = "hdr-value";
    try {
      const fake = makeFakeBinary(
        "codex",
        JSON.stringify([
          {
            name: "remote",
            enabled: true,
            disabled_reason: null,
            transport: {
              type: "streamable_http",
              url: "https://x/mcp",
              bearer_token_env_var: "SENTINEL_TEST_TOKEN",
              http_headers: null,
              env_http_headers: { "X-Dynamic": "SENTINEL_TEST_HEADER" },
            },
          },
        ])
      );
      const config = new CodexMcpConfigSource(fake, SELF).load();
      const remote = config.servers["remote"] as { headers?: Record<string, string> };
      expect(remote.headers).toEqual({
        "X-Dynamic": "hdr-value",
        Authorization: "Bearer tok123",
      });
    } finally {
      delete process.env.SENTINEL_TEST_TOKEN;
      delete process.env.SENTINEL_TEST_HEADER;
    }
  });

  it("forwards env_vars from the process env (skipping remote-sourced vars)", () => {
    process.env.SENTINEL_FORWARDED = "forwarded";
    try {
      const fake = makeFakeBinary(
        "codex",
        JSON.stringify([
          {
            name: "srv",
            enabled: true,
            disabled_reason: null,
            transport: {
              type: "stdio",
              command: "bun",
              args: [],
              env: null,
              env_vars: [
                "SENTINEL_FORWARDED",
                { name: "REMOTE_ONLY", source: "remote" },
                "MISSING_VAR",
              ],
              cwd: null,
            },
          },
        ])
      );
      const config = new CodexMcpConfigSource(fake, SELF).load();
      const local = config.servers["srv"] as { env?: Record<string, string> };
      expect(local.env).toEqual({ SENTINEL_FORWARDED: "forwarded" });
    } finally {
      delete process.env.SENTINEL_FORWARDED;
    }
  });

  it("skips enabled:false and disabled_reason entries", () => {
    const fake = makeFakeBinary(
      "codex",
      JSON.stringify([
        {
          name: "off",
          enabled: false,
          disabled_reason: null,
          transport: { type: "stdio", command: "x", args: [] },
        },
        {
          name: "broken",
          enabled: true,
          disabled_reason: "requirements",
          transport: { type: "stdio", command: "x", args: [] },
        },
        {
          name: "on",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "bun", args: [] },
        },
      ])
    );
    const config = new CodexMcpConfigSource(fake, SELF).load();
    expect(Object.keys(config.servers)).toEqual(["on"]);
  });

  it("skips self by command, not by name", () => {
    const fake = makeFakeBinary(
      "codex",
      JSON.stringify([
        // Registered under a *different* name but running the sentinel command.
        {
          name: "my-alias",
          enabled: true,
          disabled_reason: null,
          transport: {
            type: "stdio",
            command: "/opt/homebrew/bin/bun",
            args: ["/abs/sentinel/cli.js", "mcp", "--harness", "codex"],
          },
        },
        // Named "mcp-sentinel" but a totally different command — must NOT be skipped.
        {
          name: "mcp-sentinel",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "other", args: [] },
        },
      ])
    );
    const config = new CodexMcpConfigSource(fake, SELF).load();
    expect(Object.keys(config.servers)).toEqual(["mcp-sentinel"]);
  });

  it("returns empty config when the codex binary fails", () => {
    expect(new CodexMcpConfigSource("/nonexistent/codex", SELF).load().servers).toEqual({});
  });
});

describe("OpencodeMcpConfigSource", () => {
  it("maps local command/environment/cwd and remote url/headers", () => {
    const fake = makeFakeBinary(
      "opencode",
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          codegraph: {
            type: "local",
            command: ["codegraph", "serve", "--mcp"],
            cwd: "/tmp",
            environment: { KEY: "value" },
            enabled: true,
          },
          remote: { type: "remote", url: "http://127.0.0.1:5173/mcp", headers: { "X-A": "b" } },
        },
      })
    );
    const config = new OpencodeMcpConfigSource(fake, SELF).load();
    expect(Object.keys(config.servers).sort()).toEqual(["codegraph", "remote"]);

    const local = config.servers["codegraph"] as {
      command: string[];
      cwd?: string;
      env?: Record<string, string>;
    };
    expect(local.command).toEqual(["codegraph", "serve", "--mcp"]);
    expect(local.cwd).toBe("/tmp");
    expect(local.env).toEqual({ KEY: "value" });

    const remote = config.servers["remote"] as { url: string; headers?: object };
    expect(remote.url).toBe("http://127.0.0.1:5173/mcp");
    expect(remote.headers).toEqual({ "X-A": "b" });
  });

  it("does not read a nonexistent 'env' field (uses 'environment')", () => {
    const fake = makeFakeBinary(
      "opencode",
      JSON.stringify({
        mcp: {
          srv: { type: "local", command: ["bun"], env: { WRONG: "nope" }, enabled: true },
        },
      })
    );
    const config = new OpencodeMcpConfigSource(fake, SELF).load();
    const local = config.servers["srv"] as { env?: Record<string, string> };
    // OpenCode names the env map `environment`; `env` must be ignored, not
    // silently coerced into a bogus env map.
    expect(local.env).toBeUndefined();
  });

  it("skips enabled:false and self-by-command entries", () => {
    const fake = makeFakeBinary(
      "opencode",
      JSON.stringify({
        mcp: {
          off: { type: "local", command: ["bun"], enabled: false },
          alias: {
            type: "local",
            command: ["/opt/homebrew/bin/bun", "/abs/sentinel/cli.js", "mcp", "--harness", "codex"],
          },
          real: { type: "local", command: ["bun", "other.ts"] },
        },
      })
    );
    const config = new OpencodeMcpConfigSource(fake, SELF).load();
    expect(Object.keys(config.servers)).toEqual(["real"]);
  });

  it("returns empty config when the opencode binary fails", () => {
    expect(new OpencodeMcpConfigSource("/nonexistent/opencode", SELF).load().servers).toEqual({});
  });
});

describe("CustomMcpConfigSource", () => {
  it("accepts servers, mcpServers, and a bare map", () => {
    const dir = makeTempDir("custom-");
    const wrapped = join(dir, "wrapped.json");
    writeFileSync(
      wrapped,
      JSON.stringify({
        servers: {
          a: { type: "local", command: ["x"], environment: { K: "v" } },
          r: { type: "remote", url: "http://y/mcp", headers: { H: "h" } },
        },
      })
    );
    const config = new CustomMcpConfigSource(wrapped, SELF).load();
    expect((config.servers["a"] as { env?: object }).env).toEqual({ K: "v" });
    expect((config.servers["r"] as { headers?: object }).headers).toEqual({ H: "h" });

    const bare = join(dir, "bare.json");
    writeFileSync(bare, JSON.stringify({ b: { type: "remote", url: "http://z/mcp" } }));
    expect(new CustomMcpConfigSource(bare, SELF).load().servers["b"]!.type).toBe("remote");
  });

  it("does not read a nonexistent 'env' field (uses OpenCode 'environment')", () => {
    const dir = makeTempDir("custom-");
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        servers: {
          srv: { type: "local", command: ["bun"], env: { WRONG: "nope" } },
        },
      })
    );
    const config = new CustomMcpConfigSource(file, SELF).load();
    const local = config.servers["srv"] as { env?: Record<string, string> };
    // Custom entries follow OpenCode naming: `environment`, not `env`.
    expect(local.env).toBeUndefined();
  });

  it("skips enabled:false and self-by-command entries", () => {
    const dir = makeTempDir("custom-");
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          off: { type: "local", command: ["bun"], enabled: false },
          alias: {
            type: "local",
            command: ["/opt/homebrew/bin/bun", "/abs/sentinel/cli.js", "mcp", "--harness", "codex"],
          },
          mock: { type: "local", command: ["bun", "mock.ts"] },
        },
      })
    );
    expect(Object.keys(new CustomMcpConfigSource(file, SELF).load().servers)).toEqual(["mock"]);
  });

  it("returns empty for missing files and missing paths", () => {
    expect(new CustomMcpConfigSource(undefined, SELF).load().servers).toEqual({});
    expect(new CustomMcpConfigSource("/nonexistent/mcp.json", SELF).load().servers).toEqual({});
  });
});

describe("createMcpConfigSource", () => {
  it("dispatches to the selected harness", () => {
    expect(createMcpConfigSource({ harness: "none" })).toBeInstanceOf(EmptyMcpConfigSource);
    expect(createMcpConfigSource({ harness: "codex" })).toBeInstanceOf(CodexMcpConfigSource);
    expect(createMcpConfigSource({ harness: "opencode" })).toBeInstanceOf(OpencodeMcpConfigSource);
    expect(createMcpConfigSource({ harness: "custom", mcpConfigPath: "/x" })).toBeInstanceOf(
      CustomMcpConfigSource
    );
    expect(createMcpConfigSource({ harness: "unknown" })).toBeInstanceOf(EmptyMcpConfigSource);
    expect(createMcpConfigSource({})).toBeInstanceOf(EmptyMcpConfigSource);
  });
});

describe("discoverMcpConfig", () => {
  it("uses --mcp-config when provided", () => {
    const dir = makeTempDir("discover-");
    const file = join(dir, "mcp.json");
    writeFileSync(file, JSON.stringify({ servers: { s: { type: "local", command: ["bun"] } } }));
    const config = discoverMcpConfig({ mcpConfigPath: file });
    expect(config.servers.s).toBeDefined();
  });
});

describe("resolveCodexBinary", () => {
  it("prefers CODEX_BIN then CODEX_CLI_PATH", () => {
    process.env.CODEX_BIN = "/custom/codex";
    expect(resolveCodexBinary()).toBe("/custom/codex");
    delete process.env.CODEX_BIN;
    process.env.CODEX_CLI_PATH = "/custom/app-codex";
    expect(resolveCodexBinary()).toBe("/custom/app-codex");
  });
});

describe("resolver integration", () => {
  it("exposes discovered servers through makeServerResolver", () => {
    const dir = makeTempDir("resolver-");
    const file = join(dir, "mcp.json");
    writeFileSync(file, JSON.stringify({ servers: { mock: { type: "local", command: ["bun"] } } }));
    const config = new CustomMcpConfigSource(file, SELF).load();
    const resolve = makeServerResolver(config);
    expect(resolve("mock")).toBeDefined();
    expect(resolve("missing")).toBeNull();
  });
});
