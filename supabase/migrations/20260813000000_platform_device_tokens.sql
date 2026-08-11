-- Adds a self-hosted-platform-only auth path for paired devices.
--
-- The existing devices.auth_user_id (from 20260812010000_*) assumes each
-- device gets a real Supabase Auth session, which is how the Supabase-
-- hosted Edge Function path already works. The self-hosted platform-api
-- (platform/) keeps Supabase Auth for *human* accounts only and does not
-- stand up full password/session infrastructure just for machine-to-
-- machine device auth -- instead each paired device gets a random bearer
-- token, stored here as a salted hash, checked directly by platform-api.
-- auth_user_id is still populated (a synthetic auth.users row, per the
-- platform's auth shim) purely so every existing RLS policy keyed on
-- auth.uid() keeps working unmodified for device-originated requests.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash
  ON devices (token_hash) WHERE token_hash IS NOT NULL;
