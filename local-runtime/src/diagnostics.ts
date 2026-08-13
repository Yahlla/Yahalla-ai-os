import { createHash } from 'node:crypto'

// Lightweight, dependency-free structured diagnosis for a failed
// run_project_command result -- extracts what a human would glance for
// first (error category, the file/line it likely points at) without
// building a general error-parsing framework. Raw stdout/stderr are never
// replaced, only supplemented: the model still sees everything it saw
// before, plus this summary up front.

export type CommandErrorType =
  | 'test_failure'
  | 'build_failure'
  | 'syntax_error'
  | 'type_error'
  | 'module_not_found'
  | 'permission_denied'
  | 'timeout'
  | 'unknown'

export type CommandDiagnostic = {
  command: string
  exitCode: number | null
  errorType: CommandErrorType
  likelyFile: string | null
  likelyLine: number | null
  // Stable identifier for "this exact command failed this exact way" --
  // used by agentLoop.ts to detect the model repeating a failed strategy
  // without having to compare full stdout/stderr blobs.
  failureSignature: string
}

const FILE_LINE_PATTERN = /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cpp|h|hpp))[:(]\s*(\d+)/

function classifyErrorType(command: string, output: string): CommandErrorType {
  if (/permission denied|eacces/i.test(output)) return 'permission_denied'
  if (/cannot find module|module not found|modulenotfounderror|err_module_not_found/i.test(output)) return 'module_not_found'
  if (/error ts\d+/i.test(output)) return 'type_error'
  if (/syntaxerror|unexpected token/i.test(output)) return 'syntax_error'
  if (/\d+ (failing|failed)\b|\bfail\b.*\btest/i.test(output) || /\btest\b/i.test(command)) return 'test_failure'
  if (/build failed|compilation failed/i.test(output) || /\bbuild\b/i.test(command)) return 'build_failure'
  return 'unknown'
}

export function diagnoseCommandFailure(
  command: string,
  result: { exit_code?: number | null; stdout?: string; stderr?: string },
): CommandDiagnostic {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  const fileLineMatch = output.match(FILE_LINE_PATTERN)
  const exitCode = result.exit_code ?? null
  const errorType = exitCode === null ? 'timeout' : classifyErrorType(command, output)

  // First non-empty line of the combined output is usually the actual
  // error message (test frameworks and compilers alike tend to print the
  // headline error first) -- stable enough to fingerprint "the same
  // failure" without being thrown off by timestamps/whitespace deeper in
  // the log.
  const firstLine = output.split('\n').find((l) => l.trim().length > 0) ?? ''
  const failureSignature = createHash('sha256')
    .update(`${command}::${exitCode}::${firstLine.trim().slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16)

  return {
    command,
    exitCode,
    errorType,
    likelyFile: fileLineMatch?.[1] ?? null,
    likelyLine: fileLineMatch ? Number(fileLineMatch[2]) : null,
    failureSignature,
  }
}

// Generic signature for any tool's failure (not just run_project_command),
// used for the repeated-failure detector -- coarser than
// diagnoseCommandFailure's (no stdout/stderr to draw a "first line" from
// for most tools), but still stable per {tool, arguments, error}.
export function signatureForToolFailure(toolKey: string, args: Record<string, unknown>, error: unknown): string {
  return createHash('sha256')
    .update(`${toolKey}::${JSON.stringify(sortKeys(args))}::${JSON.stringify(error).slice(0, 300)}`)
    .digest('hex')
    .slice(0, 16)
}

// Stable stringify: object key order shouldn't affect whether two
// argument sets are considered "the same call" for dedup/repeat detection.
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }
  return value
}
