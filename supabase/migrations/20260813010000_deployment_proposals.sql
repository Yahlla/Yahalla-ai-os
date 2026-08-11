-- Backing table for the self-hosted platform's "agents propose, a human
-- approves with one click, nothing ships silently" pipeline. Lives in the
-- same schema as everything else (not platform-only) so it is visible
-- through the normal RLS/grant story already established in this project.

CREATE TABLE IF NOT EXISTS deployment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  git_ref text NOT NULL,
  base_ref text NOT NULL DEFAULT 'main',
  diff text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  proposed_by uuid REFERENCES profiles(id),
  proposed_by_agent text,
  decided_by uuid REFERENCES profiles(id),
  decided_at timestamptz,
  deployed_at timestamptz,
  deploy_log text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_proposals_status_check
    CHECK (status IN ('pending','approved','rejected','deploying','deployed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_deployment_proposals_status ON deployment_proposals(status);

ALTER TABLE deployment_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage deployment proposals" ON deployment_proposals;
CREATE POLICY "Admins can manage deployment proposals" ON deployment_proposals
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE ON deployment_proposals TO authenticated;
