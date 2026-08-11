#!/bin/sh
set -eu

LABEL="de.yahalla.agent"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_TARGET"

echo "Removed $LABEL. The device stays paired (~/.yahalla/agent.json is untouched) — run install-macos-autostart.sh again to re-enable, or 'npm start' manually."
