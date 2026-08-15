import { spawn } from 'node:child_process'
import type { ToolResult } from './files.js'

const MAX_OUTPUT_BYTES = 200_000
const COMMAND_TIMEOUT_MS = 120_000

// The run_project_command tool's allowlist is configuration-driven (see
// tools.configuration.allowlist, seeded in
// supabase/migrations/20260810114233_20260810_yahalla_seed_data.sql) so it
// can be reviewed/edited from the Control Center without a code change.
// This default only applies if a tool_execution somehow arrives with no
// configuration attached.
const DEFAULT_ALLOWLIST = [
  'npm run build',
  'npm run lint',
  'npm test',
  'tsc --noEmit',
  'git status',
  'git diff',
  'git log',
]

const ALLOWED_BINARIES = new Set(['git', 'npm', 'node', 'npx', 'tsc'])

/**
 * Splits an already-allowlisted command string into argv. No shell is ever
 * invoked (spawn with shell:false) -- this only matters for correctly
 * separating arguments, not for safety, since the full string was already
 * matched verbatim against the configured allowlist before this runs.
 */
function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

// Real audit finding: this used to call spawnSync, which blocks the
// entire single-threaded Node.js event loop -- not just the caller -- for
// up to COMMAND_TIMEOUT_MS while a command runs. Since local-runtime is
// one Node process serving every HTTP route (chat, health, permissions,
// everything), a single run_project_command tool call (e.g. `npm run
// build`/`npm test` during self-repair) made the ENTIRE runtime
// unresponsive for that whole window -- no other request, including an
// unrelated chat message or a cancellation request, could even begin
// being handled. spawn() (async, event-driven) fixes both the
// event-loop-blocking problem and makes real cancellation possible: an
// external AbortSignal can now actually reach and kill the child process
// while the rest of the runtime keeps serving requests.
export function runProjectCommand(
  projectRoot: string,
  args: Record<string, unknown>,
  allowlist: string[] = DEFAULT_ALLOWLIST,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const command = String(args.command ?? '').trim()

  if (!allowlist.includes(command)) {
    return Promise.resolve({
      success: false,
      error: `Command "${command}" is not in the allowlist. Allowed: ${allowlist.join(', ')}.`,
    })
  }

  const argv = splitCommand(command)
  const binary = argv[0]

  if (!binary || !ALLOWED_BINARIES.has(binary)) {
    return Promise.resolve({
      success: false,
      error: `Command "${command}" resolves to a binary that is not allowlisted.`,
    })
  }

  if (signal?.aborted) {
    return Promise.resolve({ success: false, error: 'Command was cancelled before it started.' })
  }

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(binary, argv.slice(1), { cwd: projectRoot, shell: false })

    let stdout = ''
    let stderr = ''
    let settled = false
    let killedReason: 'timeout' | 'cancelled' | undefined

    const finish = (result: ToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const timer = setTimeout(() => {
      killedReason = 'timeout'
      child.kill('SIGTERM')
    }, COMMAND_TIMEOUT_MS)

    const onAbort = () => {
      killedReason = 'cancelled'
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish({ success: false, error: error.message })
    })

    child.on('close', (code, killSignal) => {
      if (killSignal) {
        finish({
          success: false,
          error:
            killedReason === 'cancelled'
              ? 'Command was cancelled.'
              : `Command was terminated by signal ${killSignal} (likely timed out after ${COMMAND_TIMEOUT_MS}ms).`,
        })
        return
      }
      finish({
        success: code === 0,
        exit_code: code,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      })
    })
  })
}
