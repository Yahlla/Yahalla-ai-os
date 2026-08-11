#!/bin/sh
# One-time setup: installs a LaunchAgent that keeps a Cloudflare quick
# tunnel open to your local LLM (127.0.0.1:8080 by default) and republishes
# its public URL to Supabase as the YAHALLA_LLM_URL secret whenever it
# changes -- so chat from the domain reaches your Mac-hosted LLM without a
# VPS or any Yahalla-owned server, and without keeping a terminal open.
#
# Requires: cloudflared (brew install cloudflared), and that you've already
# run 'supabase login' and 'supabase link' (scripts/mac-setup.sh does both).
#
# Run once: sh scripts/llm-tunnel/install-llm-tunnel-autostart.sh
# Undo:     sh scripts/llm-tunnel/uninstall-llm-tunnel-autostart.sh
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS only (uses launchd)." >&2
  exit 1
fi

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared not found. Install it first: brew install cloudflared" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LABEL="de.yahalla.llmtunnel"
PLIST_TEMPLATE="$SCRIPT_DIR/de.yahalla.llmtunnel.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

chmod +x "$SCRIPT_DIR/run-llm-tunnel.sh"
mkdir -p "$SCRIPT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s#__RUN_TUNNEL_SH__#$SCRIPT_DIR/run-llm-tunnel.sh#g" \
  -e "s#__TUNNEL_DIR__#$SCRIPT_DIR#g" \
  "$PLIST_TEMPLATE" >"$PLIST_TARGET"

# Unload first in case a previous version is already loaded (idempotent).
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL."
echo "It takes up to ~60s after each start to detect the tunnel URL and publish it."
echo "Logs: $SCRIPT_DIR/logs/cloudflared.log (tunnel + secret updates)"
echo "      $SCRIPT_DIR/logs/service.out.log / service.err.log (wrapper)"
echo "Check status:  launchctl print gui/$(id -u)/$LABEL"
echo "Stop for now:  launchctl bootout gui/$(id -u)/$LABEL"
echo "Uninstall:     sh $SCRIPT_DIR/uninstall-llm-tunnel-autostart.sh"
