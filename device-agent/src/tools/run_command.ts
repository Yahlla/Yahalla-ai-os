import { spawnSync } from 'node:child_process'
import type { ToolResult } from './files.js'

const MAX_OUTPUT_BYTES = 200_000
const COMMAND_TIMEOUT_MS = 120_000

// Only these binaries may ever be spawned by run_project_command, and only
// with the exact subcommands listed. Everything else — including shells,
// interpreters run with arbitrary -c strings, and package managers' own
// "run arbitrary script" escape hatches beyond what's listed — is refused.
// No shell is ever invoked (spawnSync with shell:false, argv passed as an
// array), so there is no command-injection surface via arguments.
const ALLOWED_COMMANDS: Record<string, (subArgs: string[]) => boolean> = {
  git: () => true,
  npm: (subArgs) => ['install', 'run', 'test', 'ci', 'run-script'].includes(subArgs[0] ?? ''),
  node: () => true,
  npx: () => true,
  tsc: () => true,
}

export function runProjectCommand(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const command = String(args.command ?? '')
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : []

  const validator = ALLOWED_COMMANDS[command]

  if (!validator) {
    return {
      success: false,
      error: `Command "${command}" is not allowlisted. Allowed: ${Object.keys(ALLOWED_COMMANDS).join(', ')}.`,
    }
  }

  if (!validator(commandArgs)) {
    return {
      success: false,
      error: `Command "${command} ${commandArgs.join(' ')}" is not an allowed invocation.`,
    }
  }

  const result = spawnSync(command, commandArgs, {
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
