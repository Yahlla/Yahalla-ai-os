import { listProjectFiles, patchProjectFile, readProjectFile, writeProjectFile, type ToolResult } from './files.js'
import { gitDiff, gitStatus } from './git.js'
import { runProjectCommand } from './run_command.js'
import { PathEscapeError } from './sandbox.js'

export type DeviceToolExecutor = (projectRoot: string, args: Record<string, unknown>) => ToolResult

const REGISTRY: Record<string, DeviceToolExecutor> = {
  read_project_file: readProjectFile,
  list_project_files: listProjectFiles,
  write_project_file: writeProjectFile,
  patch_project_file: patchProjectFile,
  git_status: (root) => gitStatus(root),
  git_diff: (root, args) => gitDiff(root, args),
  run_project_command: runProjectCommand,
}

export function executeDeviceTool(toolKey: string, projectRoot: string, args: Record<string, unknown>): ToolResult {
  const executor = REGISTRY[toolKey]

  if (!executor) {
    return { success: false, error: `No local executor registered for tool "${toolKey}".` }
  }

  try {
    return executor(projectRoot, args)
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { success: false, error: error.message }
    }
    return { success: false, error: error instanceof Error ? error.message : 'Tool execution failed.' }
  }
}
