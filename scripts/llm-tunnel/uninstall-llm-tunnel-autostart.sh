#!/bin/sh
set -eu

LABEL="de.yahalla.llmtunnel"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_TARGET"

echo "Removed $LABEL. Your local LLM keeps running -- only the public tunnel and"
echo "auto-published YAHALLA_LLM_URL stop. Run install-llm-tunnel-autostart.sh"
echo "again to re-enable."
