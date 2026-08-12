-- Devices could already read their own assigned tasks
-- (20260812010000_device_execution_unified.sql) but never update them --
-- only admins could (the base schema's is_admin()-gated UPDATE policy).
-- Without this, a device has no way to claim a queued task for itself
-- (queued -> running) or report its own result back (running ->
-- completed/failed) once one is assigned to it -- the read-only policy
-- was enough for the Control Center's Devices page to *show* a device's
-- tasks, but not enough for the device to actually do anything with them.

DROP POLICY IF EXISTS "Devices can update their assigned tasks" ON "public"."tasks";
CREATE POLICY "Devices can update their assigned tasks" ON "public"."tasks"
  FOR UPDATE TO "authenticated"
  USING ("assigned_device" = "public"."current_device_id"())
  WITH CHECK ("assigned_device" = "public"."current_device_id"());
