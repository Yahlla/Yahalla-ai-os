-- Closes two real gaps found while completing Yahalla Core into a genuine
-- coding agent (not just a chatbot) and adding GitHub integration:
--
-- 1. yahalla-core -- the agent the Control Center actually talks to by
--    default (src/App.tsx defaults selectedAgent to 'yahalla-core') -- was
--    only ever granted yahalla.read, read_project_file, list_project_files
--    and git_status by the seed/device-execution migrations. It had no
--    write_project_file, patch_project_file, git_diff or
--    run_project_command, so it could read a project but never modify or
--    verify anything: "read a file -> edit it -> verify -> run the test"
--    was structurally impossible for the agent users actually chat with.
--
-- 2. GitHub integration did not exist beyond two placeholder tool rows
--    (github.read/github.write) that were wired to nothing. This adds the
--    local git_create_branch/git_commit/git_push device tools (they run on
--    the paired Device Agent, against the real local checkout, using
--    whatever git credential helper is already configured on that
--    machine -- no token is ever stored or seen by this platform for the
--    push step) and grants them plus github.read/github.write (repo
--    list/create, implemented in the edge function against the GitHub API)
--    to yahalla-core and developer.

-- ---------------------------------------------------------------------------
-- New device-scoped git tools (category 'system' -- already covered by the
-- existing "Devices can read device-scoped tools" RLS policy and by the
-- authenticated GRANT on tools/agent_tools from 20260812020000_*).
-- ---------------------------------------------------------------------------

INSERT INTO "public"."tools" ("key", "name_ar", "name_de", "description", "category", "status", "requires_approval", "configuration")
VALUES
  ('git_create_branch', 'إنشاء فرع git', 'Git-Branch erstellen', 'Create and switch to a new local git branch.', 'system', 'active', false, '{}'::"jsonb"),
  ('git_commit', 'حفظ commit', 'Commit erstellen', 'Stage all changes and create a git commit.', 'system', 'active', true, '{}'::"jsonb"),
  ('git_push', 'رفع إلى GitHub', 'Zu GitHub pushen', 'Push the current branch to a remote (optionally setting/creating origin first).', 'system', 'active', true, '{}'::"jsonb")
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Give yahalla-core the full coding-agent toolset.
-- ---------------------------------------------------------------------------

INSERT INTO "public"."agent_tools" ("agent_id", "tool_id", "enabled")
SELECT a."id", t."id", true
FROM "public"."agents" a
CROSS JOIN "public"."tools" t
WHERE a."key" = 'yahalla-core'
  AND t."key" IN (
    'write_project_file', 'patch_project_file', 'git_diff', 'run_project_command',
    'git_create_branch', 'git_commit', 'git_push', 'github.read', 'github.write'
  )
ON CONFLICT ("agent_id", "tool_id") DO UPDATE SET enabled = true;

-- developer already has read/write/patch/git_status/git_diff/run; add the
-- new git/GitHub tools so it can finish a task end to end too.
INSERT INTO "public"."agent_tools" ("agent_id", "tool_id", "enabled")
SELECT a."id", t."id", true
FROM "public"."agents" a
CROSS JOIN "public"."tools" t
WHERE a."key" = 'developer'
  AND t."key" IN ('git_create_branch', 'git_commit', 'git_push', 'github.read', 'github.write')
ON CONFLICT ("agent_id", "tool_id") DO UPDATE SET enabled = true;

-- ---------------------------------------------------------------------------
-- The seed migration hardcoded yahalla-core's tool-call round budget to 5
-- (agents.configuration->>'max_rounds'). That's too tight for a real
-- plan -> execute -> test -> diagnose -> fix -> retest cycle -- each round
-- is one LLM call, and a single fix-and-verify pass can use most of that
-- on its own. The edge function now reads this value (falls back to 12 if
-- absent/invalid); raise yahalla-core's to something that actually fits a
-- multi-step coding task.
-- ---------------------------------------------------------------------------

UPDATE "public"."agents"
SET configuration = "configuration" || '{"max_rounds": 15}'::"jsonb"
WHERE "key" = 'yahalla-core';
