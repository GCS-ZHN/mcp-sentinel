#!/usr/bin/env bash
#
# Build the sentinel CLI and register it as an MCP server with Codex:
# add `[mcp_servers.mcp-sentinel]` to config.toml running
# `mcp-sentinel mcp --harness codex`, so the sentinel polls the same MCP
# servers Codex exposes (via `codex mcp list --json`). Build artifacts
# (`cli.js`, `dist/`) are generated on the fly and not committed.
#
# Usage:
#   scripts/install-codex-mcp.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG_TOML="$CODEX_HOME/config.toml"

command -v bun >/dev/null 2>&1 || { echo "error: bun is required but not found in PATH" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "error: codex CLI is required but not found in PATH" >&2; exit 1; }

echo "==> Building the mcp-sentinel CLI"
(
  cd "$REPO_ROOT"
  bun install
  bun run build
)

BUN_PATH="$(command -v bun)"
CLI_JS="$REPO_ROOT/packages/cli/cli.js"

echo "==> Registering [mcp_servers.mcp-sentinel] in $CONFIG_TOML"
python3 - "$CONFIG_TOML" "$BUN_PATH" "$CLI_JS" <<'PY'
import sys
path, bun, cli = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
out = []
i = 0
replaced = False
while i < len(lines):
    line = lines[i]
    s = line.strip()
    if s.startswith("[") and s.endswith("]") and s[1:-1].strip() == "mcp_servers.mcp-sentinel":
        replaced = True
        i += 1
        while i < len(lines) and not (lines[i].strip().startswith("[") and lines[i].strip().endswith("]")):
            i += 1
        continue
    out.append(line)
    i += 1
out.append("")
out.append("[mcp_servers.mcp-sentinel]")
out.append(f'command = "{bun}"')
out.append(f'args = ["{cli}", "mcp", "--harness", "codex"]')
out.append('env_vars = ["CODEX_HOME", "CODEX_BIN", "CODEX_CLI_PATH"]')
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
print("    registered (replaced)" if replaced else "    registered (added)")
PY

echo "==> Removing the old plugin form (marketplace + plugin) if present"
codex plugin remove mcp-sentinel@mcp-sentinel-local 2>/dev/null || true
codex plugin marketplace remove mcp-sentinel-local 2>/dev/null || true
rm -rf "$REPO_ROOT/.codex-marketplace"

echo "==> Done. Start a new Codex thread — the mcp_sentinel_* tools come from"
echo "    the mcp-sentinel MCP server (verify with: codex mcp get mcp-sentinel)."
echo "    No notification hook is installed: collect results with mcp_sentinel_attach / status / read."
