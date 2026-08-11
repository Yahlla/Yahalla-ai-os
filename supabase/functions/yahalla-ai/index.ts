import { createClient } from 'npm:@supabase/supabase-js@2'

function buildCorsHeaders(origin: string | null) {
  const allowedOrigins = (
    Deno.env.get('YAHALLA_ALLOWED_ORIGINS') ??
    'https://yahalla-ai.yahalla.de'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const allowOrigin =
    origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Client-Info, Apikey',
    Vary: 'Origin',
  }
}

function jsonWithHeaders(
  data: unknown,
  status: number,
  headers: Record<string, string>,
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

type RequestBody = {
  message?: string
  conversation_id?: string
  project_id?: string
  agent_key?: string
  model_id?: string
  approval_action?: 'approve' | 'reject'
  tool_execution_id?: string
  decision_note?: string
  device_action?:
    | 'pair_device'
    | 'device_exchange'
    | 'device_heartbeat'
    | 'resume_task'
  device_name?: string
  device_platform?: string
  device_capabilities?: Record<string, unknown>
  pairing_code?: string
  task_id?: string
}

type ToolDefinition = {
  id: string
  key: string
  category: string
  requires_approval: boolean
  configuration: Record<string, unknown>
}

type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type ModelRow = {
  id: string
  key: string
  name: string
  provider: string
  type: string
  endpoint: string
  status: string
  priority: number
  enabled: boolean
  is_local: boolean
  configuration: Record<string, unknown>
  server_id: string | null
}

type AgentRow = {
  id: string
  key: string
  name_ar: string
  name_de: string
  description: string | null
  status: string
  role: string
  configuration: Record<string, unknown>
  model_id: string | null
  fallback_model_id: string | null
  server_id: string | null
}

// Tools in these categories touch the local filesystem/shell and can only
// run where a real project checkout exists -- i.e. on a paired Device
// Agent, never inside the stateless edge function. "servers"/"models"
// register LLM inference backends; "devices" are a different concept, see
// supabase/migrations/20260812010000_device_execution_unified.sql.
const DEVICE_TOOL_CATEGORIES = ['files', 'system']

function isDeviceScopedTool(tool: ToolDefinition): boolean {
  return DEVICE_TOOL_CATEGORIES.includes(tool.category)
}

function extractMessage(data: any): any {
  if (!data) return null
  if (data.choices?.[0]?.message) return data.choices[0].message
  if (data.message) return data.message
  return null
}

function extractText(data: any): string {
  if (!data) return ''
  if (typeof data === 'string') return data
  if (typeof data.output === 'string') return data.output
  if (typeof data.response === 'string') return data.response
  if (typeof data.message === 'string') return data.message
  if (typeof data.message?.content === 'string') return data.message.content
  if (typeof data.choices?.[0]?.message?.content === 'string')
    return data.choices[0].message.content
  if (typeof data.choices?.[0]?.text === 'string') return data.choices[0].text
  if (Array.isArray(data.output)) {
    return data.output
      .map((item: any) => {
        if (typeof item === 'string') return item
        if (typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractToolCalls(data: any): ToolCall[] {
  const message = extractMessage(data)
  if (!message) return []
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.filter(
    (call: any) => call?.type === 'function' && call?.function?.name,
  )
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      return { raw: value }
    }
  }
  return {}
}

function toolDescription(key: string): string {
  switch (key) {
    case 'yahalla.read':
      return 'Read authorized Yahalla data (tasks, agents, tools, memory, runtime). Read-only.'
    case 'read_project_file':
      return 'Read a file from the project workspace, on the device where the project is checked out. Read-only.'
    case 'list_project_files':
      return 'List files and directories under a path in the project workspace (use "." for the whole project). Read-only.'
    case 'write_project_file':
      return 'Create or overwrite a file in the project workspace. Requires approval.'
    case 'patch_project_file':
      return 'Replace an exact, unique block of text in an existing file. old_text must be copied verbatim from a prior read_project_file result -- never invented. If it does not match, re-read the file and retry. Requires approval.'
    case 'git_status':
      return 'Show the working tree status of the project git repository. Read-only.'
    case 'git_diff':
      return 'Show unstaged or staged changes in the project git repository, optionally scoped to one path. Read-only.'
    case 'run_project_command':
      return 'Run an allowlisted command (see the tool configuration) in the project directory. Requires approval.'
    case 'git_create_branch':
      return 'Create and switch to a new local git branch, on the device where the project is checked out.'
    case 'git_commit':
      return 'Stage all changes and create a git commit, on the device where the project is checked out. Requires approval.'
    case 'git_push':
      return 'Push the current (or given) branch to the "origin" remote, on the device where the project is checked out. Pass remote_url to point origin at a repository for the first time (e.g. one just created with github.write). Uses whatever git credentials are already configured on that machine -- never ask the user to paste a token here. Requires approval.'
    case 'web.search':
      return 'Search publicly available web information.'
    case 'github.read':
      return 'Read authorized GitHub data. operation="list_repos" lists the user\'s existing repositories (use this to offer a choice before creating a new one). Read-only.'
    case 'github.write':
      return 'Modify authorized GitHub data. operation="create_repo" creates a new repository under the user\'s account and returns its clone URLs for use with git_push. Requires approval.'
    case 'email.send':
      return 'Send an email. Requires approval.'
    case 'yahalla.api':
      return 'Perform an authorized Yahalla API operation. Requires approval.'
    default:
      return `Execute the authorized ${key} tool.`
  }
}

// Each tool needs the LLM to send the right argument shape -- a single
// generic "query" string does not work for the file/git/command tools,
// which need structured arguments matching what the Device Agent's tool
// executors actually expect (device-agent/src/tools/*.ts).
function toolParameterSchema(key: string): Record<string, unknown> {
  switch (key) {
    case 'read_project_file':
      return {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
        },
        required: ['path'],
        additionalProperties: false,
      }

    case 'list_project_files':
      return {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to the project root. Use "." for the project root.',
          },
        },
        additionalProperties: false,
      }

    case 'write_project_file':
      return {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'Full new content of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }

    case 'patch_project_file':
      return {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_text: {
            type: 'string',
            description: 'Exact, unique text to replace, copied verbatim from the most recent read_project_file result.',
          },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      }

    case 'git_status':
      return { type: 'object', properties: {}, additionalProperties: false }

    case 'git_diff':
      return {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged (--cached) diff instead of the working tree diff.' },
          path: { type: 'string', description: 'Optional: scope the diff to one file path.' },
        },
        additionalProperties: false,
      }

    case 'run_project_command':
      return {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'One of the exact allowlisted command strings from this tool\'s configuration (e.g. "npm run build").',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }

    case 'git_create_branch':
      return {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'New branch name.' },
        },
        required: ['branch'],
        additionalProperties: false,
      }

    case 'git_commit':
      return {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message.' },
        },
        required: ['message'],
        additionalProperties: false,
      }

    case 'git_push':
      return {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch to push. Defaults to the current branch.' },
          remote_url: {
            type: 'string',
            description: 'https:// or git@ URL to set as "origin" before pushing (e.g. from a github.write create_repo result). Omit if origin is already configured.',
          },
        },
        additionalProperties: false,
      }

    case 'github.read':
      return {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list_repos'], description: 'Which GitHub read operation to perform.' },
          query: { type: 'string', description: 'Optional: filter repositories whose name contains this text.' },
        },
        required: ['operation'],
        additionalProperties: false,
      }

    case 'github.write':
      return {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['create_repo'], description: 'Which GitHub write operation to perform.' },
          name: { type: 'string', description: 'Repository name for create_repo.' },
          private: { type: 'boolean', description: 'Create the repository as private. Defaults to true.' },
          description: { type: 'string', description: 'Optional repository description.' },
        },
        required: ['operation', 'name'],
        additionalProperties: false,
      }

    default:
      return {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The requested query or operation.' },
        },
        required: ['query'],
        additionalProperties: true,
      }
  }
}

function buildOpenAITool(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.key,
      description: toolDescription(tool.key),
      parameters: toolParameterSchema(tool.key),
    },
  }
}

// =============================================================
// Model Router
// =============================================================

function selectModel(
  models: ModelRow[],
  preferredModelId: string | null,
  taskType: string,
): ModelRow | null {
  const enabled = models.filter((m) => m.enabled && m.status === 'online')

  if (preferredModelId) {
    const preferred = enabled.find((m) => m.id === preferredModelId)
    if (preferred) return preferred
  }

  const byType = enabled.filter((m) => m.type === taskType)
  if (byType.length > 0) {
    byType.sort((a, b) => b.priority - a.priority)
    return byType[0]
  }

  const general = enabled.filter((m) => m.type === 'general')
  if (general.length > 0) {
    general.sort((a, b) => b.priority - a.priority)
    return general[0]
  }

  if (enabled.length > 0) {
    enabled.sort((a, b) => b.priority - a.priority)
    return enabled[0]
  }

  return null
}

function selectModelWithFallback(
  models: ModelRow[],
  preferredModelId: string | null,
  fallbackModelId: string | null,
  taskType: string,
): ModelRow | null {
  const primary = selectModel(models, preferredModelId, taskType)
  if (primary) return primary

  if (fallbackModelId) {
    const fallback = models.find(
      (m) => m.id === fallbackModelId && m.enabled && m.status === 'online',
    )
    if (fallback) return fallback
  }

  const anyEnabled = models
    .filter((m) => m.enabled && m.status === 'online')
    .sort((a, b) => b.priority - a.priority)
  return anyEnabled[0] ?? null
}

function buildLLMUrl(model: ModelRow, serverHostname: string, serverPort: number): string {
  if (model.endpoint && model.endpoint.startsWith('http')) {
    return model.endpoint
  }
  const endpoint = model.endpoint || '/v1/chat/completions'
  return `http://${serverHostname}:${serverPort}${endpoint}`
}

async function resolveLLMUrl(
  admin: ReturnType<typeof createClient>,
  envLLMUrl: string | undefined,
  selectedModel: ModelRow,
): Promise<string> {
  if (envLLMUrl) return envLLMUrl

  let serverHostname = '127.0.0.1'
  let serverPort = 8080

  if (selectedModel.server_id) {
    const { data: server } = await admin
      .from('servers')
      .select('hostname, port')
      .eq('id', selectedModel.server_id)
      .maybeSingle()
    if (server) {
      serverHostname = server.hostname
      serverPort = server.port
    }
  }

  return buildLLMUrl(selectedModel, serverHostname, serverPort)
}

type LLMCallResult =
  | { ok: true; response: Response; data: any; rawText: string }
  | { ok: false; errorMessage: string }

async function callLLM(
  llmUrl: string,
  payload: Record<string, unknown>,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<LLMCallResult> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(llmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const rawText = await response.text()

    console.log('YAHALLA_LLM_DEBUG', JSON.stringify({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      responseBody: rawText.slice(0, 2000),
    }))

    let data: any
    try {
      data = JSON.parse(rawText)
    } catch {
      data = rawText
    }

    return { ok: true, response, data, rawText }
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    const errorMessage = isAbort
      ? `LLM request timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message
        : 'LLM request failed.'

    console.error('YAHALLA_LLM_ERROR', errorMessage)

    return { ok: false, errorMessage }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

// =============================================================
// Tool executors
// =============================================================

async function executeYahallaRead(
  admin: ReturnType<typeof createClient>,
  args: Record<string, unknown>,
  userId: string,
) {
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''

  if (
    query.includes('open task') ||
    query.includes('offene aufgaben') ||
    query.includes('pending task') ||
    (query.includes('tasks') && !query.includes('agent'))
  ) {
    const { data, error } = await admin
      .from('tasks')
      .select('id,title,description,status,priority,created_at,updated_at,current_step,progress')
      .eq('requested_by', userId)
      .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'waiting_device'])
      .order('created_at', { ascending: false })
      .limit(25)

    if (error) throw new Error(`Failed to read tasks: ${error.message}`)
    return { success: true, operation: 'tasks.list_open', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (query.includes('agent')) {
    const { data, error } = await admin
      .from('agents')
      .select('id,key,name_ar,name_de,role,description,status,configuration')
      .order('created_at', { ascending: false })
      .limit(25)
    if (error) throw new Error(`Failed to read agents: ${error.message}`)
    return { success: true, operation: 'agents.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (query.includes('device')) {
    const { data, error } = await admin
      .from('devices')
      .select('id,name,platform,status,last_heartbeat_at,paired_at')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(25)
    if (error) throw new Error(`Failed to read devices: ${error.message}`)
    return { success: true, operation: 'devices.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (query.includes('tool')) {
    const { data, error } = await admin
      .from('tools')
      .select('id,key,name_ar,name_de,category,status,requires_approval,configuration')
      .order('key', { ascending: true })
    if (error) throw new Error(`Failed to read tools: ${error.message}`)
    return { success: true, operation: 'tools.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (
    query.includes('runtime') ||
    query.includes('core runtime') ||
    query.includes('runtime state') ||
    query.includes('runtime status') ||
    query.includes('حالة runtime')
  ) {
    const { data: runtimeAgent, error: runtimeError } = await admin
      .from('agents')
      .select('id,key,name_ar,name_de,description,status,configuration')
      .eq('key', 'yahalla-core')
      .maybeSingle()
    if (runtimeError) throw new Error(`Failed to read runtime: ${runtimeError.message}`)

    const { data: openTasks, error: openTasksError } = await admin
      .from('tasks')
      .select('id,title,status,priority,created_at,updated_at')
      .eq('assigned_agent', runtimeAgent?.id ?? '')
      .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'waiting_device'])
      .order('created_at', { ascending: false })
      .limit(25)
    if (openTasksError) throw new Error(`Failed to read runtime tasks: ${openTasksError.message}`)

    const { data: recentExecutions, error: executionsError } = await admin
      .from('tool_executions')
      .select('id,tool_id,agent_id,task_id,status,created_at,completed_at,error')
      .eq('agent_id', runtimeAgent?.id ?? '')
      .order('created_at', { ascending: false })
      .limit(25)
    if (executionsError) throw new Error(`Failed to read executions: ${executionsError.message}`)

    const { data: models, error: modelsError } = await admin
      .from('models')
      .select('id,key,name,type,status,enabled,is_local')
      .order('priority', { ascending: false })
    if (modelsError) throw new Error(`Failed to read models: ${modelsError.message}`)

    const { data: servers, error: serversError } = await admin
      .from('servers')
      .select('id,name,type,hostname,port,status,last_heartbeat')
      .order('created_at', { ascending: false })
    if (serversError) throw new Error(`Failed to read servers: ${serversError.message}`)

    const { data: devices, error: devicesError } = await admin
      .from('devices')
      .select('id,name,platform,status,last_heartbeat_at')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
    if (devicesError) throw new Error(`Failed to read devices: ${devicesError.message}`)

    return {
      success: true,
      operation: 'runtime.status',
      runtime: {
        agent_key: runtimeAgent?.key ?? 'yahalla-core',
        status: runtimeAgent?.status ?? 'unknown',
        configured: Boolean(runtimeAgent),
        active: Boolean(runtimeAgent && runtimeAgent.status === 'active'),
      },
      open_tasks: { count: openTasks?.length ?? 0, rows: openTasks ?? [] },
      recent_executions: { count: recentExecutions?.length ?? 0, rows: recentExecutions ?? [] },
      models: { count: models?.length ?? 0, rows: models ?? [] },
      servers: { count: servers?.length ?? 0, rows: servers ?? [] },
      devices: { count: devices?.length ?? 0, rows: devices ?? [] },
      message: runtimeAgent?.status === 'active'
        ? 'Yahalla Core Runtime is active.'
        : 'Yahalla Core Runtime is not active.',
    }
  }

  if (query.includes('memory') || query.includes('memories')) {
    const { data, error } = await admin
      .from('ai_memory')
      .select('id,scope,memory_key,content,importance,created_at,updated_at')
      .or(`scope.eq.global,owner_id.eq.${userId}`)
      .order('importance', { ascending: false })
      .limit(25)
    if (error) throw new Error(`Failed to read memory: ${error.message}`)
    return { success: true, operation: 'memory.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (query.includes('model') || query.includes('models')) {
    const { data, error } = await admin
      .from('models')
      .select('id,key,name,provider,type,status,enabled,priority,is_local,context_length')
      .order('priority', { ascending: false })
    if (error) throw new Error(`Failed to read models: ${error.message}`)
    return { success: true, operation: 'models.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  if (query.includes('server') || query.includes('servers')) {
    const { data, error } = await admin
      .from('servers')
      .select('id,name,type,hostname,port,status,runtime_version,last_heartbeat')
      .order('created_at', { ascending: false })
    if (error) throw new Error(`Failed to read servers: ${error.message}`)
    return { success: true, operation: 'servers.list', count: data?.length ?? 0, rows: data ?? [] }
  }

  return {
    success: false,
    operation: 'unsupported',
    message: 'The requested read operation is not implemented.',
    query,
  }
}

// GitHub API calls run inline in the edge function (it can reach
// api.github.com from Supabase's cloud, unlike the user's own machine) and
// use a GitHub personal access token stored as the YAHALLA_GITHUB_TOKEN
// secret. This never touches the local git checkout -- committing and
// pushing real code is device-scoped (git_commit/git_push in
// device-agent/src/tools/git.ts), using whatever git credentials are
// already configured on that machine. These two only talk to the GitHub
// API itself: listing repos to choose from, and creating a new one.
async function executeGithubRead(args: Record<string, unknown>) {
  const token = Deno.env.get('YAHALLA_GITHUB_TOKEN')
  if (!token) {
    return {
      success: false,
      operation: 'github.read',
      message: 'GitHub integration is not configured. Set the YAHALLA_GITHUB_TOKEN secret (a GitHub personal access token with repo scope) to enable it.',
    }
  }

  const operation = String(args.operation ?? '')

  if (operation === 'list_repos') {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
    const response = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'yahalla-ai-os',
      },
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        success: false,
        operation: 'github.read',
        status: response.status,
        message: 'GitHub API request failed.',
        details: text.slice(0, 2000),
      }
    }
    let repos: any[] = []
    try {
      repos = JSON.parse(text)
    } catch {
      repos = []
    }
    const filtered = query
      ? repos.filter((r) => String(r?.name ?? '').toLowerCase().includes(query))
      : repos
    return {
      success: true,
      operation: 'github.read',
      count: filtered.length,
      repos: filtered.map((r) => ({
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        html_url: r.html_url,
        clone_url: r.clone_url,
        ssh_url: r.ssh_url,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
      })),
    }
  }

  return { success: false, operation: 'github.read', message: `Unsupported operation "${operation}".` }
}

async function executeGithubWrite(args: Record<string, unknown>) {
  const token = Deno.env.get('YAHALLA_GITHUB_TOKEN')
  if (!token) {
    return {
      success: false,
      operation: 'github.write',
      message: 'GitHub integration is not configured. Set the YAHALLA_GITHUB_TOKEN secret (a GitHub personal access token with repo scope) to enable it.',
    }
  }

  const operation = String(args.operation ?? '')

  if (operation === 'create_repo') {
    const name = String(args.name ?? '').trim()
    if (!name) {
      return { success: false, operation: 'github.write', message: 'name is required.' }
    }

    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'yahalla-ai-os',
      },
      body: JSON.stringify({
        name,
        private: args.private !== false,
        description: typeof args.description === 'string' ? args.description : undefined,
      }),
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        success: false,
        operation: 'github.write',
        status: response.status,
        message: 'GitHub API request failed.',
        details: text.slice(0, 2000),
      }
    }
    let repo: any = {}
    try {
      repo = JSON.parse(text)
    } catch {
      repo = {}
    }
    return {
      success: true,
      operation: 'github.write',
      repo: {
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        html_url: repo.html_url,
        clone_url: repo.clone_url,
        ssh_url: repo.ssh_url,
        default_branch: repo.default_branch,
      },
    }
  }

  return { success: false, operation: 'github.write', message: `Unsupported operation "${operation}".` }
}

async function executeTool(
  admin: ReturnType<typeof createClient>,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  userId: string,
) {
  switch (tool.key) {
    case 'yahalla.read':
      return executeYahallaRead(admin, args, userId)

    case 'web.search':
      return {
        success: false,
        operation: 'web.search',
        message: 'web.search is registered but its external search adapter is not connected yet.',
      }

    case 'github.read':
      return executeGithubRead(args)

    case 'github.write':
      return executeGithubWrite(args)

    default:
      // Device-scoped tools (files/system category) are intercepted by
      // isDeviceScopedTool() before this function is ever called in normal
      // operation -- reaching here means no device was available, or a
      // tool has no executor at all.
      return {
        success: false,
        operation: tool.key,
        message: `The tool "${tool.key}" does not have an executor registered yet.`,
      }
  }
}

// =============================================================
// Device pairing / identity
//
// Each paired device gets its own dedicated Supabase Auth identity (never
// the service role key, never the owner's own session). RLS
// (current_device_id() in the device_execution migration) scopes that
// identity to only the task/tool rows explicitly assigned to it.
// =============================================================

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

async function handlePairDevice(
  admin: ReturnType<typeof createClient>,
  json: (data: unknown, status?: number) => Response,
  user: { id: string },
  body: RequestBody,
): Promise<Response> {
  const { data: profile } = await admin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !['owner', 'admin'].includes(profile.role)) {
    return json({ success: false, error: 'Only an owner or admin can pair a device.' }, 403)
  }

  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

  const { data: pairing, error } = await admin
    .from('device_pairing_codes')
    .insert({
      owner_id: user.id,
      code: generatePairingCode(),
      device_name_hint: typeof body.device_name === 'string' ? body.device_name.slice(0, 80) : null,
      expires_at: expiresAt,
    })
    .select('*')
    .single()

  if (error || !pairing) {
    return json({ success: false, error: 'Failed to create pairing code.', details: error?.message }, 500)
  }

  return json({ success: true, pairing_code: pairing.code, expires_at: pairing.expires_at })
}

async function handleDeviceExchange(
  admin: ReturnType<typeof createClient>,
  json: (data: unknown, status?: number) => Response,
  body: RequestBody,
): Promise<Response> {
  const code = body.pairing_code?.trim().toUpperCase()

  if (!code) {
    return json({ success: false, error: 'pairing_code is required.' }, 400)
  }

  const { data: pairing, error: pairingError } = await admin
    .from('device_pairing_codes')
    .select('*')
    .eq('code', code)
    .is('consumed_at', null)
    .maybeSingle()

  if (pairingError) {
    return json({ success: false, error: 'Failed to look up pairing code.', details: pairingError.message }, 500)
  }
  if (!pairing) {
    return json({ success: false, error: 'Invalid or already-used pairing code.' }, 404)
  }
  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    return json({ success: false, error: 'Pairing code has expired. Generate a new one from the Devices page.' }, 410)
  }

  const platform = ['macos', 'windows', 'linux'].includes(body.device_platform ?? '')
    ? (body.device_platform as string)
    : 'other'

  const deviceEmail = `device+${crypto.randomUUID()}@device.yahalla.local`
  const devicePassword = crypto.randomUUID() + crypto.randomUUID()

  const { data: created, error: createUserError } = await admin.auth.admin.createUser({
    email: deviceEmail,
    password: devicePassword,
    email_confirm: true,
    user_metadata: { yahalla_device: true },
  })

  if (createUserError || !created?.user) {
    return json({ success: false, error: 'Failed to create device identity.', details: createUserError?.message }, 500)
  }

  const { data: device, error: deviceError } = await admin
    .from('devices')
    .insert({
      owner_id: pairing.owner_id,
      auth_user_id: created.user.id,
      name: pairing.device_name_hint || `${platform} device`,
      platform,
      status: 'online',
      last_heartbeat_at: new Date().toISOString(),
      paired_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (deviceError || !device) {
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {})
    return json({ success: false, error: 'Failed to register device.', details: deviceError?.message }, 500)
  }

  const { data: session, error: signInError } = await admin.auth.signInWithPassword({
    email: deviceEmail,
    password: devicePassword,
  })

  if (signInError || !session?.session) {
    return json({ success: false, error: 'Device registered but failed to establish a session.', details: signInError?.message }, 500)
  }

  await admin
    .from('device_pairing_codes')
    .update({ consumed_at: new Date().toISOString(), device_id: device.id })
    .eq('id', pairing.id)
    .is('consumed_at', null)

  return json({
    success: true,
    device_id: device.id,
    device_name: device.name,
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    supabase_url: Deno.env.get('SUPABASE_URL'),
    supabase_anon_key: Deno.env.get('SUPABASE_ANON_KEY'),
  })
}

async function handleDeviceHeartbeat(
  admin: ReturnType<typeof createClient>,
  json: (data: unknown, status?: number) => Response,
  user: { id: string },
  body: RequestBody,
): Promise<Response> {
  const { data: device, error } = await admin
    .from('devices')
    .update({
      status: 'online',
      last_heartbeat_at: new Date().toISOString(),
      capabilities: body.device_capabilities ?? undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('auth_user_id', user.id)
    .neq('status', 'revoked')
    .select('id, name, status')
    .maybeSingle()

  if (error) {
    return json({ success: false, error: 'Failed to record heartbeat.', details: error.message }, 500)
  }
  if (!device) {
    return json({ success: false, error: 'This session is not a paired device (or it was revoked).' }, 403)
  }

  return json({ success: true, device_id: device.id, status: device.status })
}

async function resolveOnlineDeviceForOwner(
  admin: ReturnType<typeof createClient>,
  ownerId: string,
) {
  const { data: device } = await admin
    .from('devices')
    .select('id, name, status')
    .eq('owner_id', ownerId)
    .eq('status', 'online')
    .order('last_heartbeat_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return device
}

// =============================================================
// Shared agent-loop context, reused by the initial chat request and by
// resume_task (a device calling back in after finishing a dispatched
// tool).
// =============================================================

async function loadAgentToolsAndMemory(
  admin: ReturnType<typeof createClient>,
  agentId: string,
  userId: string,
) {
  const { data: permissions, error: permissionsError } = await admin
    .from('agent_permissions')
    .select('permission_id, permissions (id, key)')
    .eq('agent_id', agentId)

  if (permissionsError) throw new Error(permissionsError.message)

  const { data: toolRows, error: toolsError } = await admin
    .from('agent_tools')
    .select('enabled, tool_id, tools (id, key, category, status, requires_approval, configuration)')
    .eq('agent_id', agentId)
    .eq('enabled', true)

  if (toolsError) throw new Error(toolsError.message)

  const availableTools: ToolDefinition[] = (toolRows ?? [])
    .map((item: any) => {
      const tool = item.tools
      if (!tool || tool.status !== 'active') return null
      return {
        id: tool.id,
        key: tool.key,
        category: tool.category,
        requires_approval: Boolean(tool.requires_approval),
        configuration: tool.configuration ?? {},
      }
    })
    .filter(Boolean) as ToolDefinition[]

  const permissionKeys: string[] = (permissions ?? [])
    .map((item: any) => item.permissions?.key)
    .filter(Boolean)

  const { data: memories } = await admin
    .from('ai_memory')
    .select('*')
    .or(`scope.eq.global,owner_id.eq.${userId}`)
    .order('importance', { ascending: false })
    .limit(20)

  const memoryContext = (memories ?? []).map((memory: any) => ({
    key: memory.memory_key,
    content: memory.content,
    importance: memory.importance,
  }))

  return { availableTools, permissionKeys, memoryContext, memoryCount: memories?.length ?? 0 }
}

async function loadModelsAndSelect(
  admin: ReturnType<typeof createClient>,
  preferredModelId: string | null,
  fallbackModelId: string | null,
) {
  const { data: allModels } = await admin
    .from('models')
    .select('id,key,name,provider,type,endpoint,status,priority,enabled,is_local,configuration,server_id')
    .order('priority', { ascending: false })

  const modelsList: ModelRow[] = (allModels ?? []).map((m: any) => ({
    id: m.id, key: m.key, name: m.name, provider: m.provider, type: m.type,
    endpoint: m.endpoint, status: m.status, priority: m.priority, enabled: m.enabled,
    is_local: m.is_local, configuration: m.configuration ?? {}, server_id: m.server_id,
  }))

  const selectedModel = selectModelWithFallback(modelsList, preferredModelId, fallbackModelId, 'general')

  return { modelsList, selectedModel }
}

type AgentLoopContext = {
  admin: ReturnType<typeof createClient>
  json: (data: unknown, status?: number) => Response
  llmUrl: string
  llmApiKey: string | undefined
  llmTimeoutMs: number
  user: { id: string }
  task: { id: string; conversation_id: string | null; description?: string | null; input?: any }
  agent: AgentRow
  selectedModel: ModelRow
  availableTools: ToolDefinition[]
  permissionKeys: string[]
  memoryContext: any[]
  memoryCount: number
  conversationId: string
  messages: any[]
  executedTools: any[]
}

async function runAgentLoop(ctx: AgentLoopContext): Promise<Response> {
  const {
    admin, json, llmUrl, llmApiKey, llmTimeoutMs, user, task, agent, selectedModel,
    availableTools, permissionKeys, memoryContext, memoryCount, conversationId,
    messages, executedTools,
  } = ctx

  const message: string = task.description ?? task.input?.message ?? ''
  const llmTools = availableTools.map(buildOpenAITool)
  // A real "read -> edit -> verify -> test -> diagnose -> fix -> retest"
  // cycle can easily use most of a small fixed budget on its own (each
  // round is one LLM call). Configurable per agent via
  // agents.configuration.max_rounds (seeded for yahalla-core in
  // 20260812030000_yahalla_core_coding_and_github.sql); falls back to 12.
  const configuredMaxRounds = Number(agent.configuration?.max_rounds)
  const maxToolRounds = Number.isFinite(configuredMaxRounds) && configuredMaxRounds > 0
    ? Math.min(configuredMaxRounds, 30)
    : 12

  let finalLLMData: any = null

  for (let round = 0; round < maxToolRounds; round++) {
    const llmPayload = {
      model: selectedModel.key,
      messages,
      user_id: user.id,
      task_id: task.id,
      agent: { key: agent.key, configuration: agent.configuration },
      permissions: permissionKeys,
      tools: llmTools,
      memory: memoryContext,
    }

    console.log(`Calling Yahalla LLM round ${round + 1} with model ${selectedModel.key}`)

    const llmCallResult = await callLLM(llmUrl, llmPayload, llmApiKey, llmTimeoutMs)

    if (!llmCallResult.ok) {
      await admin.from('tasks').update({
        status: 'failed',
        error: { message: 'LLM request failed.', details: llmCallResult.errorMessage },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      return json({
        success: false,
        error: 'Yahalla LLM request failed.',
        task_id: task.id,
        conversation_id: conversationId,
        details: llmCallResult.errorMessage,
      }, 502)
    }

    const { response, data, rawText } = llmCallResult
    finalLLMData = data

    if (!response.ok) {
      await admin.from('tasks').update({
        status: 'failed',
        error: { message: 'LLM request failed.', status: response.status, response: rawText.slice(0, 4000) },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      return json({
        success: false,
        error: 'Yahalla LLM request failed.',
        task_id: task.id,
        conversation_id: conversationId,
        llm_status: response.status,
        details: rawText.slice(0, 4000),
      }, 502)
    }

    const toolCalls = extractToolCalls(data)

    if (!toolCalls.length) {
      const answer = extractText(data)

      if (!answer) {
        await admin.from('tasks').update({
          status: 'failed',
          error: { message: 'LLM returned no usable answer.', response: data },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', task.id)

        return json({
          success: false,
          error: 'LLM returned no usable answer.',
          task_id: task.id,
          conversation_id: conversationId,
          raw_response: data,
        }, 502)
      }

      await admin.from('tasks').update({
        status: 'completed',
        output: { answer, provider_response: finalLLMData, executed_tools: executedTools },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      await admin.from('conversation_messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: answer,
        agent_id: agent.id,
        model_id: selectedModel.id,
        task_id: task.id,
        tool_activity: executedTools,
        metadata: { model: selectedModel.key },
      })

      await admin.from('ai_memory').insert({
        scope: 'user',
        owner_id: user.id,
        agent_id: agent.id,
        task_id: task.id,
        memory_key: `conversation:${conversationId}`,
        content: `User: ${message}\nYahalla: ${answer}`,
        metadata: { type: 'conversation', tools: executedTools.map((i) => i.tool) },
        importance: 30,
      })

      return json({
        success: true,
        task_id: task.id,
        conversation_id: conversationId,
        status: 'completed',
        answer,
        agent: { id: agent.id, key: agent.key, name_ar: agent.name_ar, name_de: agent.name_de, status: agent.status, role: agent.role },
        model: { id: selectedModel.id, key: selectedModel.key, name: selectedModel.name, type: selectedModel.type },
        permissions: permissionKeys,
        tools: availableTools.map((t) => ({ key: t.key, category: t.category, requires_approval: t.requires_approval })),
        executed_tools: executedTools,
        memory_count: memoryCount,
      })
    }

    const assistantMessage = extractMessage(data)
    messages.push({ role: 'assistant', content: assistantMessage?.content ?? null, tool_calls: toolCalls })

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name
      const tool = availableTools.find((t) => t.key === toolName)

      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify({ success: false, error: `Tool "${toolName}" is not available to this agent.` }),
        })
        continue
      }

      const args = parseToolArguments(toolCall.function.arguments)
      console.log('Tool requested:', toolName, args)

      const { data: execution, error: executionError } = await admin
        .from('tool_executions')
        .insert({
          tool_id: tool.id,
          agent_id: agent.id,
          task_id: task.id,
          requested_by: user.id,
          status: tool.requires_approval ? 'pending' : 'running',
          input: args,
        })
        .select('*')
        .single()

      if (executionError) {
        throw new Error(`Failed to create tool execution: ${executionError.message}`)
      }

      if (tool.requires_approval) {
        await admin.from('tasks').update({
          status: 'waiting_approval',
          updated_at: new Date().toISOString(),
        }).eq('id', task.id)

        const { data: approval, error: approvalError } = await admin
          .from('approvals')
          .insert({
            tool_execution_id: execution.id,
            task_id: task.id,
            requested_by: user.id,
            status: 'pending',
            reason: `Yahalla AI requested tool "${toolName}".`,
          })
          .select('*')
          .single()

        if (approvalError || !approval) {
          await admin.from('tool_executions').update({
            status: 'failed',
            error: { message: 'Failed to create approval request.' },
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', execution.id)

          await admin.from('tasks').update({
            status: 'failed',
            error: { message: 'Failed to create approval request.' },
            updated_at: new Date().toISOString(),
          }).eq('id', task.id)

          return json({
            success: false,
            error: 'Failed to create approval request.',
            task_id: task.id,
            conversation_id: conversationId,
            tool_execution_id: execution.id,
          }, 500)
        }

        await admin.from('tool_execution_logs').insert({
          execution_id: execution.id,
          level: 'info',
          message: 'Tool execution is waiting for approval.',
          data: { tool: toolName, arguments: args },
        })

        return json({
          success: true,
          task_id: task.id,
          conversation_id: conversationId,
          status: 'waiting_approval',
          answer: `هذه العملية تحتاج موافقة قبل تنفيذ أداة ${toolName}.`,
          approval_required: true,
          tool_execution_id: execution.id,
        })
      }

      if (isDeviceScopedTool(tool)) {
        const device = await resolveOnlineDeviceForOwner(admin, user.id)

        if (!device) {
          const result = {
            success: false,
            error: `No paired device is currently online to run "${toolName}". Pair and start the Yahalla Device Agent on your computer, then try again.`,
          }

          await admin.from('tool_executions').update({
            status: 'failed',
            error: result,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', execution.id)

          executedTools.push({ tool: toolName, execution_id: execution.id, arguments: args, result })
          messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: JSON.stringify(result) })
          continue
        }

        await admin.from('tool_executions').update({
          status: 'pending',
          assigned_device: device.id,
          updated_at: new Date().toISOString(),
        }).eq('id', execution.id)

        await admin.from('tasks').update({
          status: 'waiting_device',
          assigned_device: device.id,
          checkpoint: {
            messages,
            executedTools,
            pending_tool_call_id: toolCall.id,
            pending_tool_name: toolName,
            pending_tool_execution_id: execution.id,
          },
          updated_at: new Date().toISOString(),
        }).eq('id', task.id)

        await admin.from('task_logs').insert({
          task_id: task.id,
          level: 'info',
          message: `Dispatched "${toolName}" to device "${device.name}".`,
          data: { tool: toolName, device_id: device.id },
        })

        return json({
          success: true,
          task_id: task.id,
          conversation_id: conversationId,
          status: 'waiting_device',
          answer: `تنفيذ "${toolName}" على جهازك (${device.name})...`,
          device_dispatch: true,
          device_name: device.name,
          tool_execution_id: execution.id,
        })
      }

      let result: any
      try {
        result = await executeTool(admin, tool, args, user.id)

        await admin.from('tool_executions').update({
          status: 'completed',
          output: result,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', execution.id)

        await admin.from('tool_execution_logs').insert({
          execution_id: execution.id,
          level: 'info',
          message: 'Tool executed successfully.',
          data: result,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed.'

        await admin.from('tool_executions').update({
          status: 'failed',
          error: { message: errorMessage },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', execution.id)

        await admin.from('tool_execution_logs').insert({
          execution_id: execution.id,
          level: 'error',
          message: errorMessage,
          data: { tool: toolName },
        })

        result = { success: false, error: errorMessage }
      }

      executedTools.push({ tool: toolName, execution_id: execution.id, arguments: args, result })
      messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: JSON.stringify(result) })
    }
  }

  await admin.from('tasks').update({
    status: 'failed',
    error: { message: 'Maximum tool execution rounds exceeded.' },
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', task.id)

  return json({
    success: false,
    error: 'Maximum tool execution rounds exceeded.',
    task_id: task.id,
    conversation_id: conversationId,
    executed_tools: executedTools,
  }, 502)
}

// =============================================================
// Main handler
// =============================================================

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'))
  const json = (data: unknown, status = 200) => jsonWithHeaders(data, status, corsHeaders)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const llmUrlEnv = Deno.env.get('YAHALLA_LLM_URL')
  const llmApiKey = Deno.env.get('YAHALLA_LLM_API_KEY') || undefined
  const llmTimeoutMs = (() => {
    const raw = Deno.env.get('YAHALLA_LLM_TIMEOUT_MS')
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 45000
  })()

  // ---------------------------------------------------------------------
  // Observability: /health, /ready, /v1/runtime (no auth required)
  // ---------------------------------------------------------------------
  if (req.method === 'GET') {
    const url = new URL(req.url)

    if (url.pathname.endsWith('/health')) {
      return json({ success: true, status: 'ok', service: 'yahalla-ai', time: new Date().toISOString() })
    }

    if (url.pathname.endsWith('/ready')) {
      const checks: Record<string, boolean> = {
        supabase_configured: Boolean(supabaseUrl && serviceRoleKey),
      }

      let llmReachable = false

      if (llmUrlEnv) {
        try {
          const controller = new AbortController()
          const timeoutHandle = setTimeout(() => controller.abort(), 2500)
          const probe = await fetch(llmUrlEnv, { method: 'OPTIONS', signal: controller.signal }).catch(() => null)
          clearTimeout(timeoutHandle)
          llmReachable = probe !== null
        } catch {
          llmReachable = false
        }
        checks.llm_configured = true
        checks.llm_reachable = llmReachable
      } else if (supabaseUrl && serviceRoleKey) {
        const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
        const { count } = await admin
          .from('models')
          .select('id', { count: 'exact', head: true })
          .eq('enabled', true)
          .eq('status', 'online')
        checks.llm_configured = (count ?? 0) > 0
        checks.llm_reachable = checks.llm_configured
      } else {
        checks.llm_configured = false
        checks.llm_reachable = false
      }

      const ready = checks.supabase_configured && checks.llm_configured && checks.llm_reachable

      return json({ success: ready, ready, checks }, ready ? 200 : 503)
    }

    if (url.pathname.endsWith('/runtime') || url.pathname.endsWith('/v1/runtime')) {
      if (!supabaseUrl || !serviceRoleKey) {
        return json({ success: false, error: 'Supabase server configuration is missing.' }, 500)
      }

      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

      const { data: runtimeAgent } = await admin
        .from('agents')
        .select('key,status,updated_at')
        .eq('key', 'yahalla-core')
        .maybeSingle()

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      const { data: recentTasks } = await admin
        .from('tasks')
        .select('status')
        .gte('created_at', since)
        .limit(1000)

      const statusCounts: Record<string, number> = {}
      for (const row of recentTasks ?? []) {
        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
      }

      const { count: onlineDevices } = await admin
        .from('devices')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'online')

      return json({
        success: true,
        service: 'yahalla-ai',
        time: new Date().toISOString(),
        agent: {
          key: runtimeAgent?.key ?? 'yahalla-core',
          status: runtimeAgent?.status ?? 'unknown',
          active: runtimeAgent?.status === 'active',
        },
        llm: { configured: Boolean(llmUrlEnv), env_url_set: Boolean(llmUrlEnv) },
        devices_online: onlineDevices ?? 0,
        tasks_last_24h: statusCounts,
      })
    }

    return json({ success: false, error: 'Not found' }, 404)
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  let createdTaskId: string | undefined
  let adminForRecovery: ReturnType<typeof createClient> | undefined

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ success: false, error: 'Supabase server configuration is missing.' }, 500)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    adminForRecovery = admin

    let body: RequestBody
    try {
      body = (await req.json()) as RequestBody
    } catch {
      return json({ success: false, error: 'Invalid JSON body.' }, 400)
    }

    // device_exchange is the one action a device calls before it has a
    // Supabase session of its own -- authenticated by a one-time pairing
    // code instead of a Bearer token.
    if (body.device_action === 'device_exchange') {
      return await handleDeviceExchange(admin, json, body)
    }

    const authorization = req.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) {
      return json({ success: false, error: 'Authentication required.' }, 401)
    }

    const token = authorization.replace('Bearer ', '').trim()

    const { data: { user }, error: userError } = await admin.auth.getUser(token)
    if (userError || !user) {
      return json({ success: false, error: 'Invalid authentication token.' }, 401)
    }

    if (body.device_action === 'pair_device') {
      return await handlePairDevice(admin, json, user, body)
    }

    if (body.device_action === 'device_heartbeat') {
      return await handleDeviceHeartbeat(admin, json, user, body)
    }

    if (body.device_action === 'resume_task') {
      const taskId = body.task_id
      const toolExecutionId = body.tool_execution_id

      if (!taskId || !toolExecutionId) {
        return json({ success: false, error: 'task_id and tool_execution_id are required to resume a task.' }, 400)
      }

      const { data: callingDevice } = await admin
        .from('devices')
        .select('id, owner_id')
        .eq('auth_user_id', user.id)
        .neq('status', 'revoked')
        .maybeSingle()

      if (!callingDevice) {
        return json({ success: false, error: 'This session is not a paired device.' }, 403)
      }

      const { data: task, error: taskLoadError } = await admin
        .from('tasks')
        .select('*')
        .eq('id', taskId)
        .maybeSingle()

      if (
        taskLoadError || !task ||
        task.assigned_device !== callingDevice.id ||
        task.status !== 'waiting_device'
      ) {
        return json({ success: false, error: 'Task not found, not assigned to this device, or not waiting on a device.' }, 404)
      }

      const { data: execution, error: executionLoadError } = await admin
        .from('tool_executions')
        .select('*')
        .eq('id', toolExecutionId)
        .eq('task_id', taskId)
        .eq('assigned_device', callingDevice.id)
        .maybeSingle()

      if (executionLoadError || !execution) {
        return json({ success: false, error: 'Tool execution not found.' }, 404)
      }

      if (execution.status !== 'completed' && execution.status !== 'failed') {
        return json({ success: false, error: 'Tool execution has not finished yet.' }, 409)
      }

      const resultPayload = execution.output ?? execution.error ?? { success: false, error: 'No result recorded.' }
      const checkpoint = (task.checkpoint as Record<string, any>) ?? {}

      createdTaskId = task.id

      if (checkpoint.pending_tool_call_id && checkpoint.pending_tool_execution_id === execution.id) {
        // Mid-agent-loop resume: the LLM was waiting on this tool's result
        // to continue reasoning.
        const { data: agentRow, error: agentLoadError } = await admin
          .from('agents')
          .select('id,key,name_ar,name_de,description,status,role,configuration,model_id,fallback_model_id,server_id')
          .eq('id', task.assigned_agent)
          .maybeSingle()

        if (agentLoadError || !agentRow) {
          return json({ success: false, error: 'Agent for this task no longer exists.' }, 500)
        }

        const { availableTools, permissionKeys, memoryContext, memoryCount } =
          await loadAgentToolsAndMemory(admin, agentRow.id, task.requested_by)

        const { selectedModel } = await loadModelsAndSelect(
          admin, task.model_id ?? agentRow.model_id, agentRow.fallback_model_id,
        )

        if (!selectedModel) {
          await admin.from('tasks').update({
            status: 'failed',
            assigned_device: null,
            error: { message: 'No model is currently online to resume this task.' },
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', task.id)

          return json({ success: false, error: 'No model is currently online to resume this task.', task_id: task.id }, 503)
        }

        const resolvedLLMUrl = await resolveLLMUrl(admin, llmUrlEnv, selectedModel)

        const messages = [...(checkpoint.messages ?? [])]
        messages.push({
          role: 'tool',
          tool_call_id: checkpoint.pending_tool_call_id,
          name: checkpoint.pending_tool_name,
          content: JSON.stringify(resultPayload),
        })

        const executedTools = [
          ...(checkpoint.executedTools ?? []),
          { tool: checkpoint.pending_tool_name, execution_id: execution.id, arguments: execution.input, result: resultPayload },
        ]

        await admin.from('tasks').update({
          status: 'running',
          assigned_device: null,
          checkpoint: {},
          updated_at: new Date().toISOString(),
        }).eq('id', task.id)

        return await runAgentLoop({
          admin, json, llmUrl: resolvedLLMUrl, llmApiKey, llmTimeoutMs,
          user: { id: task.requested_by }, task, agent: agentRow, selectedModel,
          availableTools, permissionKeys, memoryContext, memoryCount,
          conversationId: task.conversation_id, messages, executedTools,
        })
      }

      // No LLM checkpoint: this device dispatch came from a directly
      // approved tool call, not from mid-conversation tool routing.
      // Finalize the task the same way the non-device approval path does.
      const finished = execution.status === 'completed'

      await admin.from('tasks').update({
        status: finished ? 'completed' : 'failed',
        assigned_device: null,
        output: finished ? { tool_execution_id: execution.id, tool_result: resultPayload } : task.output,
        error: finished ? null : resultPayload,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      return json({
        success: finished,
        status: finished ? 'completed' : 'failed',
        task_id: task.id,
        tool_execution_id: execution.id,
        result: resultPayload,
      })
    }

    // -------------------------------------------------------
    // Approval action
    // -------------------------------------------------------
    if (body.approval_action && body.tool_execution_id) {
      if (body.approval_action !== 'approve' && body.approval_action !== 'reject') {
        return json({ success: false, error: 'Invalid approval action.' }, 400)
      }

      const { data: approverProfile } = await admin
        .from('profiles')
        .select('id, role')
        .eq('id', user.id)
        .maybeSingle()

      if (!approverProfile || !['owner', 'admin'].includes(approverProfile.role)) {
        return json({ success: false, error: 'Only an owner or admin can decide approvals.' }, 403)
      }

      const { data: approval, error: approvalLookupError } = await admin
        .from('approvals')
        .select('*')
        .eq('tool_execution_id', body.tool_execution_id)
        .eq('status', 'pending')
        .maybeSingle()

      if (approvalLookupError) {
        return json({ success: false, error: 'Failed to load approval.' }, 500)
      }
      if (!approval) {
        return json({ success: false, error: 'Pending approval not found.' }, 404)
      }

      const newStatus = body.approval_action === 'approve' ? 'approved' : 'rejected'

      // Compare-and-swap: if no row matched, another concurrent request
      // already decided this approval. Do not proceed to execute (or
      // re-reject) the tool a second time.
      const { data: updatedApproval, error: approvalUpdateError } = await admin
        .from('approvals')
        .update({
          status: newStatus,
          decided_by: user.id,
          decision_note: body.decision_note ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', approval.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()

      if (approvalUpdateError) {
        return json({ success: false, error: 'Failed to update approval.' }, 500)
      }
      if (!updatedApproval) {
        return json({
          success: false,
          error: 'This approval was already decided by another request.',
          task_id: approval.task_id,
          tool_execution_id: body.tool_execution_id,
        }, 409)
      }

      if (body.approval_action === 'reject') {
        await admin.from('tool_executions').update({
          status: 'failed',
          error: { message: 'Tool execution rejected by administrator.', decision_note: body.decision_note ?? null },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', body.tool_execution_id)

        await admin.from('tasks').update({
          status: 'failed',
          error: { message: 'Tool execution rejected by administrator.', decision_note: body.decision_note ?? null },
          updated_at: new Date().toISOString(),
        }).eq('id', approval.task_id)

        await admin.from('tool_execution_logs').insert({
          execution_id: body.tool_execution_id,
          level: 'info',
          message: 'Tool execution rejected by administrator.',
          data: { decided_by: user.id, decision_note: body.decision_note ?? null },
        })

        return json({ success: true, status: 'rejected', task_id: approval.task_id, tool_execution_id: body.tool_execution_id })
      }

      // Approved
      const { data: execution, error: executionLookupError } = await admin
        .from('tool_executions')
        .select('*')
        .eq('id', body.tool_execution_id)
        .maybeSingle()

      if (executionLookupError || !execution) {
        return json({ success: false, error: 'Tool execution not found.' }, 404)
      }

      const { data: tool, error: toolLookupError } = await admin
        .from('tools')
        .select('*')
        .eq('id', execution.tool_id)
        .maybeSingle()

      if (toolLookupError || !tool) {
        return json({ success: false, error: 'Tool definition not found.' }, 404)
      }

      if (isDeviceScopedTool(tool)) {
        const device = await resolveOnlineDeviceForOwner(admin, execution.requested_by)

        if (!device) {
          const errorMessage = `No paired device is currently online to run "${tool.key}". Pair and start the Yahalla Device Agent on your computer and try again.`

          await admin.from('tool_executions').update({
            status: 'failed',
            error: { message: errorMessage },
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', body.tool_execution_id)

          await admin.from('tasks').update({
            status: 'failed',
            error: { message: errorMessage },
            updated_at: new Date().toISOString(),
          }).eq('id', approval.task_id)

          return json({ success: false, error: errorMessage, task_id: approval.task_id, tool_execution_id: body.tool_execution_id }, 503)
        }

        await admin.from('tool_executions').update({
          status: 'pending',
          assigned_device: device.id,
          updated_at: new Date().toISOString(),
        }).eq('id', body.tool_execution_id)

        await admin.from('tasks').update({
          status: 'waiting_device',
          assigned_device: device.id,
          updated_at: new Date().toISOString(),
        }).eq('id', approval.task_id)

        await admin.from('tool_execution_logs').insert({
          execution_id: body.tool_execution_id,
          level: 'info',
          message: `Approved; dispatched "${tool.key}" to device "${device.name}".`,
          data: { device_id: device.id },
        })

        return json({
          success: true,
          status: 'waiting_device',
          task_id: approval.task_id,
          tool_execution_id: body.tool_execution_id,
          device_name: device.name,
        })
      }

      try {
        await admin.from('tool_executions').update({
          status: 'running',
          updated_at: new Date().toISOString(),
        }).eq('id', body.tool_execution_id)

        await admin.from('tasks').update({
          status: 'running',
          updated_at: new Date().toISOString(),
        }).eq('id', approval.task_id)

        const result = await executeTool(admin, tool, execution.input ?? {}, execution.requested_by)

        await admin.from('tool_executions').update({
          status: 'completed',
          output: result,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', body.tool_execution_id)

        await admin.from('tasks').update({
          status: 'completed',
          output: { tool_execution_id: body.tool_execution_id, tool_result: result },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', approval.task_id)

        await admin.from('tool_execution_logs').insert({
          execution_id: body.tool_execution_id,
          level: 'info',
          message: 'Approved tool executed successfully.',
          data: { result, decided_by: user.id },
        })

        return json({ success: true, status: 'completed', task_id: approval.task_id, tool_execution_id: body.tool_execution_id, result })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed.'

        await admin.from('tool_executions').update({
          status: 'failed',
          error: { message: errorMessage },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', body.tool_execution_id)

        await admin.from('tasks').update({
          status: 'failed',
          error: { message: errorMessage },
          updated_at: new Date().toISOString(),
        }).eq('id', approval.task_id)

        await admin.from('tool_execution_logs').insert({
          execution_id: body.tool_execution_id,
          level: 'error',
          message: errorMessage,
        })

        return json({ success: false, error: errorMessage, task_id: approval.task_id, tool_execution_id: body.tool_execution_id }, 500)
      }
    }

    // -------------------------------------------------------
    // Chat message
    // -------------------------------------------------------
    const message = body.message?.trim()
    if (!message) {
      return json({ success: false, error: 'Message is required.' }, 400)
    }
    if (message.length > 10000) {
      return json({ success: false, error: 'Message is too long.' }, 400)
    }

    const rateLimitWindowStart = new Date(Date.now() - 60_000).toISOString()
    const { count: recentTaskCount, error: rateLimitError } = await admin
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('requested_by', user.id)
      .gte('created_at', rateLimitWindowStart)

    if (rateLimitError) {
      console.error('Rate limit check failed:', rateLimitError)
    } else if ((recentTaskCount ?? 0) >= 12) {
      return json({ success: false, error: 'Too many requests. Please wait a moment before sending another message.' }, 429)
    }

    // Load or create conversation
    let conversationId = body.conversation_id
    if (!conversationId) {
      const { data: newConv, error: convError } = await admin
        .from('conversations')
        .insert({
          owner_id: user.id,
          project_id: body.project_id ?? null,
          title: message.slice(0, 80),
          status: 'active',
        })
        .select('id')
        .single()
      if (convError) {
        return json({ success: false, error: 'Failed to create conversation.' }, 500)
      }
      conversationId = newConv.id
    }

    await admin.from('conversation_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: message,
    })

    const agentKey = body.agent_key || 'yahalla-core'
    const { data: agent, error: agentError } = await admin
      .from('agents')
      .select('id,key,name_ar,name_de,description,status,role,configuration,model_id,fallback_model_id,server_id')
      .eq('key', agentKey)
      .eq('status', 'active')
      .maybeSingle()

    if (agentError) {
      return json({ success: false, error: 'Failed to load agent.' }, 500)
    }
    if (!agent) {
      return json({ success: false, error: `Agent "${agentKey}" is not configured or active.` }, 503)
    }

    const { selectedModel } = await loadModelsAndSelect(
      admin, body.model_id ?? agent.model_id, agent.fallback_model_id,
    )

    const { availableTools, permissionKeys, memoryContext, memoryCount } =
      await loadAgentToolsAndMemory(admin, agent.id, user.id)

    const { data: recentMessages } = await admin
      .from('conversation_messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20)

    // Create task
    const { data: task, error: taskError } = await admin
      .from('tasks')
      .insert({
        requested_by: user.id,
        assigned_agent: agent.id,
        title: message.slice(0, 120),
        description: message,
        input: { message },
        status: 'running',
        started_at: new Date().toISOString(),
        conversation_id: conversationId,
        project_id: body.project_id ?? null,
        model_id: selectedModel?.id ?? null,
      })
      .select('id')
      .single()

    if (taskError) {
      return json({ success: false, error: 'Failed to create task.', details: taskError.message }, 500)
    }

    createdTaskId = task.id

    await admin.from('audit_logs').insert({
      actor_user_id: user.id,
      agent_id: agent.id,
      task_id: task.id,
      action: 'ai.request',
      resource_type: 'task',
      resource_id: task.id,
      details: { agent: agent.key, message_length: message.length, conversation_id: conversationId },
    })

    if (!selectedModel) {
      await admin.from('tasks').update({
        status: 'failed',
        error: { message: 'No model is currently online. Start a local LLM server and update model status.' },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      // NOTE: this path (Supabase routing a chat request to a shared model
      // via servers/models or YAHALLA_LLM_URL) is the legacy/optional
      // cloud-routing path, not how Yahalla AI is meant to run normally.
      // The primary architecture is local-first: the Control Center talks
      // directly to a local Agent Runtime on the user's own device
      // (see local-runtime/), which is never reachable through this Edge
      // Function at all. This branch only still matters for someone who
      // deliberately configured a shared/hosted model here.
      const errorMsg = 'No AI model is currently online for the optional cloud-routed path. Yahalla AI normally runs the AI locally on your own device (see local-runtime/) and does not need this at all -- this error only matters if you specifically configured a shared model via servers/models or YAHALLA_LLM_URL.'

      await admin.from('conversation_messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: errorMsg,
        agent_id: agent.id,
        task_id: task.id,
        metadata: { error: true },
      })

      return json({
        success: false,
        error: errorMsg,
        task_id: task.id,
        conversation_id: conversationId,
        agent: { id: agent.id, key: agent.key, name_ar: agent.name_ar, name_de: agent.name_de, status: agent.status },
      }, 503)
    }

    const actualLLMUrl = await resolveLLMUrl(admin, llmUrlEnv, selectedModel)

    const systemPrompt = `
You are Yahalla AI Core, the central AI runtime for the Yahalla AI Operating System -- a real coding agent that reads, understands, and modifies an actual project, not a chatbot that talks about code.

Agent: ${agent.key}
Role: ${agent.role}

Evidence and verification -- these are hard rules, not suggestions:
- Never guess or invent any fact about the project (file contents, versions, config, git state, test results). Every claim about the project must come from an actual tool result you just received.
- Never invent, assume, or fabricate a tool result, a file's contents, a command's output, or a git/GitHub state. If you have not called the tool, you do not know the answer.
- If a tool call fails, times out, or a required tool is unavailable, say so plainly ("I could not verify this -- <reason>"). Do not paper over it with a plausible-sounding guess.
- Never say a task is done, fixed, or succeeded ("تم بنجاح" / "done" / "fixed") without a tool result that actually proves it. A file write is not "done" until you have read it back or diffed it; a fix is not "done" until the relevant test/build command has actually been run and passed.
- Never claim the runtime is active merely because a task was accepted or completed. Verify runtime status using yahalla.read with a query containing "runtime status".

Coding-agent workflow -- follow this loop for any request that touches the project (not just single-shot Q&A):
1. Analyze the request.
2. Inspect the project for real (list_project_files / read_project_file) before assuming a file exists or guessing its path or contents.
3. Plan the change.
4. Execute it (write_project_file / patch_project_file). old_text for patch_project_file must be copied verbatim from a read you just did -- never invented. If it does not match, re-read the file and retry; do not guess at the text.
5. Verify: read the file back or use git_diff to confirm the change actually landed as intended.
6. Test when a test/build command applies (run_project_command, e.g. "npm test", "npm run build", "tsc --noEmit") -- do not skip this step for code changes if such a command exists for the project.
7. If a test/build fails, diagnose the real error output, fix it, and re-run the same test/build. Repeat until it passes or you have a concrete, evidence-based reason it cannot pass (e.g. a missing external dependency you cannot install) -- do not stop at the first failure and do not claim success anyway.
8. Only then report the outcome, citing what you actually verified.

Git and GitHub:
- git_status/git_diff are read-only and safe to use freely to check real state before and after changes.
- git_commit, git_push, and github.write (create_repo) are sensitive and require the user's approval -- the platform enforces this automatically; just call the tool when the user asks to save/commit/push/create a repository, do not ask the user to run commands themselves, and do not fabricate a commit hash, repo URL, or push result -- report exactly what the tool returned.
- To publish a project for the first time: offer to list existing repos (github.read, operation="list_repos") or create a new one (github.write, operation="create_repo"), then git_push with the returned clone URL as remote_url. Never ask the user to paste a token or credential into chat.

General:
- Use available tools whenever they are needed to answer accurately; do not answer from memory when a tool can give a real answer.
- Respect approval requirements -- they are enforced by the platform, not optional.
- Respond in the user's language (Arabic, German, or English).
- Be concise and useful.
`.trim()

    const historyMessages: any[] = []
    if (recentMessages && recentMessages.length > 0) {
      const sorted = [...recentMessages].reverse()
      for (const msg of sorted) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          historyMessages.push({ role: msg.role, content: msg.content })
        }
      }
    }

    const baseMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages.slice(0, -1),
      { role: 'user', content: message },
    ]

    return await runAgentLoop({
      admin, json, llmUrl: actualLLMUrl, llmApiKey, llmTimeoutMs, user, task, agent, selectedModel,
      availableTools, permissionKeys, memoryContext, memoryCount, conversationId,
      messages: [...baseMessages], executedTools: [],
    })
  } catch (error) {
    console.error('Yahalla AI error:', error)

    const errorMessage = error instanceof Error ? error.message : 'Internal server error.'

    if (createdTaskId && adminForRecovery) {
      try {
        await adminForRecovery.from('tasks').update({
          status: 'failed',
          error: { message: 'Unhandled runtime error.', details: errorMessage },
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', createdTaskId)
          .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'waiting_device'])
      } catch (recoveryError) {
        console.error('Failed to mark task as failed after unhandled error:', recoveryError)
      }
    }

    return json({ success: false, error: errorMessage, task_id: createdTaskId }, 500)
  }
})
