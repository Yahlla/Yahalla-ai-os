import { executeDeviceTool } from '@yahalla/agent-tools'
import type { Db } from './db.js'
import { newId } from './db.js'
import { githubRead, githubWrite } from './github.js'
import { chatCompletion } from './llm.js'
import { addMemory, getPreference, recordTaskFeedback } from './memory.js'
import { checkAccess } from './permissions.js'
import { buildOpenAITools, DEFAULT_RUN_COMMAND_ALLOWLIST, getTool, type ToolDef } from './tools.js'

export type ChatMessage = { role: string; content: string | null; tool_calls?: any; tool_call_id?: string; name?: string }

export type ChatResult = {
  success: boolean
  conversationId: string
  taskId?: string
  status: 'completed' | 'waiting_approval' | 'failed'
  answer?: string
  error?: string
  executedTools?: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
  approvalId?: string
  approvalTool?: string
}

export type RuntimeContext = {
  db: Db
  projectRoot: string
  llmBaseUrl: string
  modelKey: string
}

// Evidence/verification and coding-agent-workflow rules carried over
// verbatim in spirit from the platform's Supabase edge function system
// prompt -- these are the behavioral rules that matter, independent of
// where the agent loop actually executes.
function buildSystemPrompt(projectRoot: string): string {
  return `
You are Yahalla AI, a real local coding agent running entirely on this device -- not a chatbot that talks about code. The project you work on is at: ${projectRoot}

Evidence and verification -- hard rules:
- Never guess or invent any fact about the project (file contents, versions, config, git state, test results). Every claim about the project must come from an actual tool result you just received.
- Never invent, assume, or fabricate a tool result. If you have not called the tool, you do not know the answer.
- If a tool call fails or is unavailable, say so plainly ("I could not verify this -- <reason>"). Do not paper over it with a guess.
- Never say a task is done, fixed, or succeeded without a tool result that actually proves it. A file write is not "done" until you have read it back or diffed it; a fix is not "done" until the relevant test/build command has actually been run and passed.

Coding-agent workflow for any request that touches the project:
1. Analyze the request. 2. Inspect the project for real (list_project_files / read_project_file) before assuming anything. 3. Plan the change. 4. Execute it (write_project_file / patch_project_file) -- old_text must be copied verbatim from a read you just did. 5. Verify by reading the file back or using git_diff. 6. Run the relevant test/build command (run_project_command) when one applies. 7. If it fails, diagnose the real output, fix it, and re-run the same command. Repeat until it passes or you have a concrete, evidence-based reason it cannot. 8. Only then report the outcome, citing what you actually verified.

Git and GitHub: git_status/git_diff are read-only and safe to use freely. git_commit, git_push, and github.write are sensitive and require the user's approval -- the platform enforces this automatically; just call the tool, never ask the user to run commands themselves, and never fabricate a commit hash, repo URL, or push result.

Be concise and useful. Respond in the user's language.
`.trim()
}

function toolPermissionTarget(tool: ToolDef, projectRoot: string): string {
  return tool.permission.scope === 'project' ? projectRoot : '*'
}

async function executeToolNow(
  ctx: RuntimeContext,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const allowed = checkAccess(ctx.db, tool.permission.scope, toolPermissionTarget(tool, ctx.projectRoot), tool.permission.access)
  if (!allowed) {
    return {
      success: false,
      error: `Permission denied: this tool needs "${tool.permission.access}" access to "${tool.permission.scope}", which has not been granted. Grant it in Settings > Permissions.`,
    }
  }

  if (tool.category === 'github') {
    const token = getPreference<string>(ctx.db, 'github_token')
    return tool.key === 'github.read' ? githubRead(token, args) : githubWrite(token, args)
  }

  const config = tool.key === 'run_project_command' ? { allowlist: DEFAULT_RUN_COMMAND_ALLOWLIST } : {}
  return executeDeviceTool(tool.key, ctx.projectRoot, args, config)
}

function getOrCreateConversation(db: Db, conversationId: string | undefined, firstMessage: string): string {
  if (conversationId) {
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)
    if (existing) return conversationId
  }
  const id = newId()
  db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, firstMessage.slice(0, 80))
  return id
}

function loadHistory(db: Db, conversationId: string, limit = 20): ChatMessage[] {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(conversationId, limit) as { role: string; content: string }[]
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }))
}

function saveMessage(db: Db, conversationId: string, role: string, content: string, toolActivity: unknown[] = []): void {
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, tool_activity) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), conversationId, role, content, JSON.stringify(toolActivity))
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId)
}

type LoopState = {
  messages: ChatMessage[]
  executedTools: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
}

async function runLoop(ctx: RuntimeContext, taskId: string, conversationId: string, state: LoopState): Promise<ChatResult> {
  const maxRounds = getPreference<number>(ctx.db, 'max_tool_rounds') ?? 15
  const llmTools = buildOpenAITools()

  for (let round = 0; round < maxRounds; round++) {
    const result = await chatCompletion(ctx.llmBaseUrl, {
      model: ctx.modelKey,
      messages: state.messages,
      tools: llmTools,
    })

    if (!result.ok) {
      db(ctx).prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
        JSON.stringify({ message: result.errorMessage }),
        taskId,
      )
      return { success: false, conversationId, taskId, status: 'failed', error: result.errorMessage }
    }

    const message = result.data?.choices?.[0]?.message
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    if (toolCalls.length === 0) {
      const answer: string =
        message?.content ?? result.data?.choices?.[0]?.text ?? (typeof result.data === 'string' ? result.data : '')

      if (!answer) {
        db(ctx).prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
          JSON.stringify({ message: 'Local LLM returned no usable answer.' }),
          taskId,
        )
        return { success: false, conversationId, taskId, status: 'failed', error: 'Local LLM returned no usable answer.' }
      }

      saveMessage(ctx.db, conversationId, 'assistant', answer, state.executedTools)
      addMemory(ctx.db, `User: ${state.messages[state.messages.length - 1]?.content ?? ''}\nYahalla: ${answer}`, {
        scope: 'conversation',
        key: conversationId,
        importance: 30,
      })
      ctx.db.prepare("UPDATE tasks SET status='completed', output=?, completed_at=datetime('now') WHERE id=?").run(
        JSON.stringify({ answer, executed_tools: state.executedTools }),
        taskId,
      )
      recordTaskFeedback(ctx.db, taskId, 'success')

      return { success: true, conversationId, taskId, status: 'completed', answer, executedTools: state.executedTools }
    }

    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })

    for (const call of toolCalls) {
      const toolName = call.function?.name
      const tool = getTool(toolName)
      let args: Record<string, unknown> = {}
      try {
        args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {})
      } catch {
        args = {}
      }

      if (!tool) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify({ success: false, error: `Tool "${toolName}" is not available.` }),
        })
        continue
      }

      if (tool.requiresApproval) {
        const approvalId = newId()
        ctx.db
          .prepare('INSERT INTO approvals (id, task_id, tool_key, arguments, reason, context) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            approvalId,
            taskId,
            tool.key,
            JSON.stringify(args),
            `Yahalla AI requested "${tool.key}".`,
            JSON.stringify({ ...state, conversationId, pendingToolCallId: call.id, pendingToolName: tool.key }),
          )
        ctx.db.prepare("UPDATE tasks SET status='waiting_approval' WHERE id=?").run(taskId)
        return { success: true, conversationId, taskId, status: 'waiting_approval', approvalId, approvalTool: tool.key }
      }

      const toolResult = await executeToolNow(ctx, tool, args)
      state.executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
      state.messages.push({ role: 'tool', tool_call_id: call.id, name: tool.key, content: JSON.stringify(toolResult) })
    }
  }

  ctx.db.prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
    JSON.stringify({ message: `Exceeded max tool rounds (${maxRounds}) without a final answer.` }),
    taskId,
  )
  return { success: false, conversationId, taskId, status: 'failed', error: `Exceeded max tool rounds (${maxRounds}).` }
}

function db(ctx: RuntimeContext): Db {
  return ctx.db
}

export async function runChat(
  ctx: RuntimeContext,
  message: string,
  conversationId?: string,
): Promise<ChatResult> {
  const convId = getOrCreateConversation(ctx.db, conversationId, message)
  saveMessage(ctx.db, convId, 'user', message)

  const taskId = newId()
  ctx.db.prepare('INSERT INTO tasks (id, title, status, input, conversation_id) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    message.slice(0, 120),
    'running',
    JSON.stringify({ message }),
    convId,
  )

  const history = loadHistory(ctx.db, convId)
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx.projectRoot) }, ...history]

  return runLoop(ctx, taskId, convId, { messages, executedTools: [] })
}

export async function resumeApproval(
  ctx: RuntimeContext,
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<ChatResult> {
  const approval = ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
    | { id: string; task_id: string; tool_key: string; arguments: string; status: string; context: string }
    | undefined

  if (!approval) throw new Error(`Unknown approval "${approvalId}".`)
  if (approval.status !== 'pending') throw new Error(`Approval "${approvalId}" was already decided (${approval.status}).`)

  const changed = ctx.db
    .prepare("UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(decision === 'approve' ? 'approved' : 'rejected', approvalId)
  if (changed.changes === 0) throw new Error(`Approval "${approvalId}" was already decided.`)

  const context = JSON.parse(approval.context) as LoopState & {
    conversationId: string
    pendingToolCallId: string
    pendingToolName: string
  }
  const tool = getTool(approval.tool_key)!
  const args = JSON.parse(approval.arguments)

  const toolResult =
    decision === 'approve'
      ? await executeToolNow(ctx, tool, args)
      : { success: false, error: 'Rejected by user.' }

  ctx.db.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(JSON.stringify(toolResult), approvalId)

  context.executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
  context.messages.push({
    role: 'tool',
    tool_call_id: context.pendingToolCallId,
    name: tool.key,
    content: JSON.stringify(toolResult),
  })

  ctx.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(approval.task_id)

  return runLoop(ctx, approval.task_id, context.conversationId, {
    messages: context.messages,
    executedTools: context.executedTools,
  })
}
