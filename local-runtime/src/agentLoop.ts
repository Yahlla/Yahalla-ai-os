import { executeDeviceTool } from '@yahalla/agent-tools'
import { listDatabaseConnections, queryDatabase, executeDatabase } from './database.js'
import type { Db } from './db.js'
import { newId } from './db.js'
import type { EmbodimentStateMachine } from './embodiment/stateMachine.js'
import { githubOpenPr, githubRead, githubWrite } from './github.js'
import { diagnoseCommandFailure, signatureForToolFailure, sortKeys } from './diagnostics.js'
import { detectLanguage, languageInstructionLine } from './langDetect.js'
import { chatCompletion, chatCompletionStreamWithRetry, chatCompletionWithRetry } from './llm.js'
import { addKnowledge, addMemory, getPreference, recordTaskFeedback } from './memory.js'
import { checkAccess } from './permissions.js'
import type { WorldModel } from './perception/worldModel.js'
import {
  isOnProtectedBranch,
  isSelfDevProject,
  SELF_DEV_MUTATING_TOOLS,
  SELF_DEV_SYSTEM_PROMPT_ADDENDUM,
  selfDevBranchGuardMessage,
  summarizeSelfDevOutcome,
} from './selfDev.js'
import { buildOpenAITools, DEFAULT_RUN_COMMAND_ALLOWLIST, getTool, type ToolDef } from './tools.js'
import { searchMemory, storeMemory } from './vectorMemory.js'

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
  // Set once this device is paired to a platform-api deployment (see
  // devicePairing.ts) -- lets the agent loop pull relevant project memory
  // into context automatically (vectorMemory.ts) instead of the user
  // having to re-explain history every conversation. Both unset just means
  // memory search/store silently no-ops.
  platformApiUrl?: string
  deviceToken?: string
}

// Evidence/verification and coding-agent-workflow rules carried over
// verbatim in spirit from the platform's Supabase edge function system
// prompt -- these are the behavioral rules that matter, independent of
// where the agent loop actually executes.
async function buildSystemPrompt(projectRoot: string, ctx: RuntimeContext, currentMessage: string): Promise<string> {
  // Real, near-instant step (the detector itself runs in <5ms, see
  // langDetect.ts) surfaced through the same embodiment.transition() +
  // /live/stream SSE mechanism the "Analyzing request"/"Continuing
  // analysis" steps right after this already use -- the frontend's
  // Live Thinking Card (App.tsx's thinkingSteps) picks this up with no
  // changes needed on that side, since it already renders any transition
  // this loop emits.
  ctx.embodiment.transition('THINKING', 'Detecting language')
  const detectedLanguage = detectLanguage(currentMessage)

  const perceptionContext = buildPerceptionContext(ctx)
  const memoryContext = await buildMemoryContext(ctx, currentMessage)
  const selfDevContext = isSelfDevProject(projectRoot) ? `\n${SELF_DEV_SYSTEM_PROMPT_ADDENDUM}\n` : ''
  return `
You are Yahalla AI, a real local coding agent running entirely on this device -- not a chatbot that talks about code. The project you work on is at: ${projectRoot}
${selfDevContext}

Evidence and verification -- hard rules:
- Never guess or invent any fact about the project (file contents, versions, config, git state, test results). Every claim about the project must come from an actual tool result you just received.
- Never invent, assume, or fabricate a tool result. If you have not called the tool, you do not know the answer.
- If a tool call fails or is unavailable, say so plainly ("I could not verify this -- <reason>"). Do not paper over it with a guess.
- Never say a task is done, fixed, or succeeded without a tool result that actually proves it. A file write is not "done" until you have read it back or diffed it; a fix is not "done" until the relevant test/build command has actually been run and passed.

Coding-agent workflow for any request that touches the project. You are autonomous through this entire sequence -- no step here pauses for approval, so work it end-to-end without asking the user to confirm each action:
1. Analyze the request. 2. Inspect the project for real (list_project_files / read_project_file) before assuming anything. 3. Plan the change -- for anything non-trivial, create a branch first (git_create_branch). 4. Execute it (write_project_file / patch_project_file) -- old_text must be copied verbatim from a read you just did. 5. Verify by reading the file back or using git_diff. 6. Run the relevant test/build command (run_project_command) when one applies. 7. If it fails, diagnose the real output, fix it, and re-run the same command. Repeat until it passes or you have a concrete, evidence-based reason it cannot. 8. Commit (git_commit) and push (git_push) the branch. 9. Open a pull request (github.open_pr) describing what changed, why, and what you verified -- this PR is the human's review checkpoint, not a request for permission first. 10. Report the outcome and the PR link, citing what you actually verified.

Git and GitHub: git_status/git_diff/git_create_branch/git_commit/git_push/github.open_pr are all free to use without asking -- call them directly as part of the workflow above, never ask the user to run a command themselves, and never fabricate a commit hash, repo URL, PR number, or push result. github.write (creating a brand-new repository, not a PR) is the one GitHub action that still requires the user's approval -- the platform enforces this automatically, just call the tool and wait.

Databases: call db_list_connections first if you don't already know a connection's id. db_query is read-only (enforced by the database itself, not just convention) and safe to use freely for inspecting data/schema, debugging, and diagnostics. db_execute runs writes/DDL and requires the user's approval -- call it directly, never ask the user to run SQL themselves, and never fabricate query results or row counts.
${perceptionContext ? `\n${perceptionContext}\n` : ''}${memoryContext ? `\n${memoryContext}\n` : ''}
Be concise and useful. ${languageInstructionLine(detectedLanguage)}
`.trim()
}

// Folds relevant prior project memory into the prompt as weak supporting
// context, the same trust level as the perception context above -- real
// past entries this project actually recorded, ranked by a real cosine
// similarity search (see vectorMemory.ts), but never presented as
// something the user just said. Silently empty when this device isn't
// paired to platform-api, or nothing relevant was ever recorded.
async function buildMemoryContext(ctx: RuntimeContext, currentMessage: string): Promise<string> {
  const results = await searchMemory({ platformApiUrl: ctx.platformApiUrl, deviceToken: ctx.deviceToken }, currentMessage, 5)
  const relevant = results.filter((r) => r.similarity > 0.3)
  if (relevant.length === 0) return ''

  const lines = relevant.map((r) => `- (${new Date(r.created_at).toLocaleDateString()}, ${r.source}) ${r.content}`)
  return `Relevant memory from this project's history (retrieved by similarity to the current message, not guaranteed relevant -- use only what's actually applicable):\n${lines.join('\n')}`
}

function summarizeForMemory(message: string, result: ChatResult): string {
  const tools = (result.executedTools ?? []).map((t) => t.tool).join(', ')
  const answer = (result.answer ?? '').slice(0, 400)
  return `Task: ${message.slice(0, 300)}\nTools used: ${tools || 'none'}\nOutcome: ${answer}`
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

// Cross-round repeated-failure detection: a failed result gets a stable
// signature (structured, via diagnostics.ts's diagnoseCommandFailure for
// run_project_command since it has stdout/stderr to fingerprint; generic
// for every other tool). If this exact {tool, arguments, error} has
// already failed before in this task, the model is told explicitly instead
// of being left to silently repeat the same failing strategy until
// max_tool_rounds runs out. A successful result is left untouched.
function annotateRepeatedFailure(
  state: LoopState,
  tool: ToolDef,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.success !== false) return result

  const signature =
    tool.key === 'run_project_command'
      ? diagnoseCommandFailure(String(args.command ?? ''), result as { exit_code?: number | null; stdout?: string; stderr?: string })
          .failureSignature
      : signatureForToolFailure(tool.key, args, result.error ?? result)

  state.failureSignatures ??= {}
  const priorCount = state.failureSignatures[signature] ?? 0
  state.failureSignatures[signature] = priorCount + 1

  if (priorCount === 0) return result
  return {
    ...result,
    repeated_failure_warning: `This exact call has already failed the same way ${priorCount} time(s) before in this task. Repeating it unchanged will not help -- try a different approach, inspect more context first, or explain to the user why it cannot proceed.`,
  }
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

  // Self-development safety rail: when the project being modified is
  // Yahalla's own source, mutating tools are blocked outright while the
  // working tree sits on a protected branch. Checked here (not just asked
  // for in the system prompt) so it holds even if the model ignores the
  // instruction -- real git state, read fresh, not a cached assumption.
  if (SELF_DEV_MUTATING_TOOLS.has(tool.key) && isSelfDevProject(ctx.projectRoot) && isOnProtectedBranch(ctx.projectRoot)) {
    return { success: false, error: selfDevBranchGuardMessage(tool.key) }
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
  // Signature -> occurrence count, for cross-round repeated-failure
  // detection (see diagnostics.ts). Plain Record, not a Map: this whole
  // object round-trips through JSON.stringify/JSON.parse when a task pauses
  // for approval (see resumeApproval below), and a Map does not survive
  // that round-trip.
  failureSignatures?: Record<string, number>
}

async function runLoop(
  ctx: RuntimeContext,
  taskId: string,
  conversationId: string,
  state: LoopState,
  onToken?: (delta: string) => void,
): Promise<ChatResult> {
  const maxRounds = getPreference<number>(ctx.db, 'max_tool_rounds') ?? 15
  const llmTools = buildOpenAITools()

  for (let round = 0; round < maxRounds; round++) {
    ctx.embodiment.transition('THINKING', round === 0 ? 'Analyzing request' : 'Continuing analysis')

    // onToken (only ever set by runChat, not generatePlan/resumeApproval)
    // is threaded all the way down to a real streaming HTTP call
    // (chatCompletionStream) so the caller sees live tokens the same way
    // the browser tier already does -- every round still ends up with the
    // exact same accumulated { message: { content, tool_calls } } shape
    // either way, so tool-call detection and approval-gating below are
    // byte-for-byte unaffected by which one ran. In practice a single
    // round is either a plain-text answer or a tool call, never a mix, so
    // forwarding content deltas live as they arrive never ends up
    // "retracting" text the user already saw.
    const result = onToken
      ? await chatCompletionStreamWithRetry(ctx.llmBaseUrl, { model: ctx.modelKey, messages: state.messages, tools: llmTools }, onToken)
      : await chatCompletionWithRetry(ctx.llmBaseUrl, { model: ctx.modelKey, messages: state.messages, tools: llmTools })

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

    // Same-round dedup: a model that emits the exact same {tool, arguments}
    // call twice in one response (models do this, especially smaller ones)
    // should get the same result echoed back for the repeat, not run the
    // side effect twice. Only scoped to this one round -- calling the same
    // tool with the same arguments again in a *later* round is legitimate
    // (e.g. re-running a test command after a fix) and is handled by
    // repeated-failure detection below, not blocked here.
    const seenThisRound = new Map<string, Record<string, unknown>>()

    for (const call of toolCalls) {
      const toolName = call.function?.name
      const tool = getTool(toolName)
      let args: Record<string, unknown> = {}
      let argsParseFailed = false
      try {
        args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {})
      } catch {
        argsParseFailed = true
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

      if (argsParseFailed) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify({
            success: false,
            error: `Arguments for "${tool.key}" were not valid JSON: ${String(call.function?.arguments).slice(0, 300)}. Re-call the tool with valid JSON arguments.`,
          }),
        })
        continue
      }

      const dedupKey = `${tool.key}::${JSON.stringify(sortKeys(args))}`
      const cached = seenThisRound.get(dedupKey)
      if (cached) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify({ ...cached, note: 'Duplicate call in the same round -- reusing the prior result instead of re-executing.' }),
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
      seenThisRound.set(dedupKey, toolResult)

      const reportedResult = annotateRepeatedFailure(state, tool, args, toolResult)
      state.messages.push({ role: 'tool', tool_call_id: call.id, name: tool.key, content: JSON.stringify(reportedResult) })
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
  onToken?: (delta: string) => void,
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
  const systemPrompt = await buildSystemPrompt(ctx.projectRoot, ctx, message)
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt + planContext }, ...history]

  const chatResult = await runLoop(ctx, taskId, convId, { messages, executedTools: [] }, onToken)

  // Only worth remembering across conversations when real project work
  // happened (a tool actually ran) -- not every trivial Q&A, which would
  // just flood future context with noise. Best-effort: a failed memory
  // write never fails the chat it came from.
  if (chatResult.status === 'completed' && (chatResult.executedTools?.length ?? 0) > 0) {
    void storeMemory({ platformApiUrl: ctx.platformApiUrl, deviceToken: ctx.deviceToken }, summarizeForMemory(message, chatResult), 'agent')
  }

  // Self-development change record: once a self-dev task actually commits
  // something, persist a durable "what changed and why" entry independent
  // of chat history -- this is what lets a later Yahalla session (or a
  // human) see the real history of self-modifications without re-reading
  // every conversation.
  if (
    chatResult.status === 'completed' &&
    isSelfDevProject(ctx.projectRoot) &&
    (chatResult.executedTools ?? []).some((t) => t.tool === 'git_commit' && t.result.success)
  ) {
    addKnowledge(ctx.db, `Self-dev: ${message.slice(0, 80)}`, summarizeSelfDevOutcome(message, chatResult.executedTools ?? []), {
      sourceType: 'self_dev',
      tags: ['self_dev'],
    })
  }

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
  const reportedResult =
    decision === 'approve' ? annotateRepeatedFailure(context, tool, args, toolResult) : toolResult
  context.messages.push({
    role: 'tool',
    tool_call_id: context.pendingToolCallId,
    name: tool.key,
    content: JSON.stringify(reportedResult),
  })

  ctx.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(approval.task_id)

  return runLoop(ctx, approval.task_id, context.conversationId, {
    messages: context.messages,
    executedTools: context.executedTools,
    failureSignatures: context.failureSignatures ?? {},
  })
}
