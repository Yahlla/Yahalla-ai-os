import type { Db } from './db.js'
import { newId } from './db.js'

export type MemoryRow = {
  id: string
  scope: string
  memory_key: string | null
  content: string
  importance: number
  metadata: string
  created_at: string
  updated_at: string
}

export function addMemory(
  db: Db,
  content: string,
  opts: { scope?: string; key?: string; importance?: number; metadata?: Record<string, unknown> } = {},
): MemoryRow {
  const id = newId()
  db.prepare(
    `INSERT INTO memory (id, scope, memory_key, content, importance, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.scope ?? 'global',
    opts.key ?? null,
    content,
    opts.importance ?? 30,
    JSON.stringify(opts.metadata ?? {}),
  )
  return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as MemoryRow
}

export function listMemory(db: Db, limit = 50): MemoryRow[] {
  return db.prepare('SELECT * FROM memory ORDER BY importance DESC, created_at DESC LIMIT ?').all(limit) as MemoryRow[]
}

// Cheap, local, dependency-free recall: no embeddings/vector index yet
// (flagged as a future optional upgrade in docs) -- ranks by simple
// keyword overlap plus importance/recency, which is enough for a single
// user's local history and needs no model, no GPU, and no network.
export function recallMemory(db: Db, query: string, limit = 8): MemoryRow[] {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
  const rows = db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT 500').all() as MemoryRow[]
  if (terms.length === 0) return rows.slice(0, limit)

  const scored = rows.map((row) => {
    const haystack = row.content.toLowerCase()
    const hits = terms.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0)
    return { row, score: hits * 10 + row.importance / 10 }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.row)
}

export type KnowledgeRow = {
  id: string
  title: string
  content: string
  source_type: string
  tags: string
  created_at: string
}

export function addKnowledge(
  db: Db,
  title: string,
  content: string,
  opts: { sourceType?: string; tags?: string[] } = {},
): KnowledgeRow {
  const id = newId()
  db.prepare(
    `INSERT INTO knowledge (id, title, content, source_type, tags) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, content, opts.sourceType ?? 'manual', JSON.stringify(opts.tags ?? []))
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow
}

export function listKnowledge(db: Db, limit = 100): KnowledgeRow[] {
  return db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC LIMIT ?').all(limit) as KnowledgeRow[]
}

export type SkillRow = {
  id: string
  key: string
  name: string
  description: string | null
  procedure: string
  success_count: number
  failure_count: number
  created_at: string
  updated_at: string
}

// A "skill" is a named, reusable procedure the agent recorded after
// succeeding at something non-trivial -- e.g. "how this project's tests
// are run", "the patch pattern that fixed the last build error". Recording
// one is how the agent improves *without* claiming to retrain the model
// itself: future tasks can look these up and reuse a procedure that is
// already known to work in this project, instead of rediscovering it.
export function upsertSkill(db: Db, key: string, name: string, procedure: string, description?: string): SkillRow {
  const id = newId()
  db.prepare(
    `INSERT INTO skills (id, key, name, description, procedure)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
       procedure = excluded.procedure, updated_at = datetime('now')`,
  ).run(id, key, name, description ?? null, procedure)
  return db.prepare('SELECT * FROM skills WHERE key = ?').get(key) as SkillRow
}

export function recordSkillOutcome(db: Db, key: string, success: boolean): void {
  db.prepare(
    `UPDATE skills SET ${success ? 'success_count' : 'failure_count'} = ${success ? 'success_count' : 'failure_count'} + 1,
     updated_at = datetime('now') WHERE key = ?`,
  ).run(key)
}

export function listSkills(db: Db): SkillRow[] {
  return db.prepare('SELECT * FROM skills ORDER BY success_count DESC, updated_at DESC').all() as SkillRow[]
}

export function setPreference(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value))
}

export function getPreference<T = unknown>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}

export function listPreferences(db: Db): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM preferences').all() as { key: string; value: string }[]
  const out: Record<string, unknown> = {}
  for (const row of rows) out[row.key] = JSON.parse(row.value)
  return out
}

export function recordTaskFeedback(db: Db, taskId: string, outcome: 'success' | 'failure', note?: string): void {
  db.prepare(
    `INSERT INTO task_feedback (id, task_id, outcome, note) VALUES (?, ?, ?, ?)`,
  ).run(newId(), taskId, outcome, note ?? null)
}
