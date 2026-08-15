import { listProjectFiles, patchProjectFile, readProjectFile, writeProjectFile, type ToolResult } from './files.js'
import { gitCommit, gitCreateBranch, gitDiff, gitPush, gitStatus } from './git.js'
import { runProjectCommand } from './run_command.js'
import { PathEscapeError } from './sandbox.js'

export type DeviceToolExecutor = (
  projectRoot: string,
  args: Record<string, unknown>,
  toolConfiguration: Record<string, unknown>,
  signal?: AbortSignal,
) => ToolResult | Promise<ToolResult>

// Every entry other than run_project_command is genuinely synchronous
// (in-process file/git operations) -- wrapping executeDeviceTool itself in
// async is what lets a real cancellation signal reach run_project_command's
// now-async spawn() (see run_command.ts) without needing every other tool
// to pretend to be async too.
const REGISTRY: Record<string, DeviceToolExecutor> = {
  read_project_file: (root, args) => readProjectFile(root, args),
  list_project_files: (root, args) => listProjectFiles(root, args),
  write_project_file: (root, args) => writeProjectFile(root, args),
  patch_project_file: (root, args) => patchProjectFile(root, args),
  git_status: (root) => gitStatus(root),
  git_diff: (root, args) => gitDiff(root, args),
  git_create_branch: (root, args) => gitCreateBranch(root, args),
  git_commit: (root, args) => gitCommit(root, args),
  git_push: (root, args) => gitPush(root, args),
  run_project_command: (root, args, config, signal) => {
    const allowlist = Array.isArray(config?.allowlist)
      ? config.allowlist.map(String)
      : undefined
    return allowlist ? runProjectCommand(root, args, allowlist, signal) : runProjectCommand(root, args, undefined, signal)
  },
}

export async function executeDeviceTool(
  toolKey: string,
  projectRoot: string,
  args: Record<string, unknown>,
  toolConfiguration: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolResult> {
  const executor = REGISTRY[toolKey]

  if (!executor) {
    return { success: false, error: `No local executor registered for tool "${toolKey}".` }
  }

  try {
    return await executor(projectRoot, args, toolConfiguration, signal)
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { success: false, error: error.message }
    }
    return { success: false, error: error instanceof Error ? error.message : 'Tool execution failed.' }
  }
}
