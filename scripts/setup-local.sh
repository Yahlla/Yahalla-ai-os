#!/bin/sh
# One-time setup for Yahalla AI OS's local-first architecture: builds the
# local Agent Runtime and desktop shell so the AI runs entirely on THIS
# device. No Cloudflare, no tunnel, no cloud LLM, no dependency on any
# other machine. Safe to re-run.
#
# Run from the repo root:
#   sh scripts/setup-local.sh
set -e

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$1"; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 22.5+ is required (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || die "npm is required."

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22.5+ is required (local-runtime uses the built-in node:sqlite module). Found: $(node --version)"

step "1/5  Building the shared agent-tools package"
cd "$REPO_ROOT/packages/agent-tools"
npm install
npm run build

step "2/5  Building the local Agent Runtime"
cd "$REPO_ROOT/local-runtime"
npm install
npm run build
npm test

step "3/5  Building the Control Center frontend"
cd "$REPO_ROOT"
npm install
npm run build

step "4/5  Local LLM server"
if command -v llama-server >/dev/null 2>&1 || [ -x /opt/homebrew/bin/llama-server ] || [ -x /usr/local/bin/llama-server ]; then
  echo "llama-server found -- the runtime will manage it automatically."
else
  warn "llama-server not found. Install llama.cpp (e.g. 'brew install llama.cpp' on macOS) so the"
  warn "runtime can serve a local model. You can also point it at any other OpenAI-compatible local"
  warn "server (Ollama, LM Studio, ...) already running on 127.0.0.1 -- the runtime just needs a"
  warn "reachable /v1/chat/completions endpoint on this machine."
fi

step "5/5  Desktop shell (optional -- needed to run Yahalla AI without a terminal)"
if [ "$1" = "--with-desktop" ]; then
  cd "$REPO_ROOT/desktop"
  npm install
  echo "Desktop shell installed. Start it with: (cd desktop && npm run electron:dev)"
else
  echo "Skipped. Re-run as 'sh scripts/setup-local.sh --with-desktop' to install it,"
  echo "or run the runtime directly for now: (cd local-runtime && npm start -- --project=/path/to/your/project)"
fi

echo
echo "Done. Nothing here required Cloudflare, a tunnel, or any cloud LLM secret."
echo "Everything the AI needs to run now lives on this machine."
