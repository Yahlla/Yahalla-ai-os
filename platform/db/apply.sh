#!/bin/sh
# Applies the platform's Postgres schema: the auth/extension shims in this
# directory, then every migration under supabase/migrations/ verbatim, in
# the same lexicographic order Supabase itself applies them in -- this
# repo has exactly one schema source of truth, not a forked copy that can
# drift.
#
# Usage: PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... sh platform/db/apply.sh
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

PSQL="psql -v ON_ERROR_STOP=1"

echo "==> Applying auth/extension shims"
$PSQL -f "$SCRIPT_DIR/00_auth_shim.sql"
$PSQL -f "$SCRIPT_DIR/01_extension_shims.sql"

echo "==> Applying supabase/migrations/*.sql"
for migration in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "  - $(basename "$migration")"
  # supabase_vault has no self-hosted equivalent and nothing in this
  # platform reads from it; the vault schema created above is enough for
  # any reference to resolve. MAINTAIN is stripped from GRANT lists for
  # portability across Postgres versions (added in PG17) -- it's a
  # low-impact privilege (VACUUM/ANALYZE/REINDEX) nothing here relies on;
  # omitting it just means that one specific grant is skipped, harmlessly,
  # on any Postgres version.
  sed \
    -e '/CREATE EXTENSION IF NOT EXISTS "supabase_vault"/d' \
    -e '/CREATE EXTENSION IF NOT EXISTS "pg_cron"/d' \
    -e 's/REFERENCES,TRIGGER,TRUNCATE,MAINTAIN/REFERENCES,TRIGGER,TRUNCATE/g' \
    "$migration" | $PSQL
done

echo "==> Schema applied."
