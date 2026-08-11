# Self-hosted control plane

Coordination, accounts, and the approve-and-ship deployment pipeline for a
self-hosted Yahalla AI deployment (Strato VPS or any root-access Linux VPS).
This never runs AI inference -- every user's chat/agent work executes on
their own device (browser WebGPU or the Electron/local-runtime app). See
`docs/ARCHITECTURE.md` for how this fits into the rest of the system.

## Components

- `db/` -- Postgres schema: an `auth`/extension shim (`00_auth_shim.sql`,
  `01_extension_shims.sql`) plus every file in `supabase/migrations/*.sql`
  applied verbatim (`apply.sh`). One schema source of truth for both the
  Supabase-hosted and self-hosted deployment paths.
- `api/` -- multi-tenant coordination service (accounts, device pairing,
  task/approval queues, deployment proposals). Verifies Supabase-issued
  JWTs for humans and opaque bearer tokens for paired devices.
- `deploy-agent/` -- the only thing allowed to run `git pull` /
  `docker compose up` against the live stack. Polls for admin-approved
  `deployment_proposals` rows and deploys exactly that ref -- no arbitrary
  command execution.
- `docker-compose.yml` + `Caddyfile` -- the whole stack: Postgres,
  platform-api, deploy-agent, and Caddy (the only exposed port, automatic
  TLS). Every service has an explicit `mem_limit`/`cpus`.

## First-time setup

```sh
sh scripts/setup-strato.sh
```

Installs Docker if missing, writes `platform/.env` (prompts once for your
domain and Supabase JWT secret), applies the schema, and brings the stack
up. This is the one allowed terminal session -- see the script's header
comment. Safe to re-run.

## After setup: no terminal

Every further change ships through the admin panel's **Deployments** page:
an agent opens a proposal (title, diff, git ref), an admin clicks
**Approve & Ship** or **Reject**, and `deploy-agent` picks up approved
proposals and deploys them. Nothing ships silently.

The first person to ever sign in becomes the platform owner automatically
(the same `handle_new_user` rule the Supabase-hosted deployment already
uses) -- no separate admin-creation step.

## Local verification

`db/apply.sh`, `api/`, and `deploy-agent/` each have real tests that run
against a real local Postgres instance (no mocks):

```sh
# Postgres 16, unix socket, --auth=trust
PGHOST=/tmp PGPORT=5432 PGUSER=postgres PGDATABASE=yahalla_dev sh platform/db/apply.sh

cd platform/api && npm run build && TEST_DATABASE_URL=postgresql://postgres@/yahalla_dev?host=/tmp\&port=5432 npm test
cd platform/deploy-agent && npm run build && TEST_DATABASE_URL=postgresql://postgres@/yahalla_dev?host=/tmp\&port=5432 npm test
```

The Docker Compose stack itself (image builds, container startup, Caddy
TLS) needs a real Docker host with unrestricted registry access to verify
end-to-end -- `scripts/setup-strato.sh` on the actual VPS is the final
check for that part.
