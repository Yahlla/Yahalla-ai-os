/*
# Yahalla AI Platform — Seed Data

## Overview
Populates the platform with the baseline configuration required for
multi-agent orchestration, multi-model routing, RBAC, and tool execution.

## Data Inserted
1. Permissions — 16 permission keys covering all platform areas.
2. Role-permission mappings — owner gets all; admin gets most; developer/operator/user/viewer get scoped subsets.
3. Servers — one local execution node (127.0.0.1:8787).
4. Models — placeholder local models (marked status='unknown' until a real runtime is reachable).
5. Agents — Yahalla Core (orchestrator) + 12 specialized agents.
6. Tools — read_project_file, write_project_file, patch_project_file, git_status, git_diff, run_project_command, yahalla.read, web.search, github.read, github.write, email.send, yahalla.api.
7. Agent-tools mappings — each agent gets the tools it needs.
8. Agent-permissions mappings — each agent gets the permissions it needs.

## Notes
1. All inserts are idempotent (ON CONFLICT DO NOTHING).
2. Existing rows are preserved.
3. Models are marked 'unknown' — not 'online' — because no real runtime is confirmed reachable.
*/

-- =============================================================
-- 1. Permissions
-- =============================================================

INSERT INTO permissions (key, name_ar, name_de, description) VALUES
  ('chat', 'محادثة', 'Chat', 'Access to AI chat'),
  ('projects', 'مشاريع', 'Projekte', 'Access to projects'),
  ('files', 'ملفات', 'Dateien', 'Access to project files'),
  ('read_code', 'قراءة الكود', 'Code lesen', 'Read source code'),
  ('write_code', 'كتابة الكود', 'Code schreiben', 'Modify source code'),
  ('execute_commands', 'تنفيذ الأوامر', 'Befehle ausführen', 'Run shell commands'),
  ('web', 'ويب', 'Web', 'Web research access'),
  ('database', 'قاعدة البيانات', 'Datenbank', 'Database management'),
  ('agents', 'وكلاء', 'Agenten', 'Agent management'),
  ('tasks', 'مهام', 'Aufgaben', 'Task management'),
  ('servers', 'خوادم', 'Server', 'Server management'),
  ('models', 'نماذج', 'Modelle', 'Model management'),
  ('tools', 'أدوات', 'Werkzeuge', 'Tool management'),
  ('deployments', 'نشر', 'Deployments', 'Deployment management'),
  ('admin', 'إدارة', 'Administration', 'Admin control center'),
  ('approvals', 'موافقات', 'Genehmigungen', 'Approve or reject dangerous actions')
ON CONFLICT (key) DO NOTHING;
-- =============================================================
-- 2. Role-permission mappings
-- =============================================================

DO $$
DECLARE
  perm_record RECORD;
  owner_only_keys text[] := ARRAY['admin','servers','models','deployments','approvals'];
BEGIN
  -- Owner gets every permission
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    INSERT INTO role_permissions (role, permission_id)
    VALUES ('owner', perm_record.id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Admin gets everything except admin-only infra (servers, models, deployments) but gets approvals
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    IF perm_record.key NOT IN ('servers','models','deployments') THEN
      INSERT INTO role_permissions (role, permission_id)
      VALUES ('admin', perm_record.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Developer: chat, projects, files, read_code, write_code, execute_commands, web, tasks, agents, tools
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    IF perm_record.key IN ('chat','projects','files','read_code','write_code','execute_commands','web','tasks','agents','tools','database') THEN
      INSERT INTO role_permissions (role, permission_id)
      VALUES ('developer', perm_record.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Operator: chat, projects, tasks, agents, tools, execute_commands, database, web
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    IF perm_record.key IN ('chat','projects','tasks','agents','tools','execute_commands','database','web') THEN
      INSERT INTO role_permissions (role, permission_id)
      VALUES ('operator', perm_record.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- User: chat, projects, tasks
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    IF perm_record.key IN ('chat','projects','tasks') THEN
      INSERT INTO role_permissions (role, permission_id)
      VALUES ('user', perm_record.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Viewer: chat only (read-only)
  FOR perm_record IN SELECT id, key FROM permissions LOOP
    IF perm_record.key IN ('chat','projects') THEN
      INSERT INTO role_permissions (role, permission_id)
      VALUES ('viewer', perm_record.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
-- =============================================================
-- 3. Local server
-- =============================================================

INSERT INTO servers (name, type, hostname, port, status, runtime_version, capabilities)
VALUES (
  'Local Runtime',
  'local',
  '127.0.0.1',
  8787,
  'unknown',
  'yahalla-runtime-0.1',
  '{"agent_runtime": true, "llm": true, "tools": true, "file_access": true}'::jsonb
)
ON CONFLICT DO NOTHING;
-- =============================================================
-- 4. Models (status='unknown' until real runtime confirms)
-- =============================================================

DO $$
DECLARE
  local_server uuid;
BEGIN
  SELECT id INTO local_server FROM servers WHERE hostname = '127.0.0.1' AND port = 8787 LIMIT 1;

  IF local_server IS NOT NULL THEN
    INSERT INTO models (server_id, key, name, provider, type, endpoint, context_length, tool_calling_support, reasoning_support, coding_capability, status, priority, enabled, is_local, configuration)
    VALUES
      (local_server, 'yahalla-core', 'Yahalla Core (Local)', 'openai-compatible', 'general', '/v1/chat/completions', 8192, true, false, false, 'unknown', 90, true, true, '{}'::jsonb),
      (local_server, 'coding-local', 'Coding Model (Local)', 'openai-compatible', 'coding', '/v1/chat/completions', 8192, true, false, true, 'unknown', 80, true, true, '{}'::jsonb),
      (local_server, 'reasoning-local', 'Reasoning Model (Local)', 'openai-compatible', 'reasoning', '/v1/chat/completions', 8192, true, true, false, 'unknown', 70, true, true, '{}'::jsonb),
      (local_server, 'embedding-local', 'Embedding Model (Local)', 'openai-compatible', 'embedding', '/v1/embeddings', 2048, false, false, false, 'unknown', 60, true, true, '{}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
-- =============================================================
-- 5. Agents
-- =============================================================

DO $$
DECLARE
  local_server uuid;
  general_model uuid;
  coding_model uuid;
  reasoning_model uuid;
BEGIN
  SELECT id INTO local_server FROM servers WHERE hostname = '127.0.0.1' AND port = 8787 LIMIT 1;
  SELECT id INTO general_model FROM models WHERE key = 'yahalla-core' LIMIT 1;
  SELECT id INTO coding_model FROM models WHERE key = 'coding-local' LIMIT 1;
  SELECT id INTO reasoning_model FROM models WHERE key = 'reasoning-local' LIMIT 1;

  INSERT INTO agents (key, name_ar, name_de, description, status, role, server_id, model_id, fallback_model_id, configuration)
  VALUES
    ('yahalla-core', 'يحalla الأساسي', 'Yahalla Core', 'Central orchestrator that plans, routes, and coordinates all agents.', 'active', 'orchestrator', local_server, general_model, reasoning_model, '{"autonomous": true, "max_rounds": 5}'::jsonb),
    ('planner', 'المخطط', 'Planner Agent', 'Breaks down complex requests into actionable steps.', 'active', 'planner', local_server, general_model, NULL, '{}'::jsonb),
    ('developer', 'المطور', 'Developer Agent', 'Writes, patches, and verifies code.', 'active', 'developer', local_server, coding_model, general_model, '{"can_write_files": true}'::jsonb),
    ('researcher', 'الباحث', 'Research Agent', 'Searches the web and summarizes findings.', 'active', 'researcher', local_server, general_model, NULL, '{}'::jsonb),
    ('debugger', 'المصلح', 'Debugger Agent', 'Diagnoses errors and proposes fixes.', 'active', 'debugger', local_server, coding_model, general_model, '{}'::jsonb),
    ('tester', 'المختبر', 'Tester Agent', 'Runs tests and reports results.', 'active', 'tester', local_server, coding_model, NULL, '{}'::jsonb),
    ('security', 'الأمان', 'Security Agent', 'Audits code and configuration for vulnerabilities.', 'active', 'security', local_server, reasoning_model, general_model, '{}'::jsonb),
    ('database', 'قاعدة البيانات', 'Database Agent', 'Inspects and diagnoses database schema, migrations, and RLS.', 'active', 'database', local_server, general_model, NULL, '{}'::jsonb),
    ('devops', 'العمليات', 'DevOps Agent', 'Manages builds, deployments, and runtime health.', 'active', 'devops', local_server, general_model, NULL, '{}'::jsonb),
    ('file', 'الملفات', 'File Agent', 'Reads and navigates project files.', 'active', 'file', local_server, general_model, NULL, '{}'::jsonb),
    ('reviewer', 'المراجع', 'Reviewer Agent', 'Reviews code changes for quality and correctness.', 'active', 'reviewer', local_server, reasoning_model, general_model, '{}'::jsonb),
    ('vision', 'الرؤية', 'Vision Agent', 'Analyzes images and visual content.', 'active', 'vision', local_server, general_model, NULL, '{}'::jsonb),
    ('docs', 'التوثيق', 'Documentation Agent', 'Generates and updates documentation.', 'active', 'docs', local_server, general_model, NULL, '{}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
END $$;
-- =============================================================
-- 6. Tools
-- =============================================================

INSERT INTO tools (key, name_ar, name_de, description, category, status, requires_approval, configuration)
VALUES
  ('read_project_file', 'قراءة ملف', 'Datei lesen', 'Read a file from the project workspace.', 'files', 'active', false, '{}'::jsonb),
  ('write_project_file', 'كتابة ملف', 'Datei schreiben', 'Write or overwrite a file in the project workspace.', 'files', 'active', true, '{}'::jsonb),
  ('patch_project_file', 'تعديل ملف', 'Datei patchen', 'Apply a targeted patch to an existing file.', 'files', 'active', true, '{}'::jsonb),
  ('git_status', 'حالة git', 'Git Status', 'Show the working tree status.', 'system', 'active', false, '{}'::jsonb),
  ('git_diff', 'فروق git', 'Git Diff', 'Show unstaged or staged changes.', 'system', 'active', false, '{}'::jsonb),
  ('run_project_command', 'تنفيذ أمر', 'Befehl ausführen', 'Run a safe shell command in the project root.', 'system', 'active', true, '{"allowlist": ["npm run build", "npm run lint", "npm test", "tsc --noEmit", "git status", "git diff", "git log"]}'::jsonb),
  ('yahalla.read', 'قراءة يحalla', 'Yahalla Read', 'Read authorized Yahalla system data (tasks, agents, tools, memory, runtime).', 'yahalla', 'active', false, '{}'::jsonb),
  ('web.search', 'بحث ويب', 'Websuche', 'Search the web for public information.', 'web', 'active', false, '{}'::jsonb),
  ('github.read', 'قراءة github', 'GitHub Read', 'Read authorized GitHub repository information.', 'github', 'active', false, '{}'::jsonb),
  ('github.write', 'كتابة github', 'GitHub Write', 'Modify authorized GitHub repository content.', 'github', 'active', true, '{}'::jsonb),
  ('email.send', 'إرسال بريد', 'E-Mail senden', 'Send an email to a recipient.', 'email', 'active', true, '{}'::jsonb),
  ('yahalla.api', 'API يحalla', 'Yahalla API', 'Perform an authorized Yahalla API operation.', 'yahalla', 'active', true, '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
-- =============================================================
-- 7. Agent-tool mappings
-- =============================================================

DO $$
DECLARE
  core_id uuid;
  planner_id uuid;
  dev_id uuid;
  research_id uuid;
  debug_id uuid;
  tester_id uuid;
  sec_id uuid;
  db_id uuid;
  devops_id uuid;
  file_id uuid;
  review_id uuid;
  docs_id uuid;
  t_read uuid;
  t_write uuid;
  t_patch uuid;
  t_git_status uuid;
  t_git_diff uuid;
  t_run uuid;
  t_yahalla_read uuid;
  t_web uuid;
  t_github_read uuid;
  t_github_write uuid;
  t_email uuid;
  t_yahalla_api uuid;
BEGIN
  SELECT id INTO core_id FROM agents WHERE key = 'yahalla-core';
  SELECT id INTO planner_id FROM agents WHERE key = 'planner';
  SELECT id INTO dev_id FROM agents WHERE key = 'developer';
  SELECT id INTO research_id FROM agents WHERE key = 'researcher';
  SELECT id INTO debug_id FROM agents WHERE key = 'debugger';
  SELECT id INTO tester_id FROM agents WHERE key = 'tester';
  SELECT id INTO sec_id FROM agents WHERE key = 'security';
  SELECT id INTO db_id FROM agents WHERE key = 'database';
  SELECT id INTO devops_id FROM agents WHERE key = 'devops';
  SELECT id INTO file_id FROM agents WHERE key = 'file';
  SELECT id INTO review_id FROM agents WHERE key = 'reviewer';
  SELECT id INTO docs_id FROM agents WHERE key = 'docs';

  SELECT id INTO t_read FROM tools WHERE key = 'read_project_file';
  SELECT id INTO t_write FROM tools WHERE key = 'write_project_file';
  SELECT id INTO t_patch FROM tools WHERE key = 'patch_project_file';
  SELECT id INTO t_git_status FROM tools WHERE key = 'git_status';
  SELECT id INTO t_git_diff FROM tools WHERE key = 'git_diff';
  SELECT id INTO t_run FROM tools WHERE key = 'run_project_command';
  SELECT id INTO t_yahalla_read FROM tools WHERE key = 'yahalla.read';
  SELECT id INTO t_web FROM tools WHERE key = 'web.search';
  SELECT id INTO t_github_read FROM tools WHERE key = 'github.read';
  SELECT id INTO t_github_write FROM tools WHERE key = 'github.write';
  SELECT id INTO t_email FROM tools WHERE key = 'email.send';
  SELECT id INTO t_yahalla_api FROM tools WHERE key = 'yahalla.api';

  -- Core: yahalla.read + all read tools
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (core_id, t_yahalla_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (core_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (core_id, t_git_status, true) ON CONFLICT DO NOTHING;

  -- Planner: yahalla.read
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (planner_id, t_yahalla_read, true) ON CONFLICT DO NOTHING;

  -- Developer: read, write, patch, git_status, git_diff, run
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_write, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_patch, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_git_status, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_git_diff, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (dev_id, t_run, true) ON CONFLICT DO NOTHING;

  -- Researcher: web.search, github.read
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (research_id, t_web, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (research_id, t_github_read, true) ON CONFLICT DO NOTHING;

  -- Debugger: read, git_diff, run
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (debug_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (debug_id, t_git_diff, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (debug_id, t_run, true) ON CONFLICT DO NOTHING;

  -- Tester: read, run
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (tester_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (tester_id, t_run, true) ON CONFLICT DO NOTHING;

  -- Security: read, git_diff
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (sec_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (sec_id, t_git_diff, true) ON CONFLICT DO NOTHING;

  -- Database: yahalla.read, yahalla.api
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (db_id, t_yahalla_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (db_id, t_yahalla_api, true) ON CONFLICT DO NOTHING;

  -- DevOps: git_status, git_diff, run
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (devops_id, t_git_status, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (devops_id, t_git_diff, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (devops_id, t_run, true) ON CONFLICT DO NOTHING;

  -- File: read
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (file_id, t_read, true) ON CONFLICT DO NOTHING;

  -- Reviewer: read, git_diff
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (review_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (review_id, t_git_diff, true) ON CONFLICT DO NOTHING;

  -- Docs: read, write, patch
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (docs_id, t_read, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (docs_id, t_write, true) ON CONFLICT DO NOTHING;
  INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (docs_id, t_patch, true) ON CONFLICT DO NOTHING;
END $$;
-- =============================================================
-- 8. Agent-permission mappings
-- =============================================================

DO $$
DECLARE
  core_id uuid;
  dev_id uuid;
  research_id uuid;
  debug_id uuid;
  tester_id uuid;
  sec_id uuid;
  db_id uuid;
  devops_id uuid;
  file_id uuid;
  review_id uuid;
  docs_id uuid;
  p_chat uuid;
  p_files uuid;
  p_read_code uuid;
  p_write_code uuid;
  p_exec uuid;
  p_web uuid;
  p_db uuid;
  p_tasks uuid;
  p_tools uuid;
  p_approvals uuid;
BEGIN
  SELECT id INTO core_id FROM agents WHERE key = 'yahalla-core';
  SELECT id INTO dev_id FROM agents WHERE key = 'developer';
  SELECT id INTO research_id FROM agents WHERE key = 'researcher';
  SELECT id INTO debug_id FROM agents WHERE key = 'debugger';
  SELECT id INTO tester_id FROM agents WHERE key = 'tester';
  SELECT id INTO sec_id FROM agents WHERE key = 'security';
  SELECT id INTO db_id FROM agents WHERE key = 'database';
  SELECT id INTO devops_id FROM agents WHERE key = 'devops';
  SELECT id INTO file_id FROM agents WHERE key = 'file';
  SELECT id INTO review_id FROM agents WHERE key = 'reviewer';
  SELECT id INTO docs_id FROM agents WHERE key = 'docs';

  SELECT id INTO p_chat FROM permissions WHERE key = 'chat';
  SELECT id INTO p_files FROM permissions WHERE key = 'files';
  SELECT id INTO p_read_code FROM permissions WHERE key = 'read_code';
  SELECT id INTO p_write_code FROM permissions WHERE key = 'write_code';
  SELECT id INTO p_exec FROM permissions WHERE key = 'execute_commands';
  SELECT id INTO p_web FROM permissions WHERE key = 'web';
  SELECT id INTO p_db FROM permissions WHERE key = 'database';
  SELECT id INTO p_tasks FROM permissions WHERE key = 'tasks';
  SELECT id INTO p_tools FROM permissions WHERE key = 'tools';
  SELECT id INTO p_approvals FROM permissions WHERE key = 'approvals';

  -- Core: chat, tasks, tools
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (core_id, p_chat) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (core_id, p_tasks) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (core_id, p_tools) ON CONFLICT DO NOTHING;

  -- Developer: files, read_code, write_code, execute_commands
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (dev_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (dev_id, p_read_code) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (dev_id, p_write_code) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (dev_id, p_exec) ON CONFLICT DO NOTHING;

  -- Researcher: web
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (research_id, p_web) ON CONFLICT DO NOTHING;

  -- Debugger: files, read_code, execute_commands
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (debug_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (debug_id, p_read_code) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (debug_id, p_exec) ON CONFLICT DO NOTHING;

  -- Tester: files, read_code, execute_commands
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (tester_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (tester_id, p_read_code) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (tester_id, p_exec) ON CONFLICT DO NOTHING;

  -- Security: files, read_code
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (sec_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (sec_id, p_read_code) ON CONFLICT DO NOTHING;

  -- Database: database
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (db_id, p_db) ON CONFLICT DO NOTHING;

  -- DevOps: execute_commands
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (devops_id, p_exec) ON CONFLICT DO NOTHING;

  -- File: files, read_code
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (file_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (file_id, p_read_code) ON CONFLICT DO NOTHING;

  -- Reviewer: files, read_code
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (review_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (review_id, p_read_code) ON CONFLICT DO NOTHING;

  -- Docs: files, read_code, write_code
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (docs_id, p_files) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (docs_id, p_read_code) ON CONFLICT DO NOTHING;
  INSERT INTO agent_permissions (agent_id, permission_id) VALUES (docs_id, p_write_code) ON CONFLICT DO NOTHING;
END $$;
