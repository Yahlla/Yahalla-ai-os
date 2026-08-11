#!/bin/sh
# Persistent watcher: keeps a Cloudflare quick tunnel open to the local LLM
# server (127.0.0.1:8080 by default) and republishes YAHALLA_LLM_URL to
# Supabase whenever the tunnel's public URL changes (a fresh URL is
# assigned every time cloudflared -- or the Mac -- restarts).
#
# This is what lets the domain-hosted Control Center reach a local,
# Mac-only LLM without a VPS or any Yahalla-owned server: the LLM and its
# weights never leave your machine, only a forwarding URL is published.
#
# Security note: a Cloudflare quick tunnel is a public URL with no
# authentication of its own. If your local LLM server supports an API key
# (e.g. llama.cpp's --api-key flag), set it and also set YAHALLA_LLM_API_KEY
# (see scripts/mac-setup.sh) so a stranger who finds the tunnel URL can't
# use your GPU/CPU for free. Anyone who guesses/finds it can otherwise call
# it directly, bypassing Supabase auth entirely.
#
# Launched by the de.yahalla.llmtunnel LaunchAgent; safe to run by hand too.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

LOCAL_LLM_URL=${YAHALLA_LOCAL_LLM_URL:-http://127.0.0.1:8080}
PROJECT_REF_FILE="$REPO_ROOT/supabase/.temp/project-ref"
if [ -n "${YAHALLA_PROJECT_REF:-}" ]; then
  PROJECT_REF="$YAHALLA_PROJECT_REF"
elif [ -f "$PROJECT_REF_FILE" ]; then
  PROJECT_REF=$(cat "$PROJECT_REF_FILE")
else
  PROJECT_REF="jpdnneevgotnxiykfafc"
fi
LAST_URL_FILE="$LOG_DIR/last-url.txt"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$TUNNEL_LOG"; }

find_bin() {
  bin_name=$1
  if command -v "$bin_name" >/dev/null 2>&1; then
    command -v "$bin_name"
    return 0
  fi
  for candidate in \
    "$HOME/.nvm/versions/node/*/bin/$bin_name" \
    "/opt/homebrew/bin/$bin_name" \
    "/usr/local/bin/$bin_name" \
    "/usr/bin/$bin_name"
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

CLOUDFLARED_BIN=$(find_bin cloudflared) || {
  log "FATAL: cloudflared not found. Install with: brew install cloudflared"
  exit 1
}
NPX_BIN=$(find_bin npx) || {
  log "FATAL: npx (Node.js) not found."
  exit 1
}

log "starting cloudflared tunnel to $LOCAL_LLM_URL"

"$CLOUDFLARED_BIN" tunnel --no-autoupdate --url "$LOCAL_LLM_URL" >>"$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID=$!

trap 'kill "$CLOUDFLARED_PID" 2>/dev/null || true' EXIT INT TERM

PUBLIC_URL=""
i=0
while [ "$i" -lt 60 ]; do
  PUBLIC_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
  i=$((i + 1))
done

if [ -z "$PUBLIC_URL" ]; then
  log "FATAL: no tunnel URL detected within 60s -- is cloudflared reachable / is $LOCAL_LLM_URL up?"
  wait "$CLOUDFLARED_PID"
  exit 1
fi

LAST_URL=""
[ -f "$LAST_URL_FILE" ] && LAST_URL=$(cat "$LAST_URL_FILE")

if [ "$PUBLIC_URL" != "$LAST_URL" ]; then
  log "publishing new LLM URL: ${PUBLIC_URL}/v1/chat/completions"
  if (cd "$REPO_ROOT" && "$NPX_BIN" --yes supabase secrets set \
        "YAHALLA_LLM_URL=${PUBLIC_URL}/v1/chat/completions" \
        --project-ref "$PROJECT_REF" >>"$TUNNEL_LOG" 2>&1)
  then
    printf '%s' "$PUBLIC_URL" >"$LAST_URL_FILE"
    log "YAHALLA_LLM_URL updated successfully."
  else
    log "WARNING: failed to update the YAHALLA_LLM_URL secret -- domain chat will keep failing until this succeeds. Check that 'supabase login' has been run."
  fi
else
  log "tunnel URL unchanged ($PUBLIC_URL), secret already up to date."
fi

wait "$CLOUDFLARED_PID"
