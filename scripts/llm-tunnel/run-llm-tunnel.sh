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
# A URL printed in cloudflared's log is NOT proof the tunnel actually
# works end to end (DNS propagation, tunnel registration, and the local
# LLM itself can all still be unready). This script only ever publishes
# YAHALLA_LLM_URL after a real "curl $PUBLIC_URL/v1/models" has succeeded
# -- never on log text alone.
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
TUNNEL_LOG="$LOG_DIR/cloudflared.log"       # cumulative history across restarts
CURRENT_LOG="$LOG_DIR/cloudflared-current.log"  # this run only -- read for URL
                                                  # extraction so a stale URL
                                                  # from a previous run can
                                                  # never be picked up.

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
CURL_BIN=$(find_bin curl) || {
  log "FATAL: curl not found -- cannot verify tunnel readiness."
  exit 1
}

: >"$CURRENT_LOG"
log "starting cloudflared tunnel to $LOCAL_LLM_URL (cloudflared: $CLOUDFLARED_BIN)"

"$CLOUDFLARED_BIN" tunnel --no-autoupdate --url "$LOCAL_LLM_URL" >"$CURRENT_LOG" 2>&1 &
CLOUDFLARED_PID=$!

CLEANED_UP=0
cleanup() {
  [ "$CLEANED_UP" = "1" ] && return 0
  CLEANED_UP=1
  kill "$CLOUDFLARED_PID" 2>/dev/null || true
  cat "$CURRENT_LOG" >>"$TUNNEL_LOG" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Phase 1: wait for cloudflared to announce a public URL for THIS run ---
PUBLIC_URL=""
i=0
while [ "$i" -lt 60 ]; do
  if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    log "FATAL: cloudflared exited early (pid $CLOUDFLARED_PID). See $CURRENT_LOG."
    exit 1
  fi
  PUBLIC_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CURRENT_LOG" 2>/dev/null | tail -1 || true)
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
  i=$((i + 1))
done

if [ -z "$PUBLIC_URL" ]; then
  log "FATAL: no tunnel URL detected within 60s -- is cloudflared reachable / is $LOCAL_LLM_URL up?"
  wait "$CLOUDFLARED_PID"
  exit 1
fi

log "tunnel URL announced: $PUBLIC_URL -- verifying it is actually reachable before trusting it"

# --- Phase 2: a URL in the log is not proof of anything. Only trust it once
# a real request through it actually succeeds (DNS + Cloudflare routing +
# the local LLM itself all have to be working). ---
READY=0
i=0
while [ "$i" -lt 24 ]; do
  if "$CURL_BIN" -fsS --max-time 5 "${PUBLIC_URL}/v1/models" >/dev/null 2>>"$TUNNEL_LOG"; then
    READY=1
    break
  fi
  sleep 5
  i=$((i + 1))
done

if [ "$READY" != "1" ]; then
  log "WARNING: ${PUBLIC_URL}/v1/models did not become reachable within 120s -- NOT publishing YAHALLA_LLM_URL. Check local DNS (see scripts/llm-tunnel/README or the DNS troubleshooting steps), that $LOCAL_LLM_URL is actually serving, and $CURRENT_LOG."
  wait "$CLOUDFLARED_PID"
  exit 0
fi

log "${PUBLIC_URL}/v1/models is reachable -- tunnel is verified ready."

# --- Phase 3: publish only a verified-reachable URL, and only if it changed. ---
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
  log "tunnel URL unchanged and already verified reachable ($PUBLIC_URL), secret already up to date."
fi

wait "$CLOUDFLARED_PID"
