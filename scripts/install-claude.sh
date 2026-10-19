#!/usr/bin/env bash
# Install a pinned Claude Code into a private prefix, never touching the global
# install (~/.npm-global), then (optionally) run the fast canary and move `current`.
#   scripts/install-claude.sh <version> [--activate]
# The npm postinstall is skipped (npm blocks install scripts); we link the
# platform binary from the optional native package directly.
set -euo pipefail
ver="${1:?version}"
root="$HOME/.local/share/agent-company/claude"
prefix="$root/$ver"
mkdir -p "$prefix"
npm install --prefix "$prefix" --no-audit --no-fund --no-save "@anthropic-ai/claude-code@$ver" >/dev/null
native="$(ls -d "$prefix"/node_modules/@anthropic-ai/claude-code-linux-* 2>/dev/null | head -1)"
[ -x "$native/claude" ] || { echo "native binary not found under $prefix" >&2; exit 1; }
ln -sfn "${native#$prefix/}/claude" "$prefix/claude"
DISABLE_AUTOUPDATER=1 "$prefix/claude" --version
if [ "${2:-}" = "--activate" ]; then
  node "$(dirname "$0")/canary.mjs" --bin "$prefix/claude" --expect "$ver"
  ln -sfn "$ver" "$root/current"
  echo "current -> $ver"
fi
