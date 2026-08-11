-- Stand-ins for Supabase-managed pieces the ported migrations reference
-- that this self-hosted Postgres doesn't have and doesn't need:
--
-- - supabase_realtime: Supabase's separate Realtime service replicates
--   off this publication. Self-hosted platform-api pushes live updates
--   itself (the same SSE pattern already built in local-runtime), so
--   nothing reads this publication here -- it only needs to exist so the
--   migrations' `ALTER PUBLICATION supabase_realtime ADD TABLE ...`
--   statements succeed unmodified.
-- - cron.schedule/unschedule: pg_cron isn't in the plain postgres:17
--   image and isn't worth adding just for one periodic job.
--   reap_stalled_tasks() (defined by the ported migrations) is instead
--   called on a plain setInterval from platform-api -- these stubs just
--   let the migration that registers the pg_cron job apply without error;
--   the actual scheduling happens in application code, not Postgres.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS cron;

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$ SELECT 1::bigint $$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
  LANGUAGE sql AS $$ SELECT true $$;

CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
