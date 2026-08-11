-- Device-local execution architecture, unified with the servers/models/
-- projects/conversations platform built in 20260810114126_*.
--
-- "servers"/"models" (existing) register LLM inference backends the
-- platform routes chat requests to. "devices" (new, this migration) are a
-- different concept: a paired Device Agent process running on the owner's
-- own Mac/Windows/Linux machine that executes project-filesystem/git/shell
-- tools (read_project_file, write_project_file, patch_project_file,
-- list_project_files, git_status, git_diff, run_project_command) — work an
-- Edge Function structurally cannot do, since it has no project checkout
-- and no persistent process. These are deliberately kept as separate
-- tables rather than folded into "servers": a server hosts a model over
-- HTTP, a device is an identity-scoped agent that claims and runs
-- filesystem-level tool_executions. No VPS, no Yahalla-owned permanent
-- worker — the device *is* wherever the owner started it.

-- ---------------------------------------------------------------------------
-- list_project_files: the seed migration (20260810114233_*.sql) registered
-- read/write/patch/git_status/git_diff/run_project_command but never this
-- one, even though it names it in its own overview comment -- it would
-- have been permanently unreachable by the LLM (agent_tools never links
-- to a tool that was never inserted). Same agents as read_project_file.
-- ---------------------------------------------------------------------------

INSERT INTO "public"."tools" ("key", "name_ar", "name_de", "description", "category", "status", "requires_approval", "configuration")
VALUES ('list_project_files', 'عرض ملفات المشروع', 'Projektdateien auflisten', 'List files and directories under a path in the project workspace.', 'files', 'active', false, '{}'::"jsonb")
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "public"."agent_tools" ("agent_id", "tool_id", "enabled")
SELECT a."id", t."id", true
FROM "public"."agents" a
CROSS JOIN "public"."tools" t
WHERE t."key" = 'list_project_files'
  AND a."key" IN ('yahalla-core', 'developer', 'debugger', 'tester', 'file', 'reviewer', 'docs')
ON CONFLICT ("agent_id", "tool_id") DO UPDATE SET enabled = true;

-- ---------------------------------------------------------------------------
-- devices + pairing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."devices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "name" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "status" "text" DEFAULT 'offline'::"text" NOT NULL,
    "capabilities" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "project_root" "text",
    "last_heartbeat_at" timestamp with time zone,
    "paired_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "devices_platform_check" CHECK (("platform" = ANY (ARRAY['macos'::"text", 'windows'::"text", 'linux'::"text", 'other'::"text"]))),
    CONSTRAINT "devices_status_check" CHECK (("status" = ANY (ARRAY['online'::"text", 'offline'::"text", 'revoked'::"text"])))
);

ALTER TABLE "public"."devices" OWNER TO "postgres";
ALTER TABLE ONLY "public"."devices" ADD CONSTRAINT "devices_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."devices" ADD CONSTRAINT "devices_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."devices" ADD CONSTRAINT "devices_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "devices_auth_user_id_key" ON "public"."devices" USING "btree" ("auth_user_id") WHERE ("auth_user_id" IS NOT NULL);

CREATE TABLE IF NOT EXISTS "public"."device_pairing_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "device_name_hint" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "device_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."device_pairing_codes" OWNER TO "postgres";
ALTER TABLE ONLY "public"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "device_pairing_codes_active_code_idx" ON "public"."device_pairing_codes" USING "btree" ("code") WHERE ("consumed_at" IS NULL);

-- ---------------------------------------------------------------------------
-- task / tool_execution columns for device dispatch
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."tasks" ADD COLUMN IF NOT EXISTS "assigned_device" "uuid";
ALTER TABLE "public"."tasks" ADD COLUMN IF NOT EXISTS "checkpoint" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL;
DO $$
BEGIN
  ALTER TABLE ONLY "public"."tasks" ADD CONSTRAINT "tasks_assigned_device_fkey" FOREIGN KEY ("assigned_device") REFERENCES "public"."devices"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TABLE "public"."tasks" DROP CONSTRAINT IF EXISTS "tasks_status_check";
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'queued'::"text", 'running'::"text", 'waiting_approval'::"text", 'waiting_device'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])));

ALTER TABLE "public"."tool_executions" ADD COLUMN IF NOT EXISTS "assigned_device" "uuid";
DO $$
BEGIN
  ALTER TABLE ONLY "public"."tool_executions" ADD CONSTRAINT "tool_executions_assigned_device_fkey" FOREIGN KEY ("assigned_device") REFERENCES "public"."devices"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."current_device_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id
  from public.devices
  where auth_user_id = auth.uid()
    and status <> 'revoked'
  limit 1;
$$;

ALTER FUNCTION "public"."current_device_id"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."current_device_id"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."current_device_id"() TO "authenticated";

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."device_pairing_codes" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage devices" ON "public"."devices";
CREATE POLICY "Admins can manage devices" ON "public"."devices" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());

DROP POLICY IF EXISTS "Devices can read their own row" ON "public"."devices";
CREATE POLICY "Devices can read their own row" ON "public"."devices" FOR SELECT TO "authenticated" USING ("auth_user_id" = "auth"."uid"());

DROP POLICY IF EXISTS "Devices can heartbeat their own row" ON "public"."devices";
CREATE POLICY "Devices can heartbeat their own row" ON "public"."devices" FOR UPDATE TO "authenticated" USING ("auth_user_id" = "auth"."uid"()) WITH CHECK ("auth_user_id" = "auth"."uid"());

DROP POLICY IF EXISTS "Admins can manage pairing codes" ON "public"."device_pairing_codes";
CREATE POLICY "Admins can manage pairing codes" ON "public"."device_pairing_codes" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());

DROP POLICY IF EXISTS "Devices can read their assigned tasks" ON "public"."tasks";
CREATE POLICY "Devices can read their assigned tasks" ON "public"."tasks" FOR SELECT TO "authenticated" USING ("assigned_device" = "public"."current_device_id"());

DROP POLICY IF EXISTS "Devices can read their assigned tool executions" ON "public"."tool_executions";
CREATE POLICY "Devices can read their assigned tool executions" ON "public"."tool_executions" FOR SELECT TO "authenticated" USING ("assigned_device" = "public"."current_device_id"());

DROP POLICY IF EXISTS "Devices can update their assigned tool executions" ON "public"."tool_executions";
CREATE POLICY "Devices can update their assigned tool executions" ON "public"."tool_executions" FOR UPDATE TO "authenticated" USING ("assigned_device" = "public"."current_device_id"()) WITH CHECK ("assigned_device" = "public"."current_device_id"());

DROP POLICY IF EXISTS "Devices can log progress on their tasks" ON "public"."task_logs";
CREATE POLICY "Devices can log progress on their tasks" ON "public"."task_logs" FOR INSERT TO "authenticated" WITH CHECK (EXISTS (SELECT 1 FROM "public"."tasks" "t" WHERE "t"."id" = "task_id" AND "t"."assigned_device" = "public"."current_device_id"()));

DROP POLICY IF EXISTS "Devices can read logs on their tasks" ON "public"."task_logs";
CREATE POLICY "Devices can read logs on their tasks" ON "public"."task_logs" FOR SELECT TO "authenticated" USING (EXISTS (SELECT 1 FROM "public"."tasks" "t" WHERE "t"."id" = "task_id" AND "t"."assigned_device" = "public"."current_device_id"()));

DROP POLICY IF EXISTS "Devices can read device-scoped tools" ON "public"."tools";
CREATE POLICY "Devices can read device-scoped tools" ON "public"."tools" FOR SELECT TO "authenticated" USING ("public"."current_device_id"() IS NOT NULL AND "category" IN ('files', 'system'));

-- ---------------------------------------------------------------------------
-- Realtime: no table had ever been added to the supabase_realtime
-- publication, so Control Center pages relying on postgres_changes
-- (Tasks/Approvals/Devices) would silently never receive live updates.
-- ---------------------------------------------------------------------------

DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."tasks"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."approvals"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."tool_executions"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."task_logs"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."devices"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."conversation_messages"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
DO $$ BEGIN ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."conversations"; EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

-- ---------------------------------------------------------------------------
-- Reaper: stale task/device recovery. Runs every 5 minutes via pg_cron.
-- A stuck "running" or "waiting_approval" task fails out with a timeout
-- error; a "waiting_device" task whose device went offline is requeued
-- (not failed) so it resumes automatically once a device reconnects.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."reap_stalled_tasks"(
  "running_timeout_minutes" integer DEFAULT 15,
  "approval_timeout_minutes" integer DEFAULT 1440
) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  reaped_ids uuid[];
  requeued_count integer := 0;
BEGIN
  WITH stalled AS (
    UPDATE public.tasks
    SET status = 'failed',
        error = jsonb_build_object(
          'message', CASE
            WHEN status = 'waiting_approval'
              THEN 'Task timed out: approval was not decided within ' || approval_timeout_minutes || ' minutes.'
            ELSE 'Task timed out: no progress for ' || running_timeout_minutes || ' minutes.'
          END,
          'reaped_at', now()
        ),
        completed_at = now(),
        updated_at = now()
    WHERE (status = 'running' AND updated_at < now() - make_interval(mins => running_timeout_minutes))
       OR (status = 'waiting_approval' AND updated_at < now() - make_interval(mins => approval_timeout_minutes))
    RETURNING id
  )
  SELECT array_agg(id) INTO reaped_ids FROM stalled;

  IF reaped_ids IS NOT NULL THEN
    UPDATE public.approvals
    SET status = 'expired', decided_at = now()
    WHERE status = 'pending' AND task_id = ANY(reaped_ids);

    UPDATE public.tool_executions
    SET status = 'failed',
        error = jsonb_build_object('message', 'Tool execution timed out because its task was reaped.'),
        completed_at = now(),
        updated_at = now()
    WHERE status IN ('pending', 'approved', 'running') AND task_id = ANY(reaped_ids);

    INSERT INTO public.task_logs (task_id, level, message, data)
    SELECT id, 'error', 'Task automatically marked as failed by the stalled-task reaper.', jsonb_build_object('reaped_at', now())
    FROM unnest(reaped_ids) AS id;
  END IF;

  WITH stale_device_tasks AS (
    UPDATE public.tasks t
    SET status = 'queued', assigned_device = NULL, updated_at = now()
    FROM public.devices d
    WHERE t.assigned_device = d.id
      AND t.status = 'waiting_device'
      AND (d.last_heartbeat_at IS NULL OR d.last_heartbeat_at < now() - make_interval(mins => running_timeout_minutes))
    RETURNING t.id
  )
  INSERT INTO public.task_logs (task_id, level, message, data)
  SELECT id, 'warning', 'Device went offline; task requeued to resume when it reconnects.', jsonb_build_object('requeued_at', now())
  FROM stale_device_tasks;

  GET DIAGNOSTICS requeued_count = ROW_COUNT;

  UPDATE public.tool_executions te
  SET status = 'pending', assigned_device = NULL, updated_at = now()
  FROM public.devices d
  WHERE te.assigned_device = d.id
    AND te.status IN ('pending', 'approved', 'running')
    AND (d.last_heartbeat_at IS NULL OR d.last_heartbeat_at < now() - make_interval(mins => running_timeout_minutes));

  UPDATE public.devices
  SET status = 'offline'
  WHERE status = 'online'
    AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - make_interval(mins => running_timeout_minutes));

  RETURN COALESCE(array_length(reaped_ids, 1), 0) + requeued_count;
END;
$$;

ALTER FUNCTION "public"."reap_stalled_tasks"(integer, integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reap_stalled_tasks"(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."reap_stalled_tasks"(integer, integer) TO "service_role";

CREATE EXTENSION IF NOT EXISTS "pg_cron";
GRANT USAGE ON SCHEMA "cron" TO "postgres";

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'yahalla-reap-stalled-tasks';
EXCEPTION
  WHEN undefined_table OR undefined_function THEN NULL;
END;
$$;

SELECT cron.schedule(
  'yahalla-reap-stalled-tasks',
  '*/5 * * * *',
  $$SELECT public.reap_stalled_tasks();$$
);
