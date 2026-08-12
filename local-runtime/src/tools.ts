import type { AccessLevel, PermissionScope } from './permissions.js'

export type ToolDef = {
  key: string
  category: 'files' | 'system' | 'github' | 'database'
  requiresApproval: boolean
  description: string
  parameters: Record<string, unknown>
  permission: { scope: PermissionScope; access: AccessLevel }
}

export const TOOLS: ToolDef[] = [
  {
    key: 'read_project_file',
    category: 'files',
    requiresApproval: false,
    description: 'Read a file from the project workspace. Read-only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the project root.' } },
      required: ['path'],
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'read' },
  },
  {
    key: 'list_project_files',
    category: 'files',
    requiresApproval: false,
    description: 'List files and directories under a path in the project workspace (use "." for the whole project). Read-only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the project root. Use "." for the project root.' } },
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'read' },
  },
  {
    key: 'write_project_file',
    category: 'files',
    requiresApproval: true,
    description: 'Create or overwrite a file in the project workspace. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'Full new content of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'write' },
  },
  {
    key: 'patch_project_file',
    category: 'files',
    requiresApproval: true,
    description: 'Replace an exact, unique block of text in an existing file. old_text must be copied verbatim from a prior read_project_file result. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        old_text: { type: 'string', description: 'Exact, unique text to replace, copied verbatim from the most recent read_project_file result.' },
        new_text: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'write' },
  },
  {
    key: 'git_status',
    category: 'system',
    requiresApproval: false,
    description: 'Show the working tree status of the project git repository. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: { scope: 'project', access: 'read' },
  },
  {
    key: 'git_diff',
    category: 'system',
    requiresApproval: false,
    description: 'Show unstaged or staged changes in the project git repository, optionally scoped to one path. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (--cached) diff instead of the working tree diff.' },
        path: { type: 'string', description: 'Optional: scope the diff to one file path.' },
      },
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'read' },
  },
  {
    key: 'git_create_branch',
    category: 'system',
    requiresApproval: false,
    description: 'Create and switch to a new local git branch.',
    parameters: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'New branch name.' } },
      required: ['branch'],
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'write' },
  },
  {
    key: 'git_commit',
    category: 'system',
    requiresApproval: true,
    description: 'Stage all changes and create a git commit. Requires approval.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message.' } },
      required: ['message'],
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'write' },
  },
  {
    key: 'git_push',
    category: 'system',
    requiresApproval: true,
    description: 'Push the current (or given) branch to the "origin" remote, using whatever git credentials are already configured on this machine. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to push. Defaults to the current branch.' },
        remote_url: { type: 'string', description: 'https:// or git@ URL to set as "origin" before pushing. Omit if origin is already configured.' },
      },
      additionalProperties: false,
    },
    permission: { scope: 'project', access: 'write' },
  },
  {
    key: 'run_project_command',
    category: 'system',
    requiresApproval: true,
    description: 'Run an allowlisted command (see the tool configuration) in the project directory. Requires approval.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'One of the exact allowlisted command strings (e.g. "npm run build").' } },
      required: ['command'],
      additionalProperties: false,
    },
    permission: { scope: 'command_execution', access: 'execute' },
  },
  {
    key: 'github.read',
    category: 'github',
    requiresApproval: false,
    description: 'Read authorized GitHub data. operation="list_repos" lists the user\'s existing repositories. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list_repos'] },
        query: { type: 'string', description: 'Optional: filter repositories whose name contains this text.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    permission: { scope: 'network', access: 'read' },
  },
  {
    key: 'github.write',
    category: 'github',
    requiresApproval: true,
    description: 'Modify authorized GitHub data. operation="create_repo" creates a new repository and returns its clone URLs for use with git_push. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create_repo'] },
        name: { type: 'string' },
        private: { type: 'boolean' },
        description: { type: 'string' },
      },
      required: ['operation', 'name'],
      additionalProperties: false,
    },
    permission: { scope: 'network', access: 'write' },
  },
  {
    key: 'db_list_connections',
    category: 'database',
    requiresApproval: false,
    description: 'List the databases connected in Settings -> Integrations, by name and id. Call this before db_query/db_execute if you don\'t already know the connection id. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: { scope: 'network', access: 'read' },
  },
  {
    key: 'db_query',
    category: 'database',
    requiresApproval: false,
    description: 'Run a read-only SQL query (SELECT/EXPLAIN/etc.) against a connected database. Runs inside a real read-only transaction -- any data-modifying statement is rejected by the database itself, not just disallowed by convention. Use db_execute for writes/DDL. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'id from db_list_connections.' },
        query: { type: 'string', description: 'SQL to run.' },
      },
      required: ['connection_id', 'query'],
      additionalProperties: false,
    },
    permission: { scope: 'network', access: 'read' },
  },
  {
    key: 'db_execute',
    category: 'database',
    requiresApproval: true,
    description: 'Run a data-modifying SQL statement (INSERT/UPDATE/DELETE/DDL) against a connected database. Requires approval -- the exact SQL is shown to the user before it runs.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'id from db_list_connections.' },
        query: { type: 'string', description: 'SQL to run.' },
      },
      required: ['connection_id', 'query'],
      additionalProperties: false,
    },
    permission: { scope: 'network', access: 'write' },
  },
]

export const DEFAULT_RUN_COMMAND_ALLOWLIST = [
  'npm run build',
  'npm run lint',
  'npm test',
  'tsc --noEmit',
  'git status',
  'git diff',
  'git log',
]

export function getTool(key: string): ToolDef | undefined {
  return TOOLS.find((t) => t.key === key)
}

export function buildOpenAITools(): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.key, description: t.description, parameters: t.parameters },
  }))
}
