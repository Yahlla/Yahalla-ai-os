-- Central, cross-device semantic memory: the "Vector DB Core" the
-- coordination server can genuinely host. This is NOT LLM inference --
-- storing a vector and ranking rows by cosine distance is cheap linear
-- algebra a resource-modest VPS handles fine, unlike text generation.
-- Embeddings themselves are computed on the caller's own device (browser
-- or local-runtime) and sent here as plain float arrays; this table only
-- ever stores and searches vectors, it never runs a model.
--
-- 384 dimensions matches small, fast, commonly-available embedding
-- models (e.g. all-MiniLM-L6-v2 class) that are themselves cheap enough
-- to run client-side -- swap the dimension (and re-embed existing rows)
-- if a different embedding model is chosen later.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'agent',
  content text NOT NULL,
  embedding vector(384) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_entries_source_check CHECK (source IN ('agent','device','browser','user'))
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_owner ON memory_entries(owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_project ON memory_entries(project_id);
-- HNSW: approximate nearest-neighbor search, the standard pgvector index
-- for cosine similarity at this scale -- fine on modest hardware because
-- it only ever does index lookups + vector-distance math, no model runs.
CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding ON memory_entries
  USING hnsw (embedding vector_cosine_ops);

ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own memory entries" ON memory_entries;
CREATE POLICY "Users manage their own memory entries" ON memory_entries
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_entries TO authenticated;
