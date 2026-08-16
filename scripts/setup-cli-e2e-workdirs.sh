#!/usr/bin/env bash
#
# Create the isolated workdirs the CLI's opencode/custom e2e cases run in.
#
# The sentinel CLI (`packages/cli`) is harness-agnostic, so its e2e cases
# register the CLI as an MCP server inside OpenCode and drive the four
# `mcp_sentinel_*` tools through the agent. Each harness gets its own workdir
# so the project's own OpenCode plugin (loaded from `~/.config/opencode`) and
# the codex harness do not interfere:
#
#   /private/tmp/mcp-sentinel-opencode-e2e  — CLI `mcp --harness opencode`
#   /private/tmp/mcp-sentinel-custom-e2e    — CLI `mcp --harness custom --mcp-config mcp.json`
#
# The cases run `opencode run --pure --auto --dir <workdir> -m deepseek/deepseek-v4-pro`.
# `--pure` disables the global OpenCode plugin (avoiding a `mcp_sentinel_*` tool
# name collision); the `deepseek` (not `opencode`) provider is required because
# `opencode/deepseek-v4-pro` does not reliably follow the poll→attach pattern.
#
# Usage:
#   scripts/setup-cli-e2e-workdirs.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_PATH="$(command -v bun)"
CLI_JS="$REPO_ROOT/packages/cli/cli.js"
MOCK_SERVER="$REPO_ROOT/packages/core/tests/mock-mcp-server.ts"

if [[ ! -f "$CLI_JS" ]]; then
  echo "error: $CLI_JS not found — run 'bun run build' first." >&2
  exit 1
fi

setup_opencode_workdir() {
  local dir="$1"
  mkdir -p "$dir/.opencode"
  cat > "$dir/.opencode/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mock-ci": { "type": "local", "command": ["$BUN_PATH", "run", "$MOCK_SERVER"], "enabled": true },
    "mcp-sentinel": { "type": "local", "command": ["$BUN_PATH", "$CLI_JS", "mcp", "--harness", "opencode"], "enabled": true }
  }
}
EOF
  echo "wrote $dir/.opencode/opencode.jsonc (opencode harness)"
}

setup_custom_workdir() {
  local dir="$1"
  mkdir -p "$dir/.opencode"
  cat > "$dir/mcp.json" <<EOF
{
  "servers": {
    "mock-ci": { "type": "local", "command": ["$BUN_PATH", "run", "$MOCK_SERVER"], "enabled": true }
  }
}
EOF
  cat > "$dir/.opencode/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-sentinel": { "type": "local", "command": ["$BUN_PATH", "$CLI_JS", "mcp", "--harness", "custom", "--mcp-config", "$dir/mcp.json"], "enabled": true }
  }
}
EOF
  echo "wrote $dir/mcp.json + $dir/.opencode/opencode.jsonc (custom harness)"
}

setup_opencode_workdir /private/tmp/mcp-sentinel-opencode-e2e
setup_custom_workdir /private/tmp/mcp-sentinel-custom-e2e

echo "==> Done. Run the e2e with:"
echo "    bun scripts/run-e2e.ts --harness opencode"
echo "    bun scripts/run-e2e.ts --harness custom"
