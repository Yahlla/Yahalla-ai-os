#!/bin/sh
# Wrapper launchd execs directly (no login shell, no PATH from .zshrc), so
# it has to find node itself rather than assume it's on PATH.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

find_node() {
  for candidate in \
    "$HOME/.nvm/versions/node/*/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    for expanded in $candidate; do
      if [ -x "$expanded" ]; then
        printf '%s\n' "$expanded"
        return 0
      fi
    done
  done
  return 1
}

if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  NODE_BIN=$(find_node) || {
    echo "yahalla-agent: could not find a node executable. Edit run-agent.sh with the correct path (run 'command -v node' in your normal terminal to find it)." >&2
    exit 1
  }
fi

exec "$NODE_BIN" "$AGENT_DIR/dist/index.js" start
