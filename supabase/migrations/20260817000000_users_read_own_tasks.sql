-- The base schema's only SELECT policy on tasks is "Admins can read
-- tasks" (is_admin()-gated), plus the device-scoped read policy added in
-- 20260812010000. A non-admin human who creates their own task via
-- platform-api's POST /tasks (task dispatch from the chat composer, see
-- task #80) could therefore never poll it back to completion -- the
-- INSERT would succeed (granted to authenticated) but every subsequent
-- SELECT would come back empty, silently. Owners need read access to the
-- tasks they themselves requested.

DROP POLICY IF EXISTS "Users can read their own requested tasks" ON "public"."tasks";
CREATE POLICY "Users can read their own requested tasks" ON "public"."tasks"
  FOR SELECT TO "authenticated"
  USING ("requested_by" = "auth"."uid"());
