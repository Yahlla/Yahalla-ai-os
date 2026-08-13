import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real, verifiable signal that a project root IS Yahalla's own monorepo --
// not a directory-name guess. Checks for the exact local-runtime package
// this very process was built from. A generic "coding agent" project the
// user points local-runtime at will never match this, so self-development
// safety rules only ever apply when Yahalla is actually working on itself.
export function isSelfDevProject(projectRoot: string): boolean {
  const marker = join(projectRoot, 'local-runtime', 'package.json')
  if (!existsSync(marker)) return false
  try {
    const pkg = JSON.parse(readFileSync(marker, 'utf8')) as { name?: string }
    return pkg.name === '@yahalla/local-runtime'
  } catch {
    return false
  }
}

const PROTECTED_BRANCHES = new Set(['main', 'master'])

// Real git state, read fresh on every call -- never cached or trusted from
// a prior tool result, so the model cannot talk its way past this check by
// simply claiming a branch already exists.
export function currentGitBranch(projectRoot: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    })
    const branch = output.trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

export function isOnProtectedBranch(projectRoot: string): boolean {
  const branch = currentGitBranch(projectRoot)
  return branch !== null && PROTECTED_BRANCHES.has(branch)
}

// The mutating tools a self-development safety rail must gate -- anything
// that changes files or repository history. Read-only tools (git_status,
// git_diff, read_project_file, run_project_command for tests) are always
// safe regardless of branch.
export const SELF_DEV_MUTATING_TOOLS = new Set(['write_project_file', 'patch_project_file', 'git_commit', 'git_push'])

export function selfDevBranchGuardMessage(tool: string): string {
  return `Refusing to run "${tool}": this project is Yahalla AI's own source code and the working tree is currently on a protected branch (main/master). Call git_create_branch first, then retry. This is enforced -- it cannot be skipped.`
}

// Appended to the system prompt only when isSelfDevProject(ctx.projectRoot)
// is true -- the normal coding-agent workflow already covers everything
// else (branch first, verify, PR as the review checkpoint); these are the
// extra rules that only matter when the "project" being modified is the
// very system currently answering the request.
export const SELF_DEV_SYSTEM_PROMPT_ADDENDUM = `
Self-development mode: this project IS Yahalla AI's own source code -- the system currently running this conversation. Extra rules apply on top of the normal coding-agent workflow:
- NEVER write, patch, commit, or push while on the "main" or "master" branch. Call git_create_branch first, every time, before any file write/patch/commit/push -- this is enforced by the runtime itself, not a suggestion.
- Prefer small, independently verifiable changes: one focused capability or fix per branch.
- Always run the relevant package's real test suite (e.g. "npm test" inside local-runtime/) after a change and before considering the task done. A change that was not retested is not verified, no matter how small.
- You may be modifying code that the very process handling this conversation is currently running. A change to already-loaded source will not take effect until the process restarts -- say so plainly if a change requires a restart, never claim it is already "live" until it actually is.
`.trim()

// Human-readable one-line summary of a self-dev task's outcome, stored via
// addKnowledge (tag "self_dev") after a self-dev chat completes -- this is
// the persistent "what changed and why" record the next Yahalla session
// (or the next person) can read back, independent of chat history.
export function summarizeSelfDevOutcome(
  goal: string,
  executedTools: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[],
): string {
  const branch = executedTools.find((t) => t.tool === 'git_create_branch')
  const commits = executedTools.filter((t) => t.tool === 'git_commit' && t.result.success)
  const pushed = executedTools.some((t) => t.tool === 'git_push' && t.result.success)
  const testRuns = executedTools.filter((t) => t.tool === 'run_project_command')
  const filesTouched = executedTools
    .filter((t) => (t.tool === 'write_project_file' || t.tool === 'patch_project_file') && t.result.success)
    .map((t) => String(t.arguments.path ?? '?'))

  const lines = [
    `Goal: ${goal.slice(0, 300)}`,
    branch ? `Branch: ${String(branch.arguments.branch ?? '?')}` : 'Branch: (none created)',
    filesTouched.length > 0 ? `Files changed: ${filesTouched.join(', ')}` : 'Files changed: none',
    `Commits: ${commits.length}`,
    `Pushed: ${pushed ? 'yes' : 'no'}`,
    testRuns.length > 0
      ? `Verification commands run: ${testRuns.map((t) => `${t.arguments.command} (${t.result.success ? 'passed' : 'failed'})`).join('; ')}`
      : 'Verification commands run: none',
  ]
  return lines.join('\n')
}
