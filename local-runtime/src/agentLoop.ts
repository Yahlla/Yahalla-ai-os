import { executeDeviceTool } from '@yahalla/agent-tools'
import { listDatabaseConnections, queryDatabase, executeDatabase } from './database.js'
import type { Db } from './db.js'
import { newId } from './db.js'
import type { EmbodimentStateMachine } from './embodiment/stateMachine.js'
import { githubOpenPr, githubRead, githubWrite } from './github.js'
import { chatCompletion } from './llm.js'
import { addMemory, getPreference, recordTaskFeedback } from './memory.js'
import { checkAccess } from './permissions.js'
import type { WorldModel } from './perception/worldModel.js'
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
  embodiment: EmbodimentStateMachine
  worldModel: WorldModel
}

// Evidence/verification and coding-agent-workflow rules carried over
// verbatim in spirit from the platform's Supabase edge function system
// prompt -- these are the behavioral rules that matter, independent of
// where the agent loop actually executes.
function buildSystemPrompt(projectRoot: string, ctx: RuntimeContext): string {
  const perceptionContext = buildPerceptionContext(ctx)
  return `
You are Yahalla AI, a real local coding agent running entirely on this device -- not a chatbot that talks about code. The project you work on is at: ${projectRoot}

Evidence and verification -- hard rules:
- Never guess or invent any fact about the project (file contents, versions, config, git state, test results). Every claim about the project must come from an actual tool result you just received.
- Never invent, assume, or fabricate a tool result. If you have not called the tool, you do not know the answer.
- If a tool call fails or is unavailable, say so plainly ("I could not verify this -- <reason>"). Do not paper over it with a guess.
- Never say a task is done, fixed, or succeeded without a tool result that actually proves it. A file write is not "done" until you have read it back or diffed it; a fix is not "done" until the relevant test/build command has actually been run and passed.

Coding-agent workflow for any request that touches the project. You are autonomous through this entire sequence -- no step here pauses for approval, so work it end-to-end without asking the user to confirm each action:
1. Analyze the request. 2. Inspect the project for real (list_project_files / read_project_file) before assuming anything. 3. Plan the change -- for anything non-trivial, create a branch first (git_create_branch). 4. Execute it (write_project_file / patch_project_file) -- old_text must be copied verbatim from a read you just did. 5. Verify by reading the file back or using git_diff. 6. Run the relevant test/build command (run_project_command) when one applies. 7. If it fails, diagnose the real output, fix it, and re-run the same command. Repeat until it passes or you have a concrete, evidence-based reason it cannot. 8. Commit (git_commit) and push (git_push) the branch. 9. Open a pull request (github.open_pr) describing what changed, why, and what you verified -- this PR is the human's review checkpoint, not a request for permission first. 10. Report the outcome and the PR link, citing what you actually verified.

Git and GitHub: git_status/git_diff/git_create_branch/git_commit/git_push/github.open_pr are all free to use without asking -- call them directly as part of the workflow above, never ask the user to run a command themselves, and never fabricate a commit hash, repo URL, PR number, or push result. github.write (creating a brand-new repository, not a PR) is the one GitHub action that still requires the user's approval -- the platform enforces this automatically, just call the tool and wait.

Databases: call db_list_connections first if you don't already know a connection's id. db_query is read-only (enforced by the database itself, not just convention) and safe to use freely for inspecting data/schema, debugging, and diagnostics. db_execute runs writes/DDL and requires the user's approval -- call it directly, never ask the user to run SQL themselves, and never fabricate query results or row counts.
${perceptionContext ? `\n${perceptionContext}\n` : ''}
Be concise and useful. Respond in the user's language.
`.trim()
}

// Folds the World Model into the prompt as weak, explicitly-probabilistic
// supporting context -- never as a substitute for what the user actually
// typed/said. This is the concrete "Agent reasons over perception events"
// integration point: nothing here claims to read emotion or intent, only
// the same confidence-scored signals the perception layer produced.
function buildPerceptionContext(ctx: RuntimeContext): string {
  const snapshot = ctx.worldModel.getSnapshot()
  if (snapshot.humans.length === 0) return ''

  const lines = snapshot.humans.map((human) => {
    const parts: string[] = [`state=${human.interactionState}`]
    if (human.gaze?.target) parts.push(`gaze target="${human.gaze.target}" (confidence ${human.gaze.confidence.toFixed(2)})`)
    if (human.voice.lastFinal) parts.push(`last speech="${human.voice.lastFinal}"`)
    return `- person ${human.trackId}: ${parts.join(', ')}`
  })

  return `Local perception context (probabilistic signals, not facts -- use only as weak supporting context; the user's actual text/voice message always takes precedence):\n${lines.join('\n')}`
}

function summarizeToolCall(tool: ToolDef, args: Record<string, unknown>): string {
  switch (tool.key) {
    case 'read_project_file':
      return `Reading ${args.path ?? 'a file'}`
    case 'list_project_files':
      return `Inspecting ${args.path && args.path !== '.' ? args.path : 'project structure'}`
    case 'write_project_file':
      return `Writing ${args.path ?? 'a file'}`
    case 'patch_project_file':
      return `Applying correction to ${args.path ?? 'a file'}`
    case 'git_status':
      return 'Checking git status'
    case 'git_diff':
      return 'Reviewing changes'
    case 'git_create_branch':
      return `Creating branch ${args.branch ?? ''}`
    case 'git_commit':
      return 'Committing changes'
    case 'git_push':
      return 'Pushing to remote'
    case 'run_project_command':
      return `Running ${args.command ?? 'command'}`
    case 'github.read':
      return 'Checking GitHub repositories'
    case 'github.write':
      return 'Creating GitHub repository'
    case 'github.open_pr':
      return `Opening pull request "${args.title ?? ''}"`
    case 'db_list_connections':
      return 'Listing connected databases'
    case 'db_query':
      return 'Querying the database'
    case 'db_execute':
      return 'Modifying the database'
    default:
      return `Using ${tool.key}`
  }
}

function summarizeToolResult(tool: ToolDef, result: Record<string, unknown>): string {
  if (tool.key === 'run_project_command') {
    return result.success ? 'Command completed successfully' : 'Command failed'
  }
  if (result.success === false) return `${summarizeToolCall(tool, {})} failed`
  return `${summarizeToolCall(tool, {})} -- done`
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
    if (tool.key === 'github.read') return githubRead(token, args)
    if (tool.key === 'github.open_pr') return githubOpenPr(token, args)
    return githubWrite(token, args)
  }

  if (tool.category === 'database') {
    if (tool.key === 'db_list_connections') {
      return { success: true, connections: listDatabaseConnections(ctx.db) }
    }
    const connectionId = String(args.connection_id ?? '')
    const query = String(args.query ?? '')
    return tool.key === 'db_query' ? queryDatabase(ctx.db, connectionId, query) : executeDatabase(ctx.db, connectionId, query)
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
    ctx.embodiment.transition('THINKING', round === 0 ? 'Analyzing request' : 'Continuing analysis')

    const result = await chatCompletion(ctx.llmBaseUrl, {
      model: ctx.modelKey,
      messages: state.messages,
      tools: llmTools,
    })

    if (!result.ok) {
      ctx.embodiment.transition('ERROR', 'Local LLM request failed')
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
        ctx.embodiment.transition('ERROR', 'No usable answer from the local model')
        db(ctx).prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
          JSON.stringify({ message: 'Local LLM returned no usable answer.' }),
          taskId,
        )
        return { success: false, conversationId, taskId, status: 'failed', error: 'Local LLM returned no usable answer.' }
      }

      ctx.embodiment.transition('SPEAKING', answer.slice(0, 120))
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
      ctx.embodiment.transition('SUCCESS', 'Task completed')

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
        ctx.embodiment.transition('WAITING', `Waiting for approval: ${summarizeToolCall(tool, args)}`)
        return { success: true, conversationId, taskId, status: 'waiting_approval', approvalId, approvalTool: tool.key }
      }

      ctx.embodiment.transition('ACTING', summarizeToolCall(tool, args))
      const toolResult = await executeToolNow(ctx, tool, args)
      ctx.embodiment.transition('ACTING', summarizeToolResult(tool, toolResult))
      state.executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
      state.messages.push({ role: 'tool', tool_call_id: call.id, name: tool.key, content: JSON.stringify(toolResult) })
    }
  }

  ctx.embodiment.transition('ERROR', 'Exceeded maximum tool rounds')
  ctx.db.prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
    JSON.stringify({ message: `Exceeded max tool rounds (${maxRounds}) without a final answer.` }),
    taskId,
  )
  return { success: false, conversationId, taskId, status: 'failed', error: `Exceeded max tool rounds (${maxRounds}).` }
}

function db(ctx: RuntimeContext): Db {
  return ctx.db
}

// A short, dedicated call (no tools) that asks the model to break a large
// or vague goal into concrete ordered steps before the main tool-calling
// loop starts -- the same "1. Analyze 2. Inspect 3. Plan..." workflow the
// system prompt already asks for, made explicit and persisted instead of
// left implicit in the model's head. Failure here (unparseable response,
// LLM error) is never fatal to the chat itself: it just means no plan was
// recorded, and runChat falls back to the loop's existing behavior.
const PLANNING_SYSTEM_PROMPT = `You are a planning assistant. Break the user's goal into 2 to 8 concrete, ordered, actionable subtasks. Respond with ONLY a JSON array of short subtask title strings -- no prose, no markdown, nothing else. Example: ["Set up the database schema", "Build the API endpoints", "Wire the frontend", "Test end to end"]`

export function parsePlanResponse(content: string): string[] | null {
  // Models sometimes wrap JSON in a fenced code block despite being told
  // not to -- strip that before parsing rather than rejecting outright.
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const subtasks = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
  if (subtasks.length < 2 || subtasks.length > 10) return null
  return subtasks
}

// Only worth the extra LLM round-trip for a substantial, first-in-
// conversation request -- a short follow-up ("what does that mean?") or a
// message deep into an existing conversation doesn't need a fresh plan.
export function shouldPlan(message: string, isFirstMessageInConversation: boolean): boolean {
  return isFirstMessageInConversation && message.trim().length >= 80
}

export async function generatePlan(ctx: RuntimeContext, goal: string): Promise<string[] | null> {
  const result = await chatCompletion(ctx.llmBaseUrl, {
    model: ctx.modelKey,
    messages: [
      { role: 'system', content: PLANNING_SYSTEM_PROMPT },
      { role: 'user', content: goal },
    ],
  })
  if (!result.ok) return null
  const content = result.data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') return null
  return parsePlanResponse(content)
}

export async function runChat(
  ctx: RuntimeContext,
  message: string,
  conversationId?: string,
): Promise<ChatResult> {
  // Checked before saveMessage inserts the current message, so it
  // reflects whether a conversation existed *before* this request --
  // loadHistory after saving would always see at least this one message.
  const isFirstMessage = !conversationId || loadHistory(ctx.db, conversationId, 1).length === 0

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

  let planContext = ''
  if (shouldPlan(message, isFirstMessage)) {
    ctx.embodiment.transition('THINKING', 'Breaking the goal into steps')
    const plan = await generatePlan(ctx, message)
    if (plan) {
      const insertSubtask = ctx.db.prepare(
        'INSERT INTO tasks (id, title, status, input, conversation_id, parent_task_id, plan_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      plan.forEach((title, index) => {
        insertSubtask.run(newId(), title, 'pending', JSON.stringify({}), convId, taskId, index)
      })
      planContext = `\n\nYou already broke this goal into ${plan.length} steps:\n${plan.map((title, i) => `${i + 1}. ${title}`).join('\n')}\nWork through them in order using the available tools, treating each as a checkpoint before moving to the next. Do not silently skip a step.`
    }
  }

  const history = loadHistory(ctx.db, convId)
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx.projectRoot, ctx) + planContext }, ...history]

  const chatResult = await runLoop(ctx, taskId, convId, { messages, executedTools: [] })

  // Honest bookkeeping, not fine-grained per-subtask tracking the loop
  // doesn't actually do: once the parent task the plan belongs to
  // succeeds, its still-pending subtasks are marked completed too --
  // there is no separate signal for "step 3 of 5 done" mid-loop, only
  // "the whole goal succeeded" or it didn't.
  if (chatResult.status === 'completed') {
    ctx.db
      .prepare("UPDATE tasks SET status='completed', completed_at=datetime('now') WHERE parent_task_id = ? AND status = 'pending'")
      .run(taskId)
  }

  return chatResult
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

  if (decision === 'approve') {
    ctx.embodiment.transition('ACTING', summarizeToolCall(tool, args))
  }
  const toolResult =
    decision === 'approve'
      ? await executeToolNow(ctx, tool, args)
      : { success: false, error: 'Rejected by user.' }
  ctx.embodiment.transition('ACTING', decision === 'approve' ? summarizeToolResult(tool, toolResult) : 'Action rejected by user')

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
