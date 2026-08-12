# Self-hosted control plane

Coordination, accounts, and the approve-and-ship deployment pipeline for a
self-hosted Yahalla AI deployment (Strato VPS or any root-access Linux VPS).
This never runs AI inference -- every user's chat/agent work executes on
their own device (browser WebGPU or the Electron/local-runtime app). See
`docs/ARCHITECTURE.md` for how this fits into the rest of the system.

## Zero-terminal policy

`scripts/setup-strato.sh` is the *only* terminal session this project ever
asks for -- a one-time bootstrap. Every feature, integration, or setting
built after initial setup must be configurable and observable entirely
from the Control Center's UI (a form + a save button + a live status
indicator), never by SSHing in to edit a file. The cloud smart tier's
Settings page (below) is the reference example of this pattern: a
database-backed setting (not an env file), a save action, and a status
badge that updates the moment it's saved.

## Components

- `db/` -- Postgres schema: an `auth`/extension shim (`00_auth_shim.sql`,
  `01_extension_shims.sql`) plus every file in `supabase/migrations/*.sql`
  applied verbatim (`apply.sh`). One schema source of truth for both the
  Supabase-hosted and self-hosted deployment paths.
- `api/` -- multi-tenant coordination service (accounts, device pairing,
  task/approval queues, deployment proposals). Verifies Supabase-issued
  JWTs for humans and opaque bearer tokens for paired devices. Supabase
  projects sign tokens either with HS256 (a shared secret,
  `SUPABASE_JWT_SECRET`) or ES256 (a managed keypair, verified against the
  project's public JWKS via `SUPABASE_URL`) -- `api/src/jwt.ts` reads the
  algorithm off each token's own header and verifies accordingly, so a
  deployment works against either kind of project without needing to know
  in advance which one it is. At least one of the two env vars must be set.
- `deploy-agent/` -- the only thing allowed to run `git pull` /
  `docker compose up` against the live stack. Polls for admin-approved
  `deployment_proposals` rows and deploys exactly that ref -- no arbitrary
  command execution.
- `docker-compose.yml` + `Caddyfile` + `caddy/` -- the whole stack:
  Postgres, platform-api, deploy-agent, and Caddy (the only exposed port,
  automatic TLS, per-IP rate limiting via a custom build with
  `caddy-ratelimit`). Every service has an explicit `mem_limit`/`cpus`.

## Vector DB Core (cross-device semantic memory)

`memory_entries` (in the `20260814000000_vector_memory_core.sql` migration)
is a pgvector-backed table for semantic memory shared across a user's
devices -- store a piece of context once, retrieve it by meaning later,
regardless of which device wrote it. Deliberately narrow about what runs
where:

- **Embeddings are computed on the caller's own device** (browser or
  local-runtime), never by platform-api. This is what keeps it
  appropriate for a resource-modest VPS: storing a vector and ranking
  rows by cosine distance (`api/src/memory.ts`, `POST /memory`,
  `POST /memory/search`) is cheap linear algebra pgvector's HNSW index
  handles fine -- nothing here is a model forward pass.
- The Postgres image is `pgvector/pgvector:pg16` (not the stock
  `postgres:16-alpine`) specifically so `CREATE EXTENSION vector` has
  something to install.
- 384-dimension vectors, matching small client-side-friendly embedding
  models (e.g. all-MiniLM-L6-v2 class) -- swap the column dimension (and
  re-embed existing rows) if a different embedding model is chosen.
- RLS-scoped like everything else: a user only ever sees their own
  entries, verified in `api/test/server.test.ts` (including that search
  ranks by real cosine similarity, not just returns rows).

## Cloud smart tier (opt-in, off by default)

An additional escalation path for heavier reasoning than the local/browser
models can do, forwarding a chat request to a free-tier OpenAI-compatible
provider (Groq's `llama-3.3-70b-versatile` by default). Deliberately built
as its own narrow thing, not folded into local-runtime's `chatCompletion`:

- **The upstream API key never leaves this server.** The browser only ever
  calls `POST /smart-tier/chat` on platform-api with the user's own
  Supabase session token; platform-api holds `CLOUD_TIER_API_KEY` and
  attaches it server-side. No client-side code path ever sees the key.
- **Off by default, all the way off.** Leave `CLOUD_TIER_API_KEY` unset in
  `platform/.env` and the route always returns 503 -- there is no
  half-enabled state.
- **local-runtime is untouched.** `local-runtime/src/llm.ts`'s
  `chatCompletion` has a deliberate, on-purpose invariant that it never
  calls anything outside `127.0.0.1` -- this cloud tier is a completely
  separate code path so that invariant stays true.
- **Portable by construction.** `CLOUD_TIER_URL` / `CLOUD_TIER_MODEL` are
  the only things that change to point this at a self-hosted,
  OpenAI-compatible server later (vLLM, llama.cpp's server, Ollama) instead
  of a free-tier provider -- no code change, just `platform/.env`.

**To enable, no terminal needed:** get a free API key from
https://console.groq.com, then sign in to the Control Center as the
platform owner/admin and paste it into **Settings → Cloud Smart Tier**.
Saved to the `platform_settings` table (RLS-gated to `is_admin()`, see the
`20260815000000_platform_settings.sql` migration and `api/src/settings.ts`)
and takes effect on the very next chat message -- no restart, no redeploy.
The Settings page also shows a live "Connected · &lt;model&gt;" badge the
moment it's saved.

`CLOUD_TIER_API_KEY` in `platform/.env` still works as a bootstrap
default for operators who prefer it, but the database always wins when
both are set (`cloudTier.ts`'s `resolveCloudTierConfig`).

then `cd platform && docker compose --env-file .env up -d --build`.

## Load protection

Two independent layers, neither trusting the other to be enough alone:

- **Caddy** (`Caddyfile`) rate-limits per source IP (120 req/min by
  default) before a request ever reaches platform-api.
- **platform-api**'s own Postgres connection pool (`DB_POOL_MAX`, set in
  `docker-compose.yml`, default 8) is the real worker-concurrency cap --
  every request needs a pool connection, so this bounds how much
  concurrent DB work the service can drive no matter how many requests get
  past Caddy. Start conservative on a Paket M-class VPS and raise it only
  after watching real headroom, not by guessing.

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
