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

// The agent gets NOTHING by default. Every category of access -- even
// reading the project it was just pointed at -- has to be explicitly
// granted once (normally by the one-time "trust this project folder"
// step the frontend shows on first run), and dangerous individual actions
// still go through the separate per-call approvals table on top of this.
// This is the standing "is this category of action allowed at all" gate;
// approvals.ts-equivalent one-time confirmations are the finer-grained
// per-call gate.
export function grantPermission(db: Db, scope: PermissionScope, target: string, access: AccessLevel): PermissionRow {
  const id = newId()
  db.prepare(
    `INSERT INTO permissions (id, scope, target, access, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (scope, target) DO UPDATE SET access = excluded.access, updated_at = datetime('now')`,
  ).run(id, scope, target, access)

  return db.prepare('SELECT * FROM permissions WHERE scope = ? AND target = ?').get(scope, target) as PermissionRow
}

export function revokePermission(db: Db, scope: PermissionScope, target: string): void {
  db.prepare('DELETE FROM permissions WHERE scope = ? AND target = ?').run(scope, target)
}

export function listPermissions(db: Db): PermissionRow[] {
  return db.prepare('SELECT * FROM permissions ORDER BY scope, target').all() as PermissionRow[]
}

function bestMatch(db: Db, scope: PermissionScope, target: string): PermissionRow | undefined {
  const rows = db.prepare('SELECT * FROM permissions WHERE scope = ?').all(scope) as PermissionRow[]
  if (scope !== 'project') {
    return rows.find((r) => r.target === '*' || r.target === target)
  }
  // Longest matching project-path prefix wins, so a grant on a parent
  // directory covers its children unless overridden more specifically.
  const candidates = rows
    .filter((r) => target === r.target || target.startsWith(r.target.endsWith('/') ? r.target : r.target + '/'))
    .sort((a, b) => b.target.length - a.target.length)
  return candidates[0]
}

export function checkAccess(db: Db, scope: PermissionScope, target: string, required: AccessLevel): boolean {
  const match = bestMatch(db, scope, target)
  if (!match) return false
  return ACCESS_RANK[match.access] >= ACCESS_RANK[required]
}
