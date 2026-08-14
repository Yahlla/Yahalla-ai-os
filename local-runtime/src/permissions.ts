import { resolve, sep } from 'node:path'
import type { Db } from './db.js'
import { newId } from './db.js'

export type PermissionScope =
  | 'project'
  | 'network'
  | 'command_execution'
  | 'sensitive_files'
  | 'system_settings'
  | 'application_launching'
  | 'camera'
  | 'microphone'
  | 'browser'

export type AccessLevel = 'none' | 'read' | 'write' | 'execute'

export type PermissionRow = {
  id: string
  scope: PermissionScope
  target: string
  access: AccessLevel
  updated_at: string
}

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, execute: 3 }

// Real audit finding: a project-scope target was compared to
// ctx.projectRoot as a raw string, with no normalization at all -- a
// grant typed (or generated) with a trailing slash, a redundant "./"
// segment, or any other cosmetically-different-but-logically-identical
// form of the same absolute path would silently never match, reproducing
// exactly "a real permission record exists for this exact project, yet
// the tool is still denied." resolve() alone (no realpath/symlink
// resolution -- that would require the path to already exist on disk at
// comparison time, and would change matching behavior for legitimate
// symlinked setups rather than just fixing formatting) strips a trailing
// separator, collapses "." and "..", and normalizes repeated separators,
// which covers the actual reported bug class without changing what a
// deliberately-different real path resolves to. Applied both when a
// grant is stored AND at comparison time in bestMatch, so this closes
// the gap for permission rows that were already written before this fix
// existed, not only new ones.
function normalizeProjectTarget(target: string): string {
  if (target === '*') return target
  const resolved = resolve(target)
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
}

// The agent gets NOTHING by default. Every category of access -- even
// reading the project it was just pointed at -- has to be explicitly
// granted once (normally by the one-time "trust this project folder"
// step the frontend shows on first run), and dangerous individual actions
// still go through the separate per-call approvals table on top of this.
// This is the standing "is this category of action allowed at all" gate;
// approvals.ts-equivalent one-time confirmations are the finer-grained
// per-call gate.
export function grantPermission(db: Db, scope: PermissionScope, target: string, access: AccessLevel): PermissionRow {
  const normalizedTarget = scope === 'project' ? normalizeProjectTarget(target) : target
  const id = newId()
  db.prepare(
    `INSERT INTO permissions (id, scope, target, access, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (scope, target) DO UPDATE SET access = excluded.access, updated_at = datetime('now')`,
  ).run(id, scope, normalizedTarget, access)

  return db.prepare('SELECT * FROM permissions WHERE scope = ? AND target = ?').get(scope, normalizedTarget) as PermissionRow
}

export function revokePermission(db: Db, scope: PermissionScope, target: string): void {
  const normalizedTarget = scope === 'project' ? normalizeProjectTarget(target) : target
  db.prepare('DELETE FROM permissions WHERE scope = ? AND target = ?').run(scope, normalizedTarget)
}

export function listPermissions(db: Db): PermissionRow[] {
  return db.prepare('SELECT * FROM permissions ORDER BY scope, target').all() as PermissionRow[]
}

function bestMatch(db: Db, scope: PermissionScope, target: string): PermissionRow | undefined {
  const rows = db.prepare('SELECT * FROM permissions WHERE scope = ?').all(scope) as PermissionRow[]
  if (scope !== 'project') {
    return rows.find((r) => r.target === '*' || r.target === target)
  }
  // Both sides normalized at comparison time (not just at grant time) --
  // this closes the gap for a permission row that was written before
  // normalizeProjectTarget existed, or hand-inserted directly into the
  // database, without requiring any data migration.
  const normalizedTarget = normalizeProjectTarget(target)
  // Longest matching project-path prefix wins, so a grant on a parent
  // directory covers its children unless overridden more specifically.
  const candidates = rows
    .map((r) => ({ row: r, normalizedRowTarget: normalizeProjectTarget(r.target) }))
    .filter(
      ({ normalizedRowTarget }) =>
        normalizedTarget === normalizedRowTarget || normalizedTarget.startsWith(normalizedRowTarget + sep),
    )
    .sort((a, b) => b.normalizedRowTarget.length - a.normalizedRowTarget.length)
  return candidates[0]?.row
}

export function checkAccess(db: Db, scope: PermissionScope, target: string, required: AccessLevel): boolean {
  const match = bestMatch(db, scope, target)
  if (!match) return false
  return ACCESS_RANK[match.access] >= ACCESS_RANK[required]
}
