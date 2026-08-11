#!/bin/sh
# LEGACY / OPTIONAL: this sets up the old cloud-routed path (Supabase Edge
# Function -> a shared model reachable via servers/models or
# YAHALLA_LLM_URL, exposed through this Mac's Cloudflare tunnel). Normal
# operation no longer needs any of this -- see scripts/setup-local.sh for
# the local-first architecture, where the AI runs entirely on each user's
# own device with no tunnel and no dependency on this machine. Only run
# this script if you deliberately want a shared/hosted-model fallback in
# addition to local-first.
#
# One-time setup for Yahalla AI OS: deploys the unified branch to your real
# Supabase project, pairs this Mac as a Device Agent, and installs autostart
# so no Terminal is needed afterwards. Safe to re-run (idempotent).
#
# Run from the repo root:
#   sh scripts/mac-setup.sh
set -e

PROJECT_REF="jpdnneevgotnxiykfafc"
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$1"; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required."
command -v node >/dev/null 2>&1 || die "Node.js is required (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || die "npm is required."

step "1/8  Fetching and checking out main"
git fetch origin
git checkout main
git pull --ff-only origin main

step "2/8  Supabase CLI login (opens your browser)"
if ! npx --yes supabase projects list >/dev/null 2>&1; then
  npx --yes supabase login
fi

step "3/8  Linking to the Yahalla Supabase project"
npx --yes supabase link --project-ref "$PROJECT_REF"

step "4/8  Applying database migrations (devices, GRANT fix, realtime, reaper)"
npx --yes supabase db push

step "5/8  Edge Function configuration"
echo "Supabase's Edge Function runs in the cloud and can never reach 127.0.0.1 on"
echo "your Mac directly. If cloudflared is available, this script exposes your"
echo "local LLM through a Cloudflare quick tunnel and keeps YAHALLA_LLM_URL in"
echo "sync automatically from now on (step 8) -- no VPS, no Yahalla-owned server,"
echo "the model stays on your Mac. Otherwise you'll be asked for a URL directly."

if [ -z "$YAHALLA_LLM_API_KEY" ]; then
  printf 'YAHALLA_LLM_API_KEY (optional -- press Enter to skip. Recommended once you\nexpose your LLM publicly via a tunnel, so strangers cannot use it for free;\nset the same key as your local LLM server'"'"'s own --api-key/auth option): '
  read -r YAHALLA_LLM_API_KEY
fi

if [ -z "$YAHALLA_GITHUB_TOKEN" ]; then
  printf 'GitHub personal access token (optional -- press Enter to skip. Needed for\nYahalla Core to list/create GitHub repositories from chat; create one at\nhttps://github.com/settings/tokens with "repo" scope. Committing and\npushing themselves use your Mac'"'"'s own existing git credentials, not this): '
  read -r YAHALLA_GITHUB_TOKEN
fi

TUNNEL_MODE=0
if [ -z "$YAHALLA_LLM_URL" ] && [ "$(uname)" = "Darwin" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    TUNNEL_MODE=1
  elif command -v brew >/dev/null 2>&1; then
    echo "cloudflared not found -- installing via Homebrew (brew install cloudflared)..."
    if brew install cloudflared; then
      TUNNEL_MODE=1
    else
      warn "Homebrew install of cloudflared failed -- falling back to manual URL entry."
    fi
  fi
fi

if [ "$TUNNEL_MODE" = "1" ]; then
  echo "cloudflared found -- YAHALLA_LLM_URL will be set automatically in step 8."
else
  if [ -z "$YAHALLA_LLM_URL" ]; then
    printf 'YAHALLA_LLM_URL (your OpenAI-compatible LLM endpoint, e.g. a cloud API or a\nreachable LAN/tunnel URL -- Supabase cannot reach 127.0.0.1 on your Mac): '
    read -r YAHALLA_LLM_URL
  fi
  [ -n "$YAHALLA_LLM_URL" ] || die "YAHALLA_LLM_URL is required (or install cloudflared for automatic tunnel setup) -- the chat/task pipeline cannot call an LLM without it."
fi

npx --yes supabase secrets set \
  YAHALLA_ALLOWED_ORIGINS="https://yahalla-ai.yahalla.de" \
  $( [ -n "${YAHALLA_LLM_URL:-}" ] && printf 'YAHALLA_LLM_URL=%s ' "$YAHALLA_LLM_URL" ) \
  $( [ -n "$YAHALLA_LLM_API_KEY" ] && printf 'YAHALLA_LLM_API_KEY=%s ' "$YAHALLA_LLM_API_KEY" ) \
  $( [ -n "$YAHALLA_GITHUB_TOKEN" ] && printf 'YAHALLA_GITHUB_TOKEN=%s' "$YAHALLA_GITHUB_TOKEN" )

step "6/8  Deploying the yahalla-ai Edge Function"
npx --yes supabase functions deploy yahalla-ai

step "7/8  Building the Device Agent"
cd "$REPO_ROOT/device-agent"
npm install
npm run build

step "8/8  Pair this Mac"
echo
echo "Open https://yahalla-ai.yahalla.de in your browser, sign in, go to the"
echo "Devices page, and click \"Connect this device\" to get a pairing code."
echo
printf 'Pairing code: '
read -r PAIRING_CODE
[ -n "$PAIRING_CODE" ] || die "No pairing code entered."

VITE_SUPABASE_URL=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$REPO_ROOT/.env" 2>/dev/null | head -1)
if [ -z "$VITE_SUPABASE_URL" ]; then
  VITE_SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
fi
printf 'Supabase anon key (Project Settings -> API -> anon public, safe to paste): '
read -r VITE_SUPABASE_ANON_KEY
[ -n "$VITE_SUPABASE_ANON_KEY" ] || die "Anon key is required to pair."

printf 'Absolute path to this project on this Mac to use as the device project root [%s]: ' "$REPO_ROOT"
read -r PROJECT_ROOT_INPUT
PROJECT_ROOT_INPUT=${PROJECT_ROOT_INPUT:-$REPO_ROOT}

node dist/index.js pair "$PAIRING_CODE" \
  --supabase-url="$VITE_SUPABASE_URL" \
  --anon-key="$VITE_SUPABASE_ANON_KEY" \
  --project="$PROJECT_ROOT_INPUT" \
  --name="$(scutil --get ComputerName 2>/dev/null || hostname)"

if [ "$(uname)" = "Darwin" ]; then
  step "Installing macOS autostart (LaunchAgent)"
  sh "$REPO_ROOT/device-agent/scripts/install-macos-autostart.sh"
else
  warn "Not macOS -- start the agent manually with: (cd device-agent && npm start)"
fi

if [ "$TUNNEL_MODE" = "1" ]; then
  step "Installing LLM tunnel autostart (keeps YAHALLA_LLM_URL in sync)"
  sh "$REPO_ROOT/scripts/llm-tunnel/install-llm-tunnel-autostart.sh"
  echo "It takes up to ~60s after this to detect the tunnel URL and publish it."
  echo "If chat from the domain says no model is online right after setup, wait a"
  echo "minute and check $REPO_ROOT/scripts/llm-tunnel/logs/cloudflared.log."
fi

echo
echo "Done. The Device Agent is paired and running in the background."
echo "Everything from here on is managed from the Control Center in your browser."
