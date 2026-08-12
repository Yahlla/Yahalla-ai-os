-- Self-hosted equivalent of the pieces of Supabase's "auth" schema the
-- existing supabase/migrations/*.sql assume: a minimal auth.users table
-- and an auth.uid() function. Identity itself is still verified by
-- Supabase Auth (kept deliberately, per the platform plan, to avoid
-- re-implementing signup/password/session handling) -- platform-api
-- validates the Supabase-issued JWT itself, then opens its DB session as
-- the "authenticated" role with request.jwt.claim.sub set to the verified
-- user id, exactly mirroring how PostgREST/Supabase Edge Functions do it.
-- This lets every RLS-style policy and auth.uid() call in the ported
-- migrations run unmodified against this self-hosted database.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The exported supabase/migrations/*.sql dump assumes Supabase's own
-- bootstrap superuser is literally named "postgres" (every table/function
-- has "ALTER ... OWNER TO postgres"). This self-hosted instance's actual
-- bootstrap superuser is whatever POSTGRES_USER was set to (see
-- docker-compose.yml), not "postgres" -- so a plain "postgres" role is
-- created here purely as an ownership label the migrations can target
-- unmodified. NOLOGIN: nothing should ever authenticate as it directly.
DO $$ BEGIN CREATE ROLE "postgres" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "postgres" (see above) owns most functions in the ported migrations,
-- including SECURITY DEFINER ones like is_admin() that call auth.uid()
-- internally -- SECURITY DEFINER runs the function body as its owning
-- role, so that role needs its own USAGE grant on the auth schema too,
-- not just the roles that call the function from the outside. Without
-- this, every admin-gated route fails with "permission denied for schema
-- auth" even for a real owner/admin user, because is_admin() itself can't
-- resolve auth.uid() while executing as "postgres".
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, "postgres";
GRANT SELECT ON auth.users TO anon, authenticated, service_role, "postgres";
GRANT INSERT, UPDATE, DELETE ON auth.users TO service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, "postgres";

-- In real Supabase, service_role's full table access is provisioned by
-- the platform itself, outside any migration file -- BYPASSRLS bypasses
-- row *filtering*, it does not imply the base table GRANT Postgres
-- separately requires (the exact 42501 bug class this project hit and
-- fixed earlier for "authenticated"; service_role needs the same fix,
-- just granted here since there's no separate migration that expects to
-- run after every future table exists). ALTER DEFAULT PRIVILEGES makes
-- this apply automatically to every table the migrations below create,
-- without needing to know their names in advance.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
