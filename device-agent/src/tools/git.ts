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
