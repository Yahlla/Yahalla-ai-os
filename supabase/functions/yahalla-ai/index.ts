import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
type RequestBody = {
  message?: string
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

  if (data.choices?.[0]?.message) {
    return data.choices[0].message
  }

  if (data.message) {
    return data.message
  }

  return null
}

function extractText(data: any): string {
  if (!data) return ''

  if (typeof data === 'string') return data

  if (typeof data.output === 'string') return data.output

  if (typeof data.response === 'string') return data.response

  if (typeof data.message === 'string') return data.message

  if (typeof data.message?.content === 'string') {
    return data.message.content
  }

  if (typeof data.choices?.[0]?.message?.content === 'string') {
    return data.choices[0].message.content
  }

  if (typeof data.choices?.[0]?.text === 'string') {
    return data.choices[0].text
  }

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

  if (!Array.isArray(message.tool_calls)) {
    return []
  }

  return message.tool_calls.filter(
    (call: any) =>
      call?.type === 'function' &&
      call?.function?.name,
  )
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {}

  if (typeof value === 'object') {
    return value as Record<string, unknown>
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)

      if (parsed && typeof parsed === 'object') {
        return parsed
      }
    } catch {
      return {
        raw: value,
      }
    }
  }

  return {}
}

function toolDescription(key: string): string {
  switch (key) {
    case 'yahalla.read':
      return 'Read authorized Yahalla data. Read-only operation.'
    case 'github.read':
      return 'Read authorized GitHub repository information. Read-only operation.'
    case 'web.search':
      return 'Search publicly available web information.'
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
    contentType: response.headers.get('content-type'),
    responseBody: rawText.slice(0, 2000),
  }))

  let data: any

  try {
    data = JSON.parse(rawText)
  } catch {
    data = rawText
  }

  return {
    response,
    data,
    rawText,
  }
}

async function executeYahallaRead(
  admin: ReturnType<typeof createClient>,
  args: Record<string, unknown>,
  userId: string,
) {
  const query =
    typeof args.query === 'string'
      ? args.query.toLowerCase()
      : ''

  /*
   * Safe read-only Yahalla router.
   *
   * IMPORTANT:
   * This does not expose arbitrary SQL.
   * Only approved read operations are implemented.
   */

  if (
    query.includes('open task') ||
    query.includes('offene aufgaben') ||
    query.includes('pending task') ||
    query.includes('tasks')
  ) {
    const { data, error } = await admin
      .from('tasks')
      .select(
        'id,title,description,status,priority,created_at,updated_at',
      )
      .eq('requested_by', userId)
      .in('status', [
        'pending',
        'queued',
        'running',
        'waiting_approval',
      ])
      .order('created_at', {
        ascending: false,
      })
      .limit(25)

    if (error) {
      throw new Error(
        `Failed to read Yahalla tasks: ${error.message}`,
      )
    }

    return {
      success: true,
      operation: 'tasks.list_open',
      count: data?.length ?? 0,
      rows: data ?? [],
    }
  }

  if (
    query.includes('agent') ||
    query.includes('agents')
  ) {
    const { data, error } = await admin
      .from('agents')
      .select(
        'id,key,name_ar,name_de,description,status,configuration',
      )
      .order('created_at', {
        ascending: false,
      })
      .limit(25)

    if (error) {
      throw new Error(
        `Failed to read Yahalla agents: ${error.message}`,
      )
    }

    return {
      success: true,
      operation: 'agents.list',
      count: data?.length ?? 0,
      rows: data ?? [],
    }
  }

  if (
    query.includes('tool') ||
    query.includes('tools')
  ) {
    const { data, error } = await admin
      .from('tools')
      .select(
        'id,key,name_ar,name_de,category,status,requires_approval,configuration',
      )
      .order('key', {
        ascending: true,
      })

    if (error) {
      throw new Error(
        `Failed to read Yahalla tools: ${error.message}`,
      )
    }

    return {
      success: true,
      operation: 'tools.list',
      count: data?.length ?? 0,
      rows: data ?? [],
    }
  }

  if (
    query.includes('runtime') ||
    query.includes('core runtime') ||
    query.includes('yahalla core runtime') ||
    query.includes('runtime state') ||
    query.includes('حالة runtime') ||
    query.includes('حالة الـruntime') ||
    query.includes('حالة الruntime')
  ) {
    const { data: runtimeAgent, error: runtimeError } = await admin
      .from('agents')
      .select('id,key,name_ar,name_de,description,status,configuration')
      .eq('key', 'yahalla-core')
      .maybeSingle()

    if (runtimeError) {
      throw new Error(
        `Failed to read Yahalla Core Runtime: ${runtimeError.message}`,
      )
    }

    const { data: openTasks, error: openTasksError } = await admin
      .from('tasks')
      .select('id,title,status,priority,created_at,updated_at')
      .eq('assigned_agent', runtimeAgent?.id ?? '')
      .in('status', [
        'pending',
        'queued',
        'running',
        'waiting_approval',
      ])
      .order('created_at', {
        ascending: false,
      })
      .limit(25)

    if (openTasksError) {
      throw new Error(
        `Failed to read Yahalla Core Runtime tasks: ${openTasksError.message}`,
      )
    }

    const { data: recentExecutions, error: executionsError } = await admin
      .from('tool_executions')
      .select('id,tool_id,agent_id,task_id,status,created_at,completed_at,error')
      .eq('agent_id', runtimeAgent?.id ?? '')
      .order('created_at', {
        ascending: false,
      })
      .limit(25)

    if (executionsError) {
      throw new Error(
        `Failed to read Yahalla Core Runtime executions: ${executionsError.message}`,
      )
    }

    return {
      success: true,
      operation: 'runtime.status',
      runtime: {
        agent_key: runtimeAgent?.key ?? 'yahalla-core',
        status: runtimeAgent?.status ?? 'unknown',
        configured: Boolean(runtimeAgent),
        active: Boolean(
          runtimeAgent &&
          runtimeAgent.status === 'active'
        ),
      },
      open_tasks: {
        count: openTasks?.length ?? 0,
        rows: openTasks ?? [],
      },
      recent_executions: {
        count: recentExecutions?.length ?? 0,
        rows: recentExecutions ?? [],
      },
      message: runtimeAgent?.status === 'active'
        ? 'Yahalla Core Runtime is active.'
        : 'Yahalla Core Runtime is not active.',
    }
  }

  if (
    query.includes('memory') ||
    query.includes('memories')
  ) {
    const { data, error } = await admin
      .from('ai_memory')
      .select(
        'id,scope,memory_key,content,importance,created_at,updated_at',
      )
      .or(`scope.eq.global,owner_id.eq.${userId}`)
      .order('importance', {
        ascending: false,
      })
      .limit(25)

    if (error) {
      throw new Error(
        `Failed to read Yahalla memory: ${error.message}`,
      )
    }

    return {
      success: true,
      operation: 'memory.list',
      count: data?.length ?? 0,
      rows: data ?? [],
    }
  }

  return {
    success: false,
    operation: 'unsupported',
    message:
      'The requested Yahalla read operation is not currently implemented.',
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
      return executeYahallaRead(
        admin,
        args,
        userId,
      )

    case 'web.search':
      return {
        success: false,
        operation: 'web.search',
        message:
          'web.search is registered but its external search adapter is not connected yet.',
      }

    case 'github.read':
      return {
        success: false,
        operation: 'github.read',
        message:
          'github.read is registered but its GitHub adapter is not connected yet.',
      }

    default:
      return {
        success: false,
        operation: tool.key,
        message:
          `The tool "${tool.key}" does not have an executor registered yet.`,
      }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders,
    })
  }

  if (req.method !== 'POST') {
    return json(
      {
        success: false,
        error: 'Method not allowed',
      },
      405,
    )
  }

  try {
    const supabaseUrl =
      Deno.env.get('SUPABASE_URL')

    const serviceRoleKey =
      Deno.env.get(
        'SUPABASE_SERVICE_ROLE_KEY',
      )

    const llmUrl =
      Deno.env.get('YAHALLA_LLM_URL')

    if (!supabaseUrl || !serviceRoleKey) {
      return json(
        {
          success: false,
          error:
            'Supabase server configuration is missing.',
        },
        500,
      )
    }

    if (!llmUrl) {
      return json(
        {
          success: false,
          error:
            'YAHALLA_LLM_URL is not configured.',
        },
        500,
      )
    }

    const authorization =
      req.headers.get('Authorization')

    if (
      !authorization?.startsWith(
        'Bearer ',
      )
    ) {
      return json(
        {
          success: false,
          error:
            'Authentication required.',
        },
        401,
      )
    }

    const token =
      authorization
        .replace('Bearer ', '')
        .trim()

    const admin = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )

    const {
      data: { user },
      error: userError,
    } =
      await admin.auth.getUser(token)

    if (userError || !user) {
  return json(
    {
      success: false,
      error:
        'Invalid authentication token.',
    },
    401,
  )
}

const body =
  (await req.json()) as RequestBody

// -------------------------------------------------------
// Approval action
// -------------------------------------------------------
if (
  body.approval_action &&
  body.tool_execution_id
) {
  if (
    body.approval_action !== 'approve' &&
    body.approval_action !== 'reject'
  ) {
    return json(
      {
        success: false,
        error: 'Invalid approval action.',
      },
      400,
    )
  }

  // Only owner/admin may decide approvals.
  const { data: approverProfile } =
    await admin
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .maybeSingle()

  if (
    !approverProfile ||
    !['owner', 'admin'].includes(
      approverProfile.role,
    )
  ) {
    return json(
      {
        success: false,
        error:
          'Only an owner or admin can decide approvals.',
      },
      403,
    )
  }

  const {
    data: approval,
    error: approvalLookupError,
  } = await admin
    .from('approvals')
    .select('*')
    .eq(
      'tool_execution_id',
      body.tool_execution_id,
    )
    .eq('status', 'pending')
    .maybeSingle()

  if (approvalLookupError) {
    console.error(
      'Approval lookup failed:',
      approvalLookupError,
    )

    return json(
      {
        success: false,
        error:
          'Failed to load approval.',
      },
      500,
    )
  }

  if (!approval) {
    return json(
      {
        success: false,
        error:
          'Pending approval not found.',
      },
      404,
    )
  }

  const newStatus =
    body.approval_action === 'approve'
      ? 'approved'
      : 'rejected'

  const { error: approvalUpdateError } =
    await admin
      .from('approvals')
      .update({
        status: newStatus,
        decided_by: user.id,
        decision_note:
          body.decision_note ?? null,
        decided_at:
          new Date().toISOString(),
      })
      .eq('id', approval.id)
      .eq('status', 'pending')

  if (approvalUpdateError) {
    console.error(
      'Approval update failed:',
      approvalUpdateError,
    )

    return json(
      {
        success: false,
        error:
          'Failed to update approval.',
      },
      500,
    )
  }

  // -----------------------------------------------------
  // Rejected
  // -----------------------------------------------------
  if (
    body.approval_action === 'reject'
  ) {
    await admin
      .from('tool_executions')
      .update({
        status: 'failed',
        error: {
          message:
            'Tool execution rejected by administrator.',
          decision_note:
            body.decision_note ?? null,
        },
        completed_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        body.tool_execution_id,
      )

    await admin
      .from('tasks')
      .update({
        status: 'failed',
        error: {
          message:
            'Tool execution rejected by administrator.',
          decision_note:
            body.decision_note ?? null,
        },
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        approval.task_id,
      )

    await admin
      .from('tool_execution_logs')
      .insert({
        execution_id:
          body.tool_execution_id,
        level: 'info',
        message:
          'Tool execution rejected by administrator.',
        data: {
          decided_by: user.id,
          decision_note:
            body.decision_note ?? null,
        },
      })

    return json({
      success: true,
      status: 'rejected',
      task_id: approval.task_id,
      tool_execution_id:
        body.tool_execution_id,
    })
  }

  // -----------------------------------------------------
  // Approved: load execution + tool
  // -----------------------------------------------------
  const {
    data: execution,
    error: executionLookupError,
  } = await admin
    .from('tool_executions')
    .select('*')
    .eq(
      'id',
      body.tool_execution_id,
    )
    .maybeSingle()

  if (
    executionLookupError ||
    !execution
  ) {
    return json(
      {
        success: false,
        error:
          'Tool execution not found.',
      },
      404,
    )
  }

  const {
    data: tool,
    error: toolLookupError,
  } = await admin
    .from('tools')
    .select('*')
    .eq('id', execution.tool_id)
    .maybeSingle()

  if (toolLookupError || !tool) {
    return json(
      {
        success: false,
        error:
          'Tool definition not found.',
      },
      404,
    )
  }

  try {
    await admin
      .from('tool_executions')
      .update({
        status: 'running',
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        body.tool_execution_id,
      )

    await admin
      .from('tasks')
      .update({
        status: 'running',
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        approval.task_id,
      )

    const result =
      await executeTool(
        admin,
        tool,
        execution.input ?? {},
        execution.requested_by,
      )

    await admin
      .from('tool_executions')
      .update({
        status: 'completed',
        output: result,
        completed_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        body.tool_execution_id,
      )

    await admin
      .from('tasks')
      .update({
        status: 'completed',
        output: {
          tool_execution_id:
            body.tool_execution_id,
          tool_result: result,
        },
        completed_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        approval.task_id,
      )

    await admin
      .from('tool_execution_logs')
      .insert({
        execution_id:
          body.tool_execution_id,
        level: 'info',
        message:
          'Approved tool executed successfully.',
        data: {
          result,
          decided_by: user.id,
        },
      })

    return json({
      success: true,
      status: 'completed',
      task_id: approval.task_id,
      tool_execution_id:
        body.tool_execution_id,
      result,
    })
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Tool execution failed.'

    await admin
      .from('tool_executions')
      .update({
        status: 'failed',
        error: {
          message: errorMessage,
        },
        completed_at:
          new Date().toISOString(),
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        body.tool_execution_id,
      )

    await admin
      .from('tasks')
      .update({
        status: 'failed',
        error: {
          message: errorMessage,
        },
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        approval.task_id,
      )

    await admin
      .from('tool_execution_logs')
      .insert({
        execution_id:
          body.tool_execution_id,
        level: 'error',
        message:
          errorMessage,
      })

    return json(
      {
        success: false,
        error: errorMessage,
        task_id: approval.task_id,
        tool_execution_id:
          body.tool_execution_id,
      },
      500,
    )
  }
}

const message =
  body.message?.trim()

if (!message) {
  return json(
    {
      success: false,
      error:
        'Message is required.',
    },
    400,
  )
}

if (message.length > 10000) {
  return json(
    {
      success: false,
      error:
        'Message is too long.',
    },
    400,
  )
}

    const { data: profile } =
      await admin
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle()

    const {
      data: agent,
      error: agentError,
    } = await admin
      .from('agents')
      .select(
        'id,key,name_ar,name_de,description,status,configuration',
      )
      .eq('key', 'yahalla-core')
      .eq('status', 'active')
      .maybeSingle()

    if (agentError) {
      console.error(
        'Agent lookup failed:',
        agentError,
      )

      return json(
        {
          success: false,
          error:
            'Failed to load Yahalla Core.',
        },
        500,
      )
    }

    if (!agent) {
      return json(
        {
          success: false,
          error:
            'Yahalla Core agent is not configured.',
        },
        503,
      )
    }

    const {
      data: permissions,
      error: permissionsError,
    } = await admin
      .from('agent_permissions')
      .select(`
        permission_id,
        permissions (
          id,
          key
        )
      `)
      .eq('agent_id', agent.id)

    if (permissionsError) {
      return json(
        {
          success: false,
          error:
            'Failed to load agent permissions.',
        },
        500,
      )
    }

    const {
      data: toolRows,
      error: toolsError,
    } = await admin
      .from('agent_tools')
      .select(`
        enabled,
        tool_id,
        tools (
          id,
          key,
          category,
          status,
          requires_approval,
          configuration
        )
      `)
      .eq('agent_id', agent.id)
      .eq('enabled', true)

    if (toolsError) {
      return json(
        {
          success: false,
          error:
            'Failed to load agent tools.',
        },
        500,
      )
    }

    const availableTools: ToolDefinition[] =
      (toolRows ?? [])
        .map((item: any) => {
          const tool = item.tools

          if (!tool) return null

          if (tool.status !== 'active') {
            return null
          }

          return {
            id: tool.id,
            key: tool.key,
            category: tool.category,
            requires_approval:
              Boolean(
                tool.requires_approval,
              ),
            configuration:
              tool.configuration ?? {},
          }
        })
        .filter(Boolean)

    const permissionKeys =
      (permissions ?? [])
        .map(
          (item: any) =>
            item.permissions?.key,
        )
        .filter(Boolean)

    const {
      data: memories,
    } = await admin
      .from('ai_memory')
      .select('*')
      .or(
        `scope.eq.global,owner_id.eq.${user.id}`,
      )
      .order('importance', {
        ascending: false,
      })
      .limit(20)

    const {
      data: task,
      error: taskError,
    } = await admin
      .from('tasks')
      .insert({
        requested_by: user.id,
        assigned_agent: agent.id,
        title: message.slice(0, 120),
        description: message,
        input: {
          message,
        },
        status: 'running',
        started_at:
          new Date().toISOString(),
      })
      .select('*')
      .single()

    if (taskError) {
      return json(
        {
          success: false,
          error:
            'Failed to create task.',
          details:
            taskError.message,
        },
        500,
      )
    }

    await admin
      .from('audit_logs')
      .insert({
        actor_id: user.id,
        action: 'ai.request',
        entity_type: 'task',
        entity_id: task.id,
        metadata: {
          agent: agent.key,
          message_length:
            message.length,
        },
      })

    const memoryContext =
      (memories ?? []).map(
        (memory: any) => ({
          key: memory.memory_key,
          content: memory.content,
          importance:
            memory.importance,
        }),
      )

    const llmTools =
      availableTools.map(
        buildOpenAITool,
      )

    const systemPrompt = `
You are Yahalla AI Core.

You are the central AI runtime for Yahalla.

Agent: ${agent.key}

Your responsibilities:
- understand the user's request
- use available tools when necessary
- never invent tool results
- never claim an action happened unless a tool actually executed it
- respect approval requirements
- respond in the user's language
- be concise and useful

Runtime rule:
For questions about Yahalla Core Runtime, runtime state, whether Yahalla Core is active/running, or runtime health, use yahalla.read with a query containing "runtime status".

Do not use web.search for internal Yahalla system/runtime state.

Never claim the runtime is active merely because a task was accepted or completed. Verify runtime status using yahalla.read.
`.trim()

    const baseMessages: any[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: message,
      },
    ]

    const maxToolRounds = 5

    let messages = [
      ...baseMessages,
    ]

    let finalLLMData: any = null
    const executedTools: any[] = []

    for (
      let round = 0;
      round < maxToolRounds;
      round++
    ) {
      const llmPayload = {
        model: 'yahalla-core',
        messages,
        user_id: user.id,
        task_id: task.id,
        agent: {
          key: agent.key,
          configuration:
            agent.configuration,
        },
        permissions:
          permissionKeys,
        tools: llmTools,
        memory: memoryContext,
      }

      console.log(
        `Calling Yahalla LLM round ${round + 1}`,
      )

      const {
        response,
        data,
        rawText,
      } = await callLLM(
        llmUrl,
        llmPayload,
      )

      finalLLMData = data

      if (!response.ok) {
        await admin
          .from('tasks')
          .update({
            status: 'failed',
            error: {
              message:
                'LLM request failed.',
              status:
                response.status,
              response:
                rawText.slice(0, 4000),
            },
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            'id',
            task.id,
          )

        return json(
          {
            success: false,
            error:
              'Yahalla LLM request failed.',
            task_id: task.id,
            llm_status:
              response.status,
            details:
              rawText.slice(0, 4000),
          },
          502,
        )
      }

      const toolCalls =
        extractToolCalls(data)

      if (!toolCalls.length) {
        const answer =
          extractText(data)

        if (!answer) {
          await admin
            .from('tasks')
            .update({
              status: 'failed',
              error: {
                message:
                  'LLM returned no usable answer.',
                response: data,
              },
              updated_at:
                new Date().toISOString(),
            })
            .eq(
              'id',
              task.id,
            )

          return json(
            {
              success: false,
              error:
                'LLM returned no usable answer.',
              task_id: task.id,
              raw_response: data,
            },
            502,
          )
        }

        await admin
          .from('tasks')
          .update({
            status: 'completed',
            output: {
              answer,
              provider_response:
                finalLLMData,
              executed_tools:
                executedTools,
            },
            completed_at:
              new Date().toISOString(),
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            'id',
            task.id,
          )

        await admin
          .from('ai_memory')
          .insert({
            scope: 'user',
            owner_id: user.id,
            agent_id: agent.id,
            task_id: task.id,
            memory_key:
              `conversation:${task.id}`,
            content:
              `User: ${message}\nYahalla: ${answer}`,
            metadata: {
              type: 'conversation',
              tools:
                executedTools.map(
                  (item) =>
                    item.tool,
                ),
            },
            importance: 30,
          })

        return json({
          success: true,
          task_id: task.id,
          status: 'completed',
          answer,
          agent: {
            id: agent.id,
            key: agent.key,
            name_ar:
              agent.name_ar,
            name_de:
              agent.name_de,
            status:
              agent.status,
          },
          permissions:
            permissionKeys,
          tools:
            availableTools.map(
              (tool) => ({
                key: tool.key,
                category:
                  tool.category,
                requires_approval:
                  tool.requires_approval,
              }),
            ),
          executed_tools:
            executedTools,
          memory_count:
            memories?.length ?? 0,
        })
      }

      const assistantMessage =
        extractMessage(data)

      messages.push({
        role: 'assistant',
        content:
          assistantMessage?.content ??
          null,
        tool_calls:
          toolCalls,
      })

      for (const toolCall of toolCalls) {
        const toolName =
          toolCall.function.name

        const tool =
          availableTools.find(
            (item) =>
              item.key ===
              toolName,
          )

        if (!tool) {
          messages.push({
            role: 'tool',
            tool_call_id:
              toolCall.id,
            name: toolName,
            content: JSON.stringify({
              success: false,
              error:
                `Tool "${toolName}" is not available to this agent.`,
            }),
          })

          continue
        }

        const args =
          parseToolArguments(
            toolCall.function
              .arguments,
          )

        console.log(
          'Tool requested:',
          toolName,
          args,
        )

        const {
          data: execution,
          error:
            executionError,
        } = await admin
          .from(
            'tool_executions',
          )
          .insert({
            tool_id: tool.id,
            agent_id:
              agent.id,
            task_id: task.id,
            requested_by:
              user.id,
            status:
              tool.requires_approval
                ? 'pending'
                : 'running',
            input: args,
          })
          .select('*')
          .single()

        if (executionError) {
          throw new Error(
            `Failed to create tool execution: ${executionError.message}`,
          )
        }

        if (
          tool.requires_approval
        ) {
          await admin
            .from('tasks')
            .update({
              status:
                'waiting_approval',
              updated_at:
                new Date().toISOString(),
            })
            .eq(
              'id',
              task.id,
            )

          const {
            data: approval,
            error: approvalError,
          } = await admin
            .from('approvals')
            .insert({
              tool_execution_id:
                execution.id,
              task_id:
                task.id,
              requested_by:
                user.id,
              status:
                'pending',
              reason:
                `Yahalla AI requested tool "${toolName}".`,
            })
            .select('*')
            .single()

          if (approvalError || !approval) {
            console.error(
              'Approval creation failed:',
              approvalError,
            )

            await admin
              .from('tool_executions')
              .update({
                status: 'failed',
                error: {
                  message:
                    'Failed to create approval request.',
                  details:
                    approvalError?.message ??
                    'Approval row was not created.',
                  code:
                    approvalError?.code ?? null,
                  details_raw:
                    approvalError?.details ?? null,
                  hint:
                    approvalError?.hint ?? null,
                },
                completed_at:
                  new Date().toISOString(),
                updated_at:
                  new Date().toISOString(),
              })
              .eq(
                'id',
                execution.id,
              )

            await admin
              .from('tasks')
              .update({
                status: 'failed',
                error: {
                  message:
                    'Failed to create approval request.',
                  details:
                    approvalError?.message ??
                    'Approval row was not created.',
                  code:
                    approvalError?.code ?? null,
                  details_raw:
                    approvalError?.details ?? null,
                  hint:
                    approvalError?.hint ?? null,
                },
                updated_at:
                  new Date().toISOString(),
              })
              .eq(
                'id',
                task.id,
              )

            return json(
              {
                success: false,
                error:
                  'Failed to create approval request.',
                task_id:
                  task.id,
                tool_execution_id:
                  execution.id,
                approval_error:
                  approvalError?.message ??
                  'Approval row was not created.',
              },
              500,
            )
          }

          console.log(
            'Approval created:',
            approval.id,
          )

          await admin
            .from(
              'tool_execution_logs',
            )
            .insert({
              execution_id:
                execution.id,
              level: 'info',
              message:
                'Tool execution is waiting for approval.',
              data: {
                tool:
                  toolName,
                arguments:
                  args,
              },
            })

          return json({
            success: true,
            task_id: task.id,
            status:
              'waiting_approval',
            answer:
              `هذه العملية تحتاج موافقة قبل تنفيذ أداة ${toolName}.`,
            approval_required:
              true,
            tool_execution_id:
              execution.id,
          })
        }

        let result: any

        try {
          result =
            await executeTool(
              admin,
              tool,
              args,
              user.id,
            )

          await admin
            .from(
              'tool_executions',
            )
            .update({
              status:
                'completed',
              output:
                result,
              completed_at:
                new Date().toISOString(),
              updated_at:
                new Date().toISOString(),
            })
            .eq(
              'id',
              execution.id,
            )

          await admin
            .from(
              'tool_execution_logs',
            )
            .insert({
              execution_id:
                execution.id,
              level: 'info',
              message:
                'Tool executed successfully.',
              data: result,
            })
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : 'Tool execution failed.'

          await admin
            .from(
              'tool_executions',
            )
            .update({
              status:
                'failed',
              error: {
                message:
                  errorMessage,
              },
              completed_at:
                new Date().toISOString(),
              updated_at:
                new Date().toISOString(),
            })
            .eq(
              'id',
              execution.id,
            )

          await admin
            .from(
              'tool_execution_logs',
            )
            .insert({
              execution_id:
                execution.id,
              level: 'error',
              message:
                errorMessage,
              data: {
                tool:
                  toolName,
              },
            })

          result = {
            success: false,
            error:
              errorMessage,
          }
        }

        executedTools.push({
          tool:
            toolName,
          execution_id:
            execution.id,
          arguments:
            args,
          result,
        })

        messages.push({
          role: 'tool',
          tool_call_id:
            toolCall.id,
          name: toolName,
          content:
            JSON.stringify(result),
        })
      }
    }

    await admin
      .from('tasks')
      .update({
        status: 'failed',
        error: {
          message:
            'Maximum tool execution rounds exceeded.',
        },
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        task.id,
      )

    return json(
      {
        success: false,
        error:
          'Maximum tool execution rounds exceeded.',
        task_id: task.id,
        executed_tools:
          executedTools,
      },
      502,
    )
  } catch (error) {
    console.error(
      'Yahalla AI error:',
      error,
    )

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error.',
      },
      500,
    )
  }
})
