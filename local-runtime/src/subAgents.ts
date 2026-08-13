// Real multi-agent orchestration: a small set of specialized worker
// profiles the main agent loop can dispatch a bounded subtask to. Each
// profile is a real restriction (its own system-prompt focus, its own
// tool allowlist, its own round budget), not a cosmetic label -- a
// dispatched sub-agent genuinely cannot call tools outside its
// allowlist (agentLoop.ts's runSubAgentLoop filters the tools offered to
// the LLM to exactly this list), and it genuinely runs its own real
// tool-calling loop against the local model, returning a real report
// (and the real tool trace that produced it) back to the orchestrator.
// This replaces the old "12 agents" concept, which was inert Supabase
// seed data feeding a cosmetic UI dropdown with zero effect on behavior.

export type SubAgentProfileKey = 'researcher' | 'coder' | 'tester' | 'reviewer'

export type SubAgentProfile = {
  key: SubAgentProfileKey
  name: string
  focus: string
  allowedToolKeys: string[]
  maxRounds: number
}

export const SUB_AGENT_PROFILES: Record<SubAgentProfileKey, SubAgentProfile> = {
  researcher: {
    key: 'researcher',
    name: 'Researcher',
    focus:
      'Investigate and report real facts only -- you cannot modify anything. Use get_project_overview, list_project_files, read_project_file, git_status, git_diff, db_list_connections/db_query, and the browser_* tools to gather real information, then answer with exactly what you actually found. Never guess or fill gaps with assumption.',
    allowedToolKeys: [
      'get_project_overview',
      'list_project_files',
      'read_project_file',
      'git_status',
      'git_diff',
      'db_list_connections',
      'db_query',
      'browser_open',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_close',
    ],
    maxRounds: 8,
  },
  coder: {
    key: 'coder',
    name: 'Coder',
    focus:
      'Implement exactly the requested change in the project. Read what you need first (never guess file contents), then write/patch the files, and report precisely what you changed and why.',
    allowedToolKeys: ['get_project_overview', 'list_project_files', 'read_project_file', 'write_project_file', 'patch_project_file', 'git_status', 'git_diff'],
    maxRounds: 10,
  },
  tester: {
    key: 'tester',
    name: 'Tester',
    focus:
      "Run the project's real test/build/lint commands and report exactly what passed and what failed, quoting real output. You do not fix anything yourself -- that is a different sub-agent's job.",
    allowedToolKeys: ['get_project_overview', 'read_project_file', 'run_project_command'],
    maxRounds: 6,
  },
  reviewer: {
    key: 'reviewer',
    name: 'Reviewer',
    focus:
      'Review the current uncommitted changes for correctness and risk. Use git_diff/read_project_file to inspect the real diff -- never guess what changed. Report concrete issues found, or state plainly that nothing looked wrong.',
    allowedToolKeys: ['get_project_overview', 'read_project_file', 'git_status', 'git_diff'],
    maxRounds: 6,
  },
}

export function getSubAgentProfile(key: string): SubAgentProfile | undefined {
  return Object.prototype.hasOwnProperty.call(SUB_AGENT_PROFILES, key) ? SUB_AGENT_PROFILES[key as SubAgentProfileKey] : undefined
}
