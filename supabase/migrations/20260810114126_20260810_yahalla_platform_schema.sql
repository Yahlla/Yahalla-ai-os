/*
# Yahalla AI Platform — Core Schema Extension

## Overview
Extends the existing Yahalla schema with the tables required for a
multi-model, multi-agent, multi-server AI operating platform:
model registry, server/node registry, project workspaces,
conversation history, and conversation messages.

## New Tables
1. `servers` — Execution nodes (local/lan/remote/cloud) that host agent runtimes and models.
   - id, name, type, hostname, port, status, runtime_version, capabilities (jsonb),
     resource_usage (jsonb), last_heartbeat, created_at, updated_at
2. `models` — Model registry. Each row is a model hosted on a server.
   - id, server_id, key, name, provider, type, endpoint, capabilities (jsonb),
     context_length, vision_support, tool_calling_support, reasoning_support,
     coding_capability, embedding_capability, speech_capability,
     status, priority, enabled, is_local, configuration (jsonb), last_checked, created_at, updated_at
3. `projects` — Project workspaces that group files, conversations, tasks, agents.
   - id, name, description, owner_id, status, configuration (jsonb), created_at, updated_at
4. `project_members` — Membership/role within a project.
   - project_id, user_id, role, created_at
5. `conversations` — Chat sessions (optionally linked to a project).
   - id, project_id, owner_id, title, assigned_agent_id, model_id, status, created_at, updated_at
6. `conversation_messages` — Messages within a conversation.
   - id, conversation_id, role, content, agent_id, model_id, task_id,
     tool_activity (jsonb), metadata (jsonb), created_at

## Modified Tables
1. `profiles` — expand role check constraint to include developer, operator, user, viewer.
2. `role_permissions` — expand role check constraint to match.
3. `tasks` — add parent_task_id, retry_count, current_step, progress, project_id, conversation_id.

## Security
- RLS enabled on every new table.
- `servers`, `models`: admin-only read; owner-only write.
- `projects`: owner + members read/write.
- `conversations`, `conversation_messages`: owner read/write; admin read.
- `project_members`: members read; owner/admin write.

## Notes
1. All new tables use `gen_random_uuid()` for primary keys.
2. Foreign keys reference existing tables (profiles, agents, models, servers, projects, tasks).
3. Idempotent statements (IF NOT EXISTS / DO blocks).
4. Existing data is preserved — no destructive operations.
*/

-- =============================================================
-- 1. Expand role constraints
-- =============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check' AND conrelid = 'profiles'::regclass
  ) THEN
    ALTER TABLE profiles DROP CONSTRAINT profiles_role_check;
  END IF;
END $$;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('owner','admin','developer','operator','user','viewer'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'role_permissions_role_check' AND conrelid = 'role_permissions'::regclass
  ) THEN
    ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_role_check;
  END IF;
END $$;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('owner','admin','developer','operator','user','viewer'));

-- =============================================================
-- 2. Servers table
-- =============================================================

CREATE TABLE IF NOT EXISTS servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'local',
  hostname text NOT NULL DEFAULT '127.0.0.1',
  port integer NOT NULL DEFAULT 8787,
  status text NOT NULL DEFAULT 'offline',
  runtime_version text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT servers_type_check CHECK (type IN ('local','lan','remote','cloud')),
  CONSTRAINT servers_status_check CHECK (status IN ('online','degraded','offline','unknown'))
);

ALTER TABLE servers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read servers" ON servers;
CREATE POLICY "Admins can read servers" ON servers
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Owners can manage servers" ON servers;
CREATE POLICY "Owners can manage servers" ON servers
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner'));

-- =============================================================
-- 3. Models table
-- =============================================================

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  key text NOT NULL,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'openai-compatible',
  type text NOT NULL DEFAULT 'general',
  endpoint text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_length integer DEFAULT 4096,
  vision_support boolean NOT NULL DEFAULT false,
  tool_calling_support boolean NOT NULL DEFAULT false,
  reasoning_support boolean NOT NULL DEFAULT false,
  coding_capability boolean NOT NULL DEFAULT false,
  embedding_capability boolean NOT NULL DEFAULT false,
  speech_capability boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unknown',
  priority integer NOT NULL DEFAULT 50,
  enabled boolean NOT NULL DEFAULT true,
  is_local boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT models_type_check CHECK (type IN ('general','coding','reasoning','vision','speech','embedding')),
  CONSTRAINT models_status_check CHECK (status IN ('online','offline','unknown','degraded'))
);

ALTER TABLE models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read models" ON models;
CREATE POLICY "Admins can read models" ON models
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Owners can manage models" ON models;
CREATE POLICY "Owners can manage models" ON models
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner'));

-- =============================================================
-- 4. Projects table
-- =============================================================

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  owner_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_status_check CHECK (status IN ('active','archived','suspended'))
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can manage projects" ON projects;
CREATE POLICY "Owners can manage projects" ON projects
  FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_admin()
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.is_admin()
  );

-- =============================================================
-- 5. Project members
-- =============================================================

CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_role_check CHECK (role IN ('owner','member','viewer'))
);

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read project_members" ON project_members;
CREATE POLICY "Members can read project_members" ON project_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
      AND (p.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS "Owners can manage project_members" ON project_members;
CREATE POLICY "Owners can manage project_members" ON project_members
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
      AND (p.owner_id = auth.uid() OR public.is_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_id
      AND (p.owner_id = auth.uid() OR public.is_admin())
    )
  );

-- =============================================================
-- 6. Conversations
-- =============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  assigned_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_status_check CHECK (status IN ('active','archived','deleted'))
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read conversations" ON conversations;
CREATE POLICY "Owners can read conversations" ON conversations
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Owners can insert conversations" ON conversations;
CREATE POLICY "Owners can insert conversations" ON conversations
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners can update conversations" ON conversations;
CREATE POLICY "Owners can update conversations" ON conversations
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Owners can delete conversations" ON conversations;
CREATE POLICY "Owners can delete conversations" ON conversations
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

-- =============================================================
-- 7. Conversation messages
-- =============================================================

CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  tool_activity jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_role_check CHECK (role IN ('user','assistant','system','tool'))
);

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read messages" ON conversation_messages;
CREATE POLICY "Owners can read messages" ON conversation_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS "Owners can insert messages" ON conversation_messages;
CREATE POLICY "Owners can insert messages" ON conversation_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS "Owners can update messages" ON conversation_messages;
CREATE POLICY "Owners can update messages" ON conversation_messages
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.owner_id = auth.uid() OR public.is_admin())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.owner_id = auth.uid() OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS "Owners can delete messages" ON conversation_messages;
CREATE POLICY "Owners can delete messages" ON conversation_messages
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.owner_id = auth.uid() OR public.is_admin())
    )
  );

-- =============================================================
-- 8. Extend tasks table
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'parent_task_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE tasks ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'current_step'
  ) THEN
    ALTER TABLE tasks ADD COLUMN current_step text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'progress'
  ) THEN
    ALTER TABLE tasks ADD COLUMN progress integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'project_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'conversation_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'model_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN model_id uuid REFERENCES models(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =============================================================
-- 9. Extend agents table with model preference + server assignment
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'model_id'
  ) THEN
    ALTER TABLE agents ADD COLUMN model_id uuid REFERENCES models(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'fallback_model_id'
  ) THEN
    ALTER TABLE agents ADD COLUMN fallback_model_id uuid REFERENCES models(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'server_id'
  ) THEN
    ALTER TABLE agents ADD COLUMN server_id uuid REFERENCES servers(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'role'
  ) THEN
    ALTER TABLE agents ADD COLUMN role text NOT NULL DEFAULT 'general';
  END IF;
END $$;

-- =============================================================
-- 10. Indexes
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_models_server ON models(server_id);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
CREATE INDEX IF NOT EXISTS idx_models_type ON models(type);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conversation ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agents_server ON agents(server_id);
CREATE INDEX IF NOT EXISTS idx_agents_model ON agents(model_id);

-- =============================================================
-- 11. Grants
-- =============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON servers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON models TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_messages TO authenticated;
