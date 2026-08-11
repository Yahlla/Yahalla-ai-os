-- Fix: the "authenticated" role has never had base table privileges on any
-- table created by the original 20260809021534_remote_schema.sql migration
-- -- only REFERENCES/TRIGGER/TRUNCATE/MAINTAIN (see its
-- "ALTER DEFAULT PRIVILEGES ... FOR ROLE postgres" grants), never SELECT/
-- INSERT/UPDATE/DELETE. PostgreSQL requires the base table GRANT *in
-- addition to* a passing Row Level Security policy: RLS only ever
-- restricts which rows a statement can see/touch, it can never substitute
-- for the underlying privilege. Without it, Postgres fails the query
-- before RLS is even evaluated:
--
--   code: 42501, message: "permission denied for table profiles"
--
-- This is confirmed by the newer 20260810114126_*.sql migration, which
-- *does* correctly grant its own new tables (servers/models/projects/
-- conversations/...) at the very end -- proving the gap is specifically
-- the older tables nobody went back and granted. The same gap silently
-- affects every one of them: the Tasks/Approvals/Devices pages (queried
-- directly by the browser's authenticated session) and the Device Agent's
-- own direct Postgrest calls (heartbeat, claiming/updating
-- tool_executions, reading tools, writing task_logs) would all fail the
-- same way the moment they were exercised against the real database.
--
-- Grants below are scoped to exactly the operations each table's existing
-- RLS policies already support for "authenticated" -- never broader. RLS
-- continues to do the actual row-level restriction: e.g. GRANT SELECT +
-- the existing "own row or admin" policy on profiles means a user can
-- query the table at all, but still only ever sees their own row (or
-- every row, only if their profile role is owner/admin).

GRANT SELECT ON "public"."profiles" TO "authenticated";

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."agents" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."agent_tools" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."agent_permissions" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ai_memory" TO "authenticated";
GRANT SELECT, INSERT, UPDATE ON "public"."approvals" TO "authenticated";
GRANT SELECT, INSERT ON "public"."audit_logs" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."knowledge_documents" TO "authenticated";
GRANT SELECT ON "public"."permissions" TO "authenticated";
GRANT SELECT ON "public"."role_permissions" TO "authenticated";
GRANT SELECT, INSERT ON "public"."task_logs" TO "authenticated";
GRANT SELECT, INSERT, UPDATE ON "public"."tasks" TO "authenticated";
GRANT SELECT ON "public"."tool_execution_logs" TO "authenticated";
GRANT SELECT, INSERT, UPDATE ON "public"."tool_executions" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tool_permissions" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tools" TO "authenticated";

-- devices / device_pairing_codes (added in
-- 20260812010000_device_execution_unified.sql) never had any table-level
-- grant to authenticated at all -- same class of bug, brand new table.
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."devices" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."device_pairing_codes" TO "authenticated";
