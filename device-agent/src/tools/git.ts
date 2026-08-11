import { spawnSync } from 'node:child_process'
import type { ToolResult } from './files.js'

const MAX_OUTPUT_BYTES = 200_000
const GIT_TIMEOUT_MS = 20_000

function runGit(projectRoot: string, args: string[]): ToolResult {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  })

  if (result.error) {
    return { success: false, error: result.error.message }
  }

  if (result.signal) {
    return { success: false, error: `git was terminated by signal ${result.signal} (likely timed out).` }
  }

  return {
    success: result.status === 0,
    exit_code: result.status,
    stdout: (result.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
    stderr: (result.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
  }
}

export function gitStatus(projectRoot: string): ToolResult {
  return runGit(projectRoot, ['status', '--porcelain=v1', '--branch'])
}

export function gitDiff(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const staged = args.staged === true
  const path = typeof args.path === 'string' ? args.path : undefined
  const gitArgs = ['diff', ...(staged ? ['--cached'] : [])]
  if (path) gitArgs.push('--', path)
  return runGit(projectRoot, gitArgs)
}

// Branch/remote names are validated before ever reaching spawnSync: no
// shell is invoked (so no injection *execution* risk), but a value like
// "--upload-pack=..." passed as a positional git argument can still be
// misparsed as a flag. Rejecting anything that isn't a plain ref-like
// token (and never starts with "-") closes that off.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/

function isSafeRef(value: string): boolean {
  return SAFE_REF.test(value) && !value.startsWith('-')
}

export function gitCreateBranch(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const branch = String(args.branch ?? '').trim()
  if (!branch || !isSafeRef(branch)) {
    return { success: false, error: `"${branch}" is not a valid branch name.` }
  }
  return runGit(projectRoot, ['checkout', '-b', branch])
}

export function gitCommit(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const message = String(args.message ?? '').trim()
  if (!message) {
    return { success: false, error: 'message is required.' }
  }

  const add = runGit(projectRoot, ['add', '-A'])
  if (!add.success) return add

  return runGit(projectRoot, ['commit', '-m', message])
}

const SAFE_REMOTE_URL = /^(https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+(\.git)?|git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(\.git)?)$/

export function gitPush(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
  const remoteUrl = typeof args.remote_url === 'string' && args.remote_url.trim() ? args.remote_url.trim() : undefined

  if (branch && !isSafeRef(branch)) {
    return { success: false, error: `"${branch}" is not a valid branch name.` }
  }

  if (remoteUrl) {
    if (!SAFE_REMOTE_URL.test(remoteUrl)) {
      return { success: false, error: 'remote_url must be a plain https:// or git@ GitHub URL.' }
    }
    const remotes = runGit(projectRoot, ['remote'])
    const originExists = remotes.success && String(remotes.stdout ?? '').split('\n').includes('origin')
    const setRemote = runGit(
      projectRoot,
      originExists ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl],
    )
    if (!setRemote.success) return setRemote
  }

  // Uses whatever git credential helper is already configured on this
  // machine (SSH key, macOS Keychain, gh CLI helper, ...) -- this tool
  // never sees or stores a token itself.
  return runGit(projectRoot, ['push', '-u', 'origin', branch ?? 'HEAD'])
}
