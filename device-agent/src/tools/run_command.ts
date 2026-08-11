import { spawnSync } from 'node:child_process'
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
 * invoked (spawnSync with shell:false) -- this only matters for correctly
 * separating arguments, not for safety, since the full string was already
 * matched verbatim against the configured allowlist before this runs.
 */
function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

export function runProjectCommand(
  projectRoot: string,
  args: Record<string, unknown>,
  allowlist: string[] = DEFAULT_ALLOWLIST,
): ToolResult {
  const command = String(args.command ?? '').trim()

  if (!allowlist.includes(command)) {
    return {
      success: false,
      error: `Command "${command}" is not in the allowlist. Allowed: ${allowlist.join(', ')}.`,
    }
  }

  const argv = splitCommand(command)
  const binary = argv[0]

  if (!binary || !ALLOWED_BINARIES.has(binary)) {
    return {
      success: false,
      error: `Command "${command}" resolves to a binary that is not allowlisted.`,
    }
  }

  const result = spawnSync(binary, argv.slice(1), {
    cwd: projectRoot,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    shell: false,
  })

  if (result.error) {
    return { success: false, error: result.error.message }
  }

  if (result.signal) {
    return {
      success: false,
      error: `Command was terminated by signal ${result.signal} (likely timed out after ${COMMAND_TIMEOUT_MS}ms).`,
    }
  }

  return {
    success: result.status === 0,
    exit_code: result.status,
    stdout: (result.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
    stderr: (result.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
  }
}
