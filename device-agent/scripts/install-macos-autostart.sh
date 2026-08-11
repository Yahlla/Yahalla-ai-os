#!/bin/sh
# One-time setup: install a LaunchAgent that starts the Device Agent
# automatically at login, restarts it if it crashes, and logs to
# device-agent/logs/. Only scoped to this project directory — it does not
# touch anything system-wide besides the one LaunchAgent file it installs
# for the current user (not root, not a system daemon).
#
# Run once: sh scripts/install-macos-autostart.sh
# Undo:     sh scripts/uninstall-macos-autostart.sh
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS only (uses launchd). See README.md for Linux/Windows equivalents." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LABEL="de.yahalla.agent"
PLIST_TEMPLATE="$AGENT_DIR/launchd/de.yahalla.agent.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$AGENT_DIR/dist/index.js" ]; then
  echo "dist/index.js not found. Run 'npm run build' in device-agent/ first." >&2
  exit 1
fi

if [ ! -f "$HOME/.yahalla/agent.json" ]; then
  echo "No paired device config found at ~/.yahalla/agent.json." >&2
  echo "Run 'npm run pair' first so the agent has something to start with." >&2
  exit 1
fi

chmod +x "$SCRIPT_DIR/run-agent.sh"
mkdir -p "$AGENT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s#__RUN_AGENT_SH__#$SCRIPT_DIR/run-agent.sh#g" \
  -e "s#__AGENT_DIR__#$AGENT_DIR#g" \
  "$PLIST_TEMPLATE" > "$PLIST_TARGET"

# Unload first in case a previous version is already loaded (idempotent).
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL."
echo "Logs: $AGENT_DIR/logs/agent.out.log and agent.err.log"
echo "Check status:  launchctl print gui/$(id -u)/$LABEL"
echo "Stop for now:  launchctl bootout gui/$(id -u)/$LABEL"
echo "Uninstall:     sh $SCRIPT_DIR/uninstall-macos-autostart.sh"
