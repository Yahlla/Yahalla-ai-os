#!/bin/sh
# One-time setup for the self-hosted control plane on a Strato VPS (or any
# root-access Linux VPS): installs Docker if needed, writes platform/.env,
# applies the Postgres schema, and brings up the compose stack (Caddy,
# Postgres, platform-api, deploy-agent) behind TLS.
#
# This is the one allowed terminal session. After it finishes, every future
# change ships through the admin panel's Deployments page (agent proposes,
# you click Approve & Ship) -- never a terminal again. Safe to re-run: it
# won't overwrite an existing platform/.env or clobber the Postgres volume.
#
# Run as root on the VPS, from inside the cloned repo:
#   sh scripts/setup-strato.sh
set -e

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$1"; exit 1; }
ask()  {
  # ask VAR "prompt" ["default"]
  var=$1; prompt=$2; default=$3
  eval "current=\${$var:-}"
  [ -n "$current" ] && return 0
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default"
  else
    printf '%s: ' "$prompt"
  fi
  read -r value
  [ -z "$value" ] && value=$default
  eval "$var=\$value"
}

[ "$(id -u)" = "0" ] || warn "Not running as root -- Docker installation and port 80/443 binding may fail."

step "1/6  Docker"
if command -v docker >/dev/null 2>&1; then
  echo "Docker already installed ($(docker --version))."
else
  echo "Installing Docker via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin is required but wasn't found after install."

step "2/6  Configuration (platform/.env)"
ENV_FILE="$REPO_ROOT/platform/.env"
if [ -f "$ENV_FILE" ]; then
  echo "platform/.env already exists -- reusing it. Delete it first if you want to reconfigure."
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "First-time setup -- a few values are needed once:"
  ask DOMAIN "Domain pointing at this VPS's IP (for automatic TLS)"
  # Supabase projects sign tokens one of two ways -- check which your
  # project uses under Project Settings -> API -> JWT Settings. Most
  # projects created recently sign with ES256 (just need the project URL,
  # nothing secret); older/legacy-mode projects sign with HS256 (need the
  # actual "Legacy JWT Secret" value). Setting both is fine and safest if
  # you're not sure -- platform-api uses whichever a given token needs.
  ask SUPABASE_URL "Supabase project URL (https://xxxx.supabase.co) -- needed if your project signs tokens with ES256" ""
  ask SUPABASE_JWT_SECRET "Supabase Legacy JWT Secret -- needed only if your project signs tokens with HS256" ""
  ask ALLOWED_ORIGINS "Frontend origin(s) allowed to call this API, comma-separated" "https://$DOMAIN"
  [ -n "$DOMAIN" ] || die "DOMAIN is required."
  [ -n "$SUPABASE_URL" ] || [ -n "$SUPABASE_JWT_SECRET" ] || die "At least one of SUPABASE_URL or SUPABASE_JWT_SECRET is required."

  POSTGRES_PASSWORD=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

  cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
SUPABASE_URL=$SUPABASE_URL
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REPO_HOST_PATH=$REPO_ROOT
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (POSTGRES_PASSWORD generated randomly)."
fi

cd "$REPO_ROOT/platform"

step "3/6  Starting Postgres"
docker compose --env-file .env up -d postgres
echo "Waiting for Postgres to become healthy..."
tries=0
until [ "$(docker compose --env-file .env ps -q postgres | xargs docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt 60 ] && die "Postgres did not become healthy in time."
  sleep 2
done

step "4/6  Applying the database schema"
# POSIX sh's "." builtin searches $PATH for a bare filename (no slash),
# not the current directory -- "./.env" forces it to resolve relative to cwd.
# shellcheck disable=SC1090
. ./.env
docker compose --env-file .env exec -T \
  -e PGHOST=localhost -e PGUSER=yahalla -e PGPASSWORD="$POSTGRES_PASSWORD" -e PGDATABASE=yahalla \
  postgres sh /workspace/platform/db/apply.sh

step "5/6  Building and starting platform-api, deploy-agent, and Caddy"
docker compose --env-file .env up -d --build

step "6/6  Health check"
sleep 3
if docker compose --env-file .env exec -T platform-api wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "platform-api is healthy."
else
  warn "platform-api did not respond to its health check yet -- check 'docker compose logs platform-api'."
fi

echo
echo "Done. https://$DOMAIN should now reach platform-api once DNS + TLS finish propagating."
echo "The first person to sign in becomes the platform owner automatically (same rule as"
echo "the Supabase-hosted deployment) -- no separate admin-creation step needed."
echo
echo "From here on: no terminal. Agents propose changes as deployment proposals; approve or"
echo "reject them from the admin panel's Deployments page, and deploy-agent ships them."
