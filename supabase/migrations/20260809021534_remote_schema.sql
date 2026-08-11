SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
COMMENT ON SCHEMA "public" IS 'standard public schema';
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
CREATE OR REPLACE FUNCTION "public"."has_permission"("permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.profiles p
    join public.role_permissions rp
      on rp.role = p.role
    join public.permissions perm
      on perm.id = rp.permission_id
    where p.id = auth.uid()
      and perm.key = permission_key
  );
$$;
ALTER FUNCTION "public"."has_permission"("permission_key" "text") OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;
ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;
ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";
SET default_tablespace = '';
SET default_table_access_method = "heap";
CREATE TABLE IF NOT EXISTS "public"."agent_permissions" (
    "agent_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."agent_permissions" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."agent_tools" (
    "agent_id" "uuid" NOT NULL,
    "tool_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."agent_tools" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "name_ar" "text" NOT NULL,
    "name_de" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "configuration" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agents_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'disabled'::"text"])))
);
ALTER TABLE "public"."agents" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."ai_memory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" DEFAULT 'global'::"text" NOT NULL,
    "owner_id" "uuid",
    "agent_id" "uuid",
    "task_id" "uuid",
    "memory_key" "text" NOT NULL,
    "content" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "importance" integer DEFAULT 50 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_memory_importance_check" CHECK ((("importance" >= 0) AND ("importance" <= 100))),
    CONSTRAINT "ai_memory_scope_check" CHECK (("scope" = ANY (ARRAY['global'::"text", 'user'::"text", 'agent'::"text", 'project'::"text", 'task'::"text"])))
);
ALTER TABLE "public"."ai_memory" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tool_execution_id" "uuid",
    "task_id" "uuid",
    "requested_by" "uuid",
    "decided_by" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason" "text",
    "decision_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    CONSTRAINT "approvals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text", 'cancelled'::"text"])))
);
ALTER TABLE "public"."approvals" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid",
    "agent_id" "uuid",
    "task_id" "uuid",
    "action" "text" NOT NULL,
    "resource_type" "text",
    "resource_id" "uuid",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."audit_logs" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."knowledge_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "language" "text" DEFAULT 'ar'::"text" NOT NULL,
    "source_type" "text" DEFAULT 'manual'::"text" NOT NULL,
    "source_reference" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "knowledge_documents_language_check" CHECK (("language" = ANY (ARRAY['ar'::"text", 'de'::"text", 'en'::"text", 'other'::"text"]))),
    CONSTRAINT "knowledge_documents_source_type_check" CHECK (("source_type" = ANY (ARRAY['manual'::"text", 'document'::"text", 'website'::"text", 'database'::"text", 'system'::"text"])))
);
ALTER TABLE "public"."knowledge_documents" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "name_ar" "text" NOT NULL,
    "name_de" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."permissions" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "full_name" "text",
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])))
);
ALTER TABLE "public"."profiles" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role" "text" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "role_permissions_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])))
);
ALTER TABLE "public"."role_permissions" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."task_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "level" "text" DEFAULT 'info'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "task_logs_level_check" CHECK (("level" = ANY (ARRAY['debug'::"text", 'info'::"text", 'warning'::"text", 'error'::"text"])))
);
ALTER TABLE "public"."task_logs" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "requested_by" "uuid",
    "assigned_agent" "uuid",
    "input" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tasks_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'queued'::"text", 'running'::"text", 'waiting_approval'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);
ALTER TABLE "public"."tasks" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."tool_execution_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "level" "text" DEFAULT 'info'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tool_execution_logs_level_check" CHECK (("level" = ANY (ARRAY['debug'::"text", 'info'::"text", 'warning'::"text", 'error'::"text"])))
);
ALTER TABLE "public"."tool_execution_logs" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."tool_executions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tool_id" "uuid" NOT NULL,
    "agent_id" "uuid",
    "task_id" "uuid",
    "requested_by" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "input" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output" "jsonb",
    "error" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tool_executions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text", 'rejected'::"text", 'cancelled'::"text"])))
);
ALTER TABLE "public"."tool_executions" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."tool_permissions" (
    "tool_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."tool_permissions" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."tools" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "name_ar" "text" NOT NULL,
    "name_de" "text" NOT NULL,
    "description" "text",
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "requires_approval" boolean DEFAULT true NOT NULL,
    "configuration" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tools_category_check" CHECK (("category" = ANY (ARRAY['general'::"text", 'database'::"text", 'api'::"text", 'github'::"text", 'email'::"text", 'files'::"text", 'web'::"text", 'system'::"text", 'yahalla'::"text"]))),
    CONSTRAINT "tools_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'disabled'::"text"])))
);
ALTER TABLE "public"."tools" OWNER TO "postgres";
ALTER TABLE ONLY "public"."agent_permissions"
    ADD CONSTRAINT "agent_permissions_pkey" PRIMARY KEY ("agent_id", "permission_id");
ALTER TABLE ONLY "public"."agent_tools"
    ADD CONSTRAINT "agent_tools_pkey" PRIMARY KEY ("agent_id", "tool_id");
ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_key_key" UNIQUE ("key");
ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."ai_memory"
    ADD CONSTRAINT "ai_memory_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."knowledge_documents"
    ADD CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_key_key" UNIQUE ("key");
ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role", "permission_id");
ALTER TABLE ONLY "public"."task_logs"
    ADD CONSTRAINT "task_logs_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."tool_execution_logs"
    ADD CONSTRAINT "tool_execution_logs_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."tool_executions"
    ADD CONSTRAINT "tool_executions_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."tool_permissions"
    ADD CONSTRAINT "tool_permissions_pkey" PRIMARY KEY ("tool_id", "permission_id");
ALTER TABLE ONLY "public"."tools"
    ADD CONSTRAINT "tools_key_key" UNIQUE ("key");
ALTER TABLE ONLY "public"."tools"
    ADD CONSTRAINT "tools_pkey" PRIMARY KEY ("id");
CREATE INDEX "idx_approvals_execution" ON "public"."approvals" USING "btree" ("tool_execution_id");
CREATE INDEX "idx_approvals_status" ON "public"."approvals" USING "btree" ("status");
CREATE INDEX "idx_audit_actor" ON "public"."audit_logs" USING "btree" ("actor_user_id");
CREATE INDEX "idx_audit_agent" ON "public"."audit_logs" USING "btree" ("agent_id");
CREATE INDEX "idx_audit_created" ON "public"."audit_logs" USING "btree" ("created_at" DESC);
CREATE INDEX "idx_knowledge_category" ON "public"."knowledge_documents" USING "btree" ("category");
CREATE INDEX "idx_memory_agent" ON "public"."ai_memory" USING "btree" ("agent_id");
CREATE INDEX "idx_memory_key" ON "public"."ai_memory" USING "btree" ("memory_key");
CREATE INDEX "idx_memory_scope" ON "public"."ai_memory" USING "btree" ("scope");
CREATE INDEX "idx_task_logs_task" ON "public"."task_logs" USING "btree" ("task_id");
CREATE INDEX "idx_tasks_agent" ON "public"."tasks" USING "btree" ("assigned_agent");
CREATE INDEX "idx_tasks_status" ON "public"."tasks" USING "btree" ("status");
CREATE INDEX "idx_tool_executions_agent" ON "public"."tool_executions" USING "btree" ("agent_id");
CREATE INDEX "idx_tool_executions_status" ON "public"."tool_executions" USING "btree" ("status");
CREATE INDEX "idx_tool_executions_task" ON "public"."tool_executions" USING "btree" ("task_id");
CREATE INDEX "idx_tool_executions_tool" ON "public"."tool_executions" USING "btree" ("tool_id");
CREATE INDEX "idx_tool_logs_execution" ON "public"."tool_execution_logs" USING "btree" ("execution_id");
ALTER TABLE ONLY "public"."agent_permissions"
    ADD CONSTRAINT "agent_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."agent_permissions"
    ADD CONSTRAINT "agent_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."agent_tools"
    ADD CONSTRAINT "agent_tools_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."agent_tools"
    ADD CONSTRAINT "agent_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."ai_memory"
    ADD CONSTRAINT "ai_memory_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id");
ALTER TABLE ONLY "public"."ai_memory"
    ADD CONSTRAINT "ai_memory_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."ai_memory"
    ADD CONSTRAINT "ai_memory_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id");
ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_tool_execution_id_fkey" FOREIGN KEY ("tool_execution_id") REFERENCES "public"."tool_executions"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id");
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id");
ALTER TABLE ONLY "public"."knowledge_documents"
    ADD CONSTRAINT "knowledge_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."task_logs"
    ADD CONSTRAINT "task_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assigned_agent_fkey" FOREIGN KEY ("assigned_agent") REFERENCES "public"."agents"("id");
ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."tool_execution_logs"
    ADD CONSTRAINT "tool_execution_logs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "public"."tool_executions"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."tool_executions"
    ADD CONSTRAINT "tool_executions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id");
ALTER TABLE ONLY "public"."tool_executions"
    ADD CONSTRAINT "tool_executions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."tool_executions"
    ADD CONSTRAINT "tool_executions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id");
ALTER TABLE ONLY "public"."tool_executions"
    ADD CONSTRAINT "tool_executions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id");
ALTER TABLE ONLY "public"."tool_permissions"
    ADD CONSTRAINT "tool_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."tool_permissions"
    ADD CONSTRAINT "tool_permissions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."tools"
    ADD CONSTRAINT "tools_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");
CREATE POLICY "Admins can create approvals" ON "public"."approvals" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can create tasks" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can create tool executions" ON "public"."tool_executions" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can decide approvals" ON "public"."approvals" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can manage AI memory" ON "public"."ai_memory" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can manage knowledge" ON "public"."knowledge_documents" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can read AI memory" ON "public"."ai_memory" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read agent permissions" ON "public"."agent_permissions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read agent tools" ON "public"."agent_tools" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read agents" ON "public"."agents" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read approvals" ON "public"."approvals" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read audit logs" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read knowledge" ON "public"."knowledge_documents" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read permissions" ON "public"."permissions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read role permissions" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read task logs" ON "public"."task_logs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read tasks" ON "public"."tasks" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read tool execution logs" ON "public"."tool_execution_logs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read tool executions" ON "public"."tool_executions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read tool permissions" ON "public"."tool_permissions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can read tools" ON "public"."tools" FOR SELECT TO "authenticated" USING ("public"."is_admin"());
CREATE POLICY "Admins can update tasks" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());
CREATE POLICY "Admins can update tool executions" ON "public"."tool_executions" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());
CREATE POLICY "Authenticated users can create audit logs" ON "public"."audit_logs" FOR INSERT TO "authenticated" WITH CHECK ((("actor_user_id" = "auth"."uid"()) OR ("actor_user_id" IS NULL)));
CREATE POLICY "Owners can manage agent permissions" ON "public"."agent_permissions" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text")))));
CREATE POLICY "Owners can manage agent tools" ON "public"."agent_tools" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text")))));
CREATE POLICY "Owners can manage agents" ON "public"."agents" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text")))));
CREATE POLICY "Owners can manage tool permissions" ON "public"."tool_permissions" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text")))));
CREATE POLICY "Owners can manage tools" ON "public"."tools" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"text")))));
CREATE POLICY "Users can read their own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "id") OR "public"."is_admin"()));
ALTER TABLE "public"."agent_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_tools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."knowledge_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."task_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tool_execution_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tool_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tool_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tools" ENABLE ROW LEVEL SECURITY;
ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
REVOKE ALL ON FUNCTION "public"."has_permission"("permission_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_permission"("permission_key" "text") TO "authenticated";
REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agent_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agent_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_permissions" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agent_tools" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agent_tools" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_tools" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agents" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."agents" TO "authenticated";
GRANT ALL ON TABLE "public"."agents" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ai_memory" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ai_memory" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_memory" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."approvals" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."approvals" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_logs" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."knowledge_documents" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."knowledge_documents" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."knowledge_documents" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."role_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."task_logs" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."task_logs" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."task_logs" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tasks" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_execution_logs" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_execution_logs" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_execution_logs" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_executions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_executions" TO "authenticated";
GRANT ALL ON TABLE "public"."tool_executions" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_permissions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_permissions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tool_permissions" TO "service_role";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tools" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tools" TO "authenticated";
GRANT ALL ON TABLE "public"."tools" TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";
drop extension if exists "pg_net";
