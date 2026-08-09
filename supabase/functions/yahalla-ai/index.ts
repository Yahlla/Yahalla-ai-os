import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type RequestBody = {
  message?: string
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

function extractLLMText(data: any): string {
  if (!data) return ''

  if (typeof data === 'string') {
    return data
  }

  if (typeof data.output === 'string') {
    return data.output
  }

  if (typeof data.response === 'string') {
    return data.response
  }

  if (typeof data.message === 'string') {
    return data.message
  }

  if (data.message?.content) {
    return String(data.message.content)
  }

  if (data.choices?.[0]?.message?.content) {
    return String(data.choices[0].message.content)
  }

  if (data.choices?.[0]?.text) {
    return String(data.choices[0].text)
  }

  if (Array.isArray(data.output)) {
    const text = data.output
      .map((item: any) => {
        if (typeof item === 'string') return item
        if (typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('\n')

    if (text) return text
  }

  return ''
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
    // -------------------------------------------------------
    // Environment
    // -------------------------------------------------------

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const llmUrl = Deno.env.get('YAHALLA_LLM_URL')

    if (!supabaseUrl || !serviceRoleKey) {
      return json(
        {
          success: false,
          error: 'Supabase server configuration is missing.',
        },
        500,
      )
    }

    if (!llmUrl) {
      return json(
        {
          success: false,
          error: 'YAHALLA_LLM_URL is not configured.',
        },
        500,
      )
    }

    // -------------------------------------------------------
    // Authentication
    // -------------------------------------------------------

    const authorization = req.headers.get('Authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return json(
        {
          success: false,
          error: 'Authentication required.',
        },
        401,
      )
    }

    const token = authorization.replace('Bearer ', '').trim()

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
    } = await admin.auth.getUser(token)

    if (userError || !user) {
      return json(
        {
          success: false,
          error: 'Invalid authentication token.',
        },
        401,
      )
    }

    // -------------------------------------------------------
    // Request
    // -------------------------------------------------------

    const body = (await req.json()) as RequestBody
    const message = body.message?.trim()

    if (!message) {
      return json(
        {
          success: false,
          error: 'Message is required.',
        },
        400,
      )
    }

    if (message.length > 10000) {
      return json(
        {
          success: false,
          error: 'Message is too long.',
        },
        400,
      )
    }

    // -------------------------------------------------------
    // User profile
    // -------------------------------------------------------

    const { data: profile } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()

    // -------------------------------------------------------
    // Yahalla Core
    // -------------------------------------------------------

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
      console.error('Agent lookup failed:', agentError)

      return json(
        {
          success: false,
          error: 'Failed to load Yahalla Core.',
        },
        500,
      )
    }

    if (!agent) {
      return json(
        {
          success: false,
          error: 'Yahalla Core agent is not configured.',
        },
        503,
      )
    }

    // -------------------------------------------------------
    // Permissions
    // -------------------------------------------------------

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
      console.error(
        'Permission lookup failed:',
        permissionsError,
      )

      return json(
        {
          success: false,
          error: 'Failed to load agent permissions.',
        },
        500,
      )
    }

    // -------------------------------------------------------
    // Tools
    // -------------------------------------------------------

    const {
      data: tools,
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
      console.error('Tool lookup failed:', toolsError)

      return json(
        {
          success: false,
          error: 'Failed to load agent tools.',
        },
        500,
      )
    }

    // -------------------------------------------------------
    // Memory
    // -------------------------------------------------------

    const {
      data: memories,
      error: memoryError,
    } = await admin
      .from('ai_memory')
      .select('*')
      .or(`scope.eq.global,owner_id.eq.${user.id}`)
      .order('importance', {
        ascending: false,
      })
      .limit(20)

    if (memoryError) {
      console.error(
        'Memory lookup failed:',
        memoryError,
      )

      return json(
        {
          success: false,
          error: 'Failed to load AI memory.',
        },
        500,
      )
    }

    // -------------------------------------------------------
    // Create task
    // -------------------------------------------------------

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
        status: 'pending',
      })
      .select('*')
      .single()

    if (taskError) {
      console.error(
        'Task creation failed:',
        taskError,
      )

      return json(
        {
          success: false,
          error: 'Failed to create task.',
          details: taskError.message,
          code: taskError.code ?? null,
          hint: taskError.hint ?? null,
        },
        500,
      )
    }

    // -------------------------------------------------------
    // Audit
    // -------------------------------------------------------

    const { error: auditError } = await admin
      .from('audit_logs')
      .insert({
        actor_id: user.id,
        action: 'ai.request',
        entity_type: 'task',
        entity_id: task.id,
        metadata: {
          agent: agent.key,
          message_length: message.length,
        },
      })

    if (auditError) {
      console.warn(
        'Audit log failed:',
        auditError,
      )
    }

    // -------------------------------------------------------
    // Build LLM context
    // -------------------------------------------------------

    const permissionKeys =
      (permissions ?? [])
        .map((item: any) => item.permissions?.key)
        .filter(Boolean)

    const availableTools =
      (tools ?? [])
        .map((item: any) => ({
          key: item.tools?.key,
          category: item.tools?.category,
          requires_approval:
            item.tools?.requires_approval ?? true,
          configuration:
            item.tools?.configuration ?? {},
        }))
        .filter((tool: any) => tool.key)

    const memoryContext =
      (memories ?? []).map((memory: any) => ({
        key: memory.memory_key,
        content: memory.content,
        importance: memory.importance,
      }))

    const systemPrompt = `
You are Yahalla AI Core.

Company: Yahalla

You are the central AI operating system responsible for:
- understanding requests
- reasoning
- task management
- memory
- knowledge
- tools
- approvals
- audit logging

You must respect the permissions and available tools provided below.

Agent:
${agent.key}

Agent configuration:
${JSON.stringify(agent.configuration)}

Permissions:
${JSON.stringify(permissionKeys)}

Available tools:
${JSON.stringify(availableTools)}

Relevant memory:
${JSON.stringify(memoryContext)}

User profile:
${JSON.stringify(profile ?? {})}

Important rules:
1. Never claim that an action was executed unless it actually was.
2. Never invent tool results.
3. Sensitive actions require approval when the tool requires approval.
4. Be concise and useful.
5. Respond in the same language as the user when possible.
6. You are Yahalla AI Core.
`.trim()

    // -------------------------------------------------------
    // Call LLM
    // -------------------------------------------------------

    const llmPayload = {
      model: 'yahalla-core',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      user_id: user.id,
      task_id: task.id,
      agent: {
        key: agent.key,
        configuration: agent.configuration,
      },
      permissions: permissionKeys,
      tools: availableTools,
      memory: memoryContext,
    }

    console.log(
      'Calling Yahalla LLM:',
      llmUrl,
    )

    const llmResponse = await fetch(
      llmUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(llmPayload),
      },
    )

    const rawText = await llmResponse.text()

    let llmData: any = null

    try {
      llmData = JSON.parse(rawText)
    } catch {
      llmData = rawText
    }

    if (!llmResponse.ok) {
      console.error(
        'LLM request failed:',
        llmResponse.status,
        rawText.slice(0, 2000),
      )

      await admin
        .from('tasks')
        .update({
          status: 'failed',
          error: {
            message: 'LLM request failed.',
            status: llmResponse.status,
            response: rawText.slice(0, 2000),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id)

      return json(
        {
          success: false,
          error: 'Yahalla LLM request failed.',
          task_id: task.id,
          llm_status: llmResponse.status,
          details: rawText.slice(0, 2000),
        },
        502,
      )
    }

    // -------------------------------------------------------
    // Extract answer
    // -------------------------------------------------------

    const answer = extractLLMText(llmData)

    if (!answer) {
      console.error(
        'Could not extract LLM response:',
        rawText.slice(0, 3000),
      )

      await admin
        .from('tasks')
        .update({
          status: 'failed',
          error: {
            message:
              'LLM returned an unsupported response format.',
            response: llmData,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id)

      return json(
        {
          success: false,
          error:
            'LLM returned an unsupported response format.',
          task_id: task.id,
          raw_response: llmData,
        },
        502,
      )
    }

    // -------------------------------------------------------
    // Save result
    // -------------------------------------------------------

    await admin
      .from('tasks')
      .update({
        status: 'completed',
        output: {
          answer,
          provider_response: llmData,
        },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)

    // -------------------------------------------------------
    // Save conversational memory
    // -------------------------------------------------------

    await admin
      .from('ai_memory')
      .insert({
        scope: 'user',
        owner_id: user.id,
        agent_id: agent.id,
        task_id: task.id,
        memory_key: `conversation:${task.id}`,
        content: `User: ${message}\nYahalla: ${answer}`,
        metadata: {
          type: 'conversation',
        },
        importance: 30,
      })

    // -------------------------------------------------------
    // Final response
    // -------------------------------------------------------

    return json({
      success: true,

      task_id: task.id,

      status: 'completed',

      answer,

      agent: {
        id: agent.id,
        key: agent.key,
        name_ar: agent.name_ar,
        name_de: agent.name_de,
        status: agent.status,
      },

      permissions: permissions ?? [],

      tools: tools ?? [],

      memory_count: memories?.length ?? 0,
    })
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