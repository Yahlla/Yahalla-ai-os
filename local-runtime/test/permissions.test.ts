import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { newId, openDb } from '../src/db.js'
import { checkAccess, grantPermission, listPermissions, revokePermission } from '../src/permissions.js'

// Direct, dedicated unit coverage for permissions.ts's matching logic
// (bestMatch/checkAccess/revokePermission) -- this had no dedicated test
// file at all before this audit; it was only ever exercised incidentally
// through a handful of specific scenarios in other suites. This is the
// full permission-flow matrix the audit asked for: read/write/execute
// access ranking, parent/child project-path matching (including the
// "shares a string prefix but is a different directory" trap), revoked
// permissions, and non-project scopes.

test('checkAccess: no permission ever granted -> always denied (the real fresh-install state)', () => {
  const db = openDb(':memory:')
  assert.equal(checkAccess(db, 'project', '/some/project', 'read'), false)
})

test('checkAccess: access levels rank none < read < write < execute', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/proj', 'read')
  assert.equal(checkAccess(db, 'project', '/proj', 'read'), true)
  assert.equal(checkAccess(db, 'project', '/proj', 'write'), false, 'a read-only grant must not satisfy a write requirement')
  assert.equal(checkAccess(db, 'project', '/proj', 'execute'), false)

  grantPermission(db, 'project', '/proj', 'execute')
  assert.equal(checkAccess(db, 'project', '/proj', 'read'), true, 'a higher grant must still satisfy a lower requirement')
  assert.equal(checkAccess(db, 'project', '/proj', 'write'), true)
  assert.equal(checkAccess(db, 'project', '/proj', 'execute'), true)
})

test('checkAccess (project scope): a grant on a parent directory covers a real child path', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo', 'write')
  assert.equal(checkAccess(db, 'project', '/home/user/repo', 'write'), true, 'exact match')
  assert.equal(checkAccess(db, 'project', '/home/user/repo/src/index.ts', 'write'), true, 'nested child path')
  assert.equal(checkAccess(db, 'project', '/home/user/repo/a/b/c/d/e', 'read'), true, 'deeply nested child path')
})

// Regression-shaped test for a real path-matching trap: a naive
// startsWith(target) check (without requiring a "/" boundary) would
// wrongly let a grant on "/home/user/repo" also cover the unrelated sibling
// directory "/home/user/repo-other" merely because the strings share a
// prefix. permissions.ts's bestMatch already guards against this
// (target.startsWith(r.target + '/')), but that behavior had never been
// directly proven by a test before this audit.
test('checkAccess (project scope): a grant does NOT leak into a sibling directory that merely shares a string prefix', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo', 'write')
  assert.equal(checkAccess(db, 'project', '/home/user/repo-other', 'read'), false)
  assert.equal(checkAccess(db, 'project', '/home/user/repository', 'read'), false)
})

test('checkAccess (project scope): the most specific (longest) matching grant wins over a broader parent grant', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo', 'write')
  grantPermission(db, 'project', '/home/user/repo/secrets', 'none')
  assert.equal(checkAccess(db, 'project', '/home/user/repo/src/index.ts', 'write'), true, 'still covered by the parent grant')
  assert.equal(checkAccess(db, 'project', '/home/user/repo/secrets/key.pem', 'read'), false, 'the more specific "none" grant must override the broader parent grant')
})

test('revokePermission actually removes access -- a previously-granted path goes back to denied', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/proj', 'write')
  assert.equal(checkAccess(db, 'project', '/proj', 'write'), true)

  revokePermission(db, 'project', '/proj')
  assert.equal(checkAccess(db, 'project', '/proj', 'read'), false)
  assert.equal(listPermissions(db).find((p) => p.scope === 'project' && p.target === '/proj'), undefined)
})

test('non-project scopes (e.g. camera): a "*" grant applies to every target in that scope, by design', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'camera', '*', 'read')
  assert.equal(checkAccess(db, 'camera', '*', 'read'), true)
  // Non-project scopes are not paths -- '*' is the intended "this whole
  // category of action" grant (see permissions.ts's bestMatch), unlike
  // project scope's real directory-prefix matching above. A specific
  // target still needs its own grant if one is required, but here no
  // specific-target grant exists, so bestMatch correctly falls back to the
  // wildcard for any target string.
  assert.equal(checkAccess(db, 'camera', 'some-other-device-id', 'read'), true)
})

test('non-project scopes: an unrelated scope with no grant at all (not even a wildcard) is still denied', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'camera', '*', 'read')
  assert.equal(checkAccess(db, 'microphone', '*', 'read'), false, 'a grant in one scope must never leak into a different scope')
})

test('grantPermission upserts -- granting the same scope+target twice updates access instead of duplicating rows', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/proj', 'read')
  grantPermission(db, 'project', '/proj', 'write')
  const rows = listPermissions(db).filter((p) => p.scope === 'project' && p.target === '/proj')
  assert.equal(rows.length, 1, 'must not create a duplicate row for the same scope+target')
  assert.equal(rows[0]!.access, 'write')
})

// --- Regression tests for a real reported bug class: "there is a
// permission record for exactly this project, yet the tool is still
// denied." Root cause: project-scope targets were compared as raw
// strings, with zero normalization -- a grant written with a trailing
// slash, a redundant "./" segment, or any other cosmetically-different
// form of the identical absolute path would never match ctx.projectRoot,
// even though a human reading both values would call them "the same
// project." normalizeProjectTarget() (permissions.ts) fixes this.

test('checkAccess: a granted target with a trailing slash still matches a query without one', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo/', 'read')
  assert.equal(checkAccess(db, 'project', '/home/user/repo', 'read'), true)
})

test('checkAccess: a query target with a trailing slash still matches a grant without one', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo', 'read')
  assert.equal(checkAccess(db, 'project', '/home/user/repo/', 'read'), true)
})

test('checkAccess: a redundant "./" or repeated-separator form of the same path still matches', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo', 'write')
  assert.equal(checkAccess(db, 'project', '/home/user/./repo', 'write'), true)
  assert.equal(checkAccess(db, 'project', '/home//user//repo', 'write'), true)
})

test('grantPermission stores project-scope targets in normalized form, so listPermissions shows the canonical path regardless of how it was granted', () => {
  const db = openDb(':memory:')
  grantPermission(db, 'project', '/home/user/repo/', 'write')
  const rows = listPermissions(db).filter((p) => p.scope === 'project')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.target, '/home/user/repo', 'the trailing slash must be stripped at storage time')
})

// The most important case for a real, already-affected install: a
// permission row that predates this fix (or was inserted directly into
// the database by hand, exactly as the reported bug described) with an
// un-normalized target must still match once this fix is deployed --
// comparison-time normalization in bestMatch, not just grant-time, is
// what makes this possible without any data migration.
test('checkAccess: an existing, pre-fix, un-normalized row in the database (trailing slash) still matches a clean query after this fix', () => {
  const db = openDb(':memory:')
  // Bypasses grantPermission deliberately, to simulate a row written by
  // an older runtime version (or by hand) before normalizeProjectTarget
  // existed -- exactly the shape of the reported bug.
  db.prepare(
    `INSERT INTO permissions (id, scope, target, access, updated_at) VALUES (?, 'project', '/Users/mahmoudal/Yahalla-ai-os/', 'read', datetime('now'))`,
  ).run(newId())
  assert.equal(checkAccess(db, 'project', '/Users/mahmoudal/Yahalla-ai-os', 'read'), true)
})

// Confirmed against a real device (not a guess): the actually-reported
// denial traced to macOS's case-insensitive-but-case-preserving APFS --
// the permission was granted for ".../Yahalla-ai-os" (capital Y) while
// the live process's projectRoot resolved to ".../yahalla-ai-os"
// (lowercase), the exact same real directory on disk, string-mismatched.
// This sandbox's filesystem is case-sensitive (Linux), so the identical
// case-folding cannot be reproduced directly here -- but
// normalizeProjectTarget's fix for it is realpathSync.native, i.e.
// "resolve to whatever the OS calls the canonical path for this real
// filesystem entry," and that same mechanism is fully exercised and
// provable on any platform through a symlink: a grant made via a symlink
// path must match a query made via the real path it points to (and vice
// versa), because both canonicalize to the identical on-disk target --
// which is exactly the class of "cosmetically different string, same
// real directory" bug this fix closes.
test('checkAccess: a grant through a symlink matches a query through the real path it points to (proves realpath canonicalization, the same mechanism that fixes macOS case-insensitive mismatches)', () => {
  const db = openDb(':memory:')
  const base = mkdtempSync(join(tmpdir(), 'yahalla-permtest-'))
  const realDir = join(base, 'real-project')
  const linkDir = join(base, 'link-to-project')
  mkdirSync(realDir)
  symlinkSync(realDir, linkDir)

  grantPermission(db, 'project', linkDir, 'read')
  assert.equal(checkAccess(db, 'project', realDir, 'read'), true, 'a grant via the symlink path must cover the real path it resolves to')

  const db2 = openDb(':memory:')
  grantPermission(db2, 'project', realDir, 'write')
  assert.equal(checkAccess(db2, 'project', linkDir, 'write'), true, 'a grant via the real path must also cover a query made through a symlink to it')
})
