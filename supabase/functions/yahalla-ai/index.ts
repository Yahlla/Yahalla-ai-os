import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Client-Info, Apikey',
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
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
      return 'Read a file from the project workspace. Read-only.'
    case 'write_project_file':
      return 'Write or overwrite a file in the project workspace. Requires approval.'
    case 'patch_project_file':
      return 'Apply a targeted patch to an existing file. Requires approval.'
    case 'git_status':
      return 'Show the working tree status. Read-only.'
    case 'git_diff':
      return 'Show unstaged or staged changes. Read-only.'
    case 'run_project_command':
      return 'Run a safe shell command (build, lint, test, typecheck). Requires approval.'
    case 'web.search':
      return 'Search publicly available web information.'
    case 'github.read':
      return 'Read authorized GitHub repository information. Read-only.'
    case 'github.write':
      return 'Modify authorized GitHub repository content. Requires approval.'
    case 'email.send':
      return 'Send an email. Requires approval.'
    case 'yahalla.api':
      return 'Perform an authorized Yahalla API operation. Requires approval.'
    default:
      return `Execute the authorized ${key} tool.`
  }
}

function buildOpenAITool(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.key,
      description: toolDescription(tool.key),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The requested query or operation.',
          },
        },
        required: ['query'],
        additionalProperties: true,
      },
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

async function callLLM(
  llmUrl: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(llmUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
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

  return { response, data, rawText }
}

// =============================================================
// Tool executors
// =============================================================

async function executeYahallaRead(
  admin: ReturnType<typeof createClient>,
  args: Record<string, unknown>,
  userId: string,
) {
  const query =
    typeof args.query === 'string' ? args.query.toLowerCase() : ''

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
      .in('status', ['pending', 'queued', 'running', 'waiting_approval'])
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
      .in('status', ['pending', 'queued', 'running', 'waiting_approval'])
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
      return {
        success: false,
        operation: 'github.read',
        message: 'github.read is registered but its GitHub adapter is not connected yet.',
      }

    case 'read_project_file':
    case 'write_project_file':
    case 'patch_project_file':
    case 'git_status':
    case 'git_diff':
    case 'run_project_command':
      return {
        success: false,
        operation: tool.key,
        message: `${tool.key} is registered but requires a local agent runtime (127.0.0.1:8787) to execute. Connect the runtime to enable file and command operations.`,
      }

    default:
      return {
        success: false,
        operation: tool.key,
        message: `The tool "${tool.key}" does not have an executor registered yet.`,
      }
  }
}

// =============================================================
// Main handler
// =============================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const llmUrl = Deno.env.get('YAHALLA_LLM_URL')

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ success: false, error: 'Supabase server configuration is missing.' }, 500)
    }

    const authorization = req.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) {
      return json({ success: false, error: 'Authentication required.' }, 401)
    }

    const token = authorization.replace('Bearer ', '').trim()

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: { user }, error: userError } = await admin.auth.getUser(token)
    if (userError || !user) {
      return json({ success: false, error: 'Invalid authentication token.' }, 401)
    }

    const body = (await req.json()) as RequestBody

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
      const { error: approvalUpdateError } = await admin
        .from('approvals')
        .update({
          status: newStatus,
          decided_by: user.id,
          decision_note: body.decision_note ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', approval.id)
        .eq('status', 'pending')

      if (approvalUpdateError) {
        return json({ success: false, error: 'Failed to update approval.' }, 500)
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

    // Load profile
    const { data: profile } = await admin
      .from('profiles')
      .select('id, role, email, full_name')
      .eq('id', user.id)
      .maybeSingle()

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

    // Store user message
    await admin.from('conversation_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: message,
    })

    // Load agent (default: yahalla-core, or specified)
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

    // Load all models for routing
    const { data: allModels } = await admin
      .from('models')
      .select('id,key,name,provider,type,endpoint,status,priority,enabled,is_local,configuration,server_id')
      .order('priority', { ascending: false })

    const modelsList: ModelRow[] = (allModels ?? []).map((m: any) => ({
      id: m.id, key: m.key, name: m.name, provider: m.provider, type: m.type,
      endpoint: m.endpoint, status: m.status, priority: m.priority, enabled: m.enabled,
      is_local: m.is_local, configuration: m.configuration ?? {}, server_id: m.server_id,
    }))

    // Select model
    const selectedModel = selectModelWithFallback(
      modelsList,
      body.model_id ?? agent.model_id,
      agent.fallback_model_id,
      'general',
    )

    // Load agent permissions
    const { data: permissions, error: permissionsError } = await admin
      .from('agent_permissions')
      .select('permission_id, permissions (id, key)')
      .eq('agent_id', agent.id)

    if (permissionsError) {
      return json({ success: false, error: 'Failed to load agent permissions.' }, 500)
    }

    // Load enabled tools
    const { data: toolRows, error: toolsError } = await admin
      .from('agent_tools')
      .select('enabled, tool_id, tools (id, key, category, status, requires_approval, configuration)')
      .eq('agent_id', agent.id)
      .eq('enabled', true)

    if (toolsError) {
      return json({ success: false, error: 'Failed to load agent tools.' }, 500)
    }

    const availableTools: ToolDefinition[] = (toolRows ?? [])
      .map((item: any) => {
        const tool = item.tools
        if (!tool || tool.status !== 'active') return null
        return {
          id: tool.id, key: tool.key, category: tool.category,
          requires_approval: Boolean(tool.requires_approval),
          configuration: tool.configuration ?? {},
        }
      })
      .filter(Boolean)

    const permissionKeys = (permissions ?? [])
      .map((item: any) => item.permissions?.key)
      .filter(Boolean)

    // Load memory
    const { data: memories } = await admin
      .from('ai_memory')
      .select('*')
      .or(`scope.eq.global,owner_id.eq.${user.id}`)
      .order('importance', { ascending: false })
      .limit(20)

    // Load recent conversation messages for context
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

    // Audit log
    await admin.from('audit_logs').insert({
      actor_user_id: user.id,
      agent_id: agent.id,
      task_id: task.id,
      action: 'ai.request',
      resource_type: 'task',
      resource_id: task.id,
      details: { agent: agent.key, message_length: message.length, conversation_id: conversationId },
    })

    // If no model is online, return a clear error
    if (!selectedModel) {
      await admin.from('tasks').update({
        status: 'failed',
        error: { message: 'No model is currently online. Start a local LLM server and update model status.' },
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)

      const errorMsg = 'No AI model is currently online. The platform requires at least one enabled model with status "online". Start a local LLM server (e.g. on 127.0.0.1:8080) and update the model status in the admin control center.'

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

    // Load server for the selected model
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

    const actualLLMUrl = llmUrl || buildLLMUrl(selectedModel, serverHostname, serverPort)

    const memoryContext = (memories ?? []).map((m: any) => ({
      key: m.memory_key, content: m.content, importance: m.importance,
    }))

    const llmTools = availableTools.map(buildOpenAITool)

    const systemPrompt = `
You are Yahalla AI Core, the central AI runtime for the Yahalla AI Operating System.

Agent: ${agent.key}
Role: ${agent.role}

Your responsibilities:
- Understand the user's request
- Use available tools when necessary
- Never invent tool results
- Never claim an action happened unless a tool actually executed it
- Respect approval requirements
- Respond in the user's language (Arabic, German, or English)
- Be concise and useful

Runtime rules:
- For questions about Yahalla Core Runtime, runtime state, or runtime health, use yahalla.read with a query containing "runtime status".
- Do not use web.search for internal Yahalla system/runtime state.
- Never claim the runtime is active merely because a task was accepted or completed. Verify runtime status using yahalla.read.
- For coding tasks, use read_project_file, write_project_file, patch_project_file, and run_project_command.
- Always read a file before patching it.
- After modifications, verify the result.
`.trim()

    // Build conversation messages (reverse chronological -> chronological)
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
      ...historyMessages.slice(0, -1), // exclude the last user message (we'll add it fresh)
      { role: 'user', content: message },
    ]

    const maxToolRounds = 5
    let llmMessages = [...baseMessages]
    let finalLLMData: any = null
    const executedTools: any[] = []

    for (let round = 0; round < maxToolRounds; round++) {
      const llmPayload = {
        model: selectedModel.key,
        messages: llmMessages,
        user_id: user.id,
        task_id: task.id,
        agent: { key: agent.key, configuration: agent.configuration },
        permissions: permissionKeys,
        tools: llmTools,
        memory: memoryContext,
      }

      console.log(`Calling Yahalla LLM round ${round + 1} with model ${selectedModel.key}`)

      const { response, data, rawText } = await callLLM(actualLLMUrl, llmPayload)
      finalLLMData = data

      if (!response.ok) {
        await admin.from('tasks').update({
          status: 'failed',
          error: { message: 'LLM request failed.', status: response.status, response: rawText.slice(0, 4000) },
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

        // Store assistant message
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

        // Store memory
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
          memory_count: memories?.length ?? 0,
        })
      }

      // Process tool calls
      const assistantMessage = extractMessage(data)
      llmMessages.push({
        role: 'assistant',
        content: assistantMessage?.content ?? null,
        tool_calls: toolCalls,
      })

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name
        const tool = availableTools.find((t) => t.key === toolName)

        if (!tool) {
          llmMessages.push({
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

        executedTools.push({
          tool: toolName,
          execution_id: execution.id,
          arguments: args,
          result,
        })

        llmMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(result),
        })
      }
    }

    // Max rounds exceeded
    await admin.from('tasks').update({
      status: 'failed',
      error: { message: 'Maximum tool execution rounds exceeded.' },
      updated_at: new Date().toISOString(),
    }).eq('id', task.id)

    return json({
      success: false,
      error: 'Maximum tool execution rounds exceeded.',
      task_id: task.id,
      conversation_id: conversationId,
      executed_tools: executedTools,
    }, 502)
  } catch (error) {
    console.error('Yahalla AI error:', error)
    return json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error.',
    }, 500)
  }
})
