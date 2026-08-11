#!/bin/sh
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

step "1/8  Fetching and checking out claude/yahalla-ai-os-final-unified"
git fetch origin
git checkout claude/yahalla-ai-os-final-unified
git pull --ff-only origin claude/yahalla-ai-os-final-unified

step "2/8  Supabase CLI login (opens your browser)"
if ! npx --yes supabase projects list >/dev/null 2>&1; then
  npx --yes supabase login
fi

step "3/8  Linking to the Yahalla Supabase project"
npx --yes supabase link --project-ref "$PROJECT_REF"

step "4/8  Applying database migrations (devices, GRANT fix, realtime, reaper)"
npx --yes supabase db push

step "5/8  Edge Function configuration"
if [ -z "$YAHALLA_LLM_URL" ]; then
  printf 'YAHALLA_LLM_URL (your OpenAI-compatible LLM endpoint, e.g. a cloud API or a\nreachable LAN/tunnel URL -- Supabase cannot reach 127.0.0.1 on your Mac): '
  read -r YAHALLA_LLM_URL
fi
[ -n "$YAHALLA_LLM_URL" ] || die "YAHALLA_LLM_URL is required -- the chat/task pipeline cannot call an LLM without it."

if [ -z "$YAHALLA_LLM_API_KEY" ]; then
  printf 'YAHALLA_LLM_API_KEY (press Enter to skip if your endpoint needs none): '
  read -r YAHALLA_LLM_API_KEY
fi

npx --yes supabase secrets set \
  YAHALLA_LLM_URL="$YAHALLA_LLM_URL" \
  YAHALLA_ALLOWED_ORIGINS="https://yahalla-ai.yahalla.de" \
  $( [ -n "$YAHALLA_LLM_API_KEY" ] && printf 'YAHALLA_LLM_API_KEY=%s' "$YAHALLA_LLM_API_KEY" )

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
  sh scripts/install-macos-autostart.sh
else
  warn "Not macOS -- start the agent manually with: (cd device-agent && npm start)"
fi

echo
echo "Done. The Device Agent is paired and running in the background."
echo "Everything from here on is managed from the Control Center in your browser."
