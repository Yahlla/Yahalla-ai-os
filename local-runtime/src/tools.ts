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
    key: 'get_project_overview',
    category: 'files',
    requiresApproval: false,
    description: 'Get a structured overview of the project: language/file-type counts, every detected package.json (name, scripts, dependencies), config files present, top-level layout, and real git state (branch, latest commit, whether the working tree is dirty). Cached briefly for speed -- pass refresh=true right after making several file changes to force a fresh scan. Read-only, and a summary only -- use read_project_file for a file\'s exact content.',
    parameters: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: 'Force a fresh scan instead of the cached overview.' } },
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
    requiresApproval: false,
    description: 'Create or overwrite a file in the project workspace. Not approval-gated -- the review checkpoint for code changes is the pull request opened with github.open_pr, not each individual write.',
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
    requiresApproval: false,
    description: 'Replace an exact, unique block of text in an existing file. old_text must be copied verbatim from a prior read_project_file result. Not approval-gated -- see write_project_file.',
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
    requiresApproval: false,
    description: 'Stage all changes and create a git commit. Not approval-gated -- commit freely on a branch, the review checkpoint is the pull request (github.open_pr).',
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
    requiresApproval: false,
    description: 'Push the current (or given) branch to the "origin" remote, using whatever git credentials are already configured on this machine. Not approval-gated -- push a feature branch freely, then open a pull request (github.open_pr) rather than pushing straight to a default/production branch.',
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
    requiresApproval: false,
    description: 'Run an allowlisted command (see the tool configuration) in the project directory -- e.g. running the test/build/lint suite to verify a change. Not approval-gated: the allowlist itself is the safety boundary.',
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
    key: 'github.open_pr',
    category: 'github',
    requiresApproval: false,
    description: 'Open a pull request on GitHub. This IS the human review checkpoint for a code change -- call it once a fix/feature is committed (git_commit) and pushed to its own branch (git_push), instead of asking for approval on every file write/commit/push. Never merges anything; merging stays a manual human action.',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'PR description -- summarize what changed, why, and what you verified (tests run, output).' },
        head: { type: 'string', description: 'Branch containing the changes, already pushed via git_push.' },
        base: { type: 'string', description: 'Branch to merge into. Defaults to "main".' },
      },
      required: ['owner', 'repo', 'title', 'head'],
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
