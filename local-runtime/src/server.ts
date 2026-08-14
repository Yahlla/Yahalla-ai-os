import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resumeApproval, runChat, type RuntimeContext } from './agentLoop.js'
import type { RuntimeConfig } from './config.js'
import { saveConfig } from './config.js'
import type { Db } from './db.js'
import { addDatabaseConnection, listDatabaseConnections, removeDatabaseConnection } from './database.js'
import { pairDevice } from './devicePairing.js'
import { EmbodimentStateMachine } from './embodiment/stateMachine.js'
import { githubApiBase } from './github.js'
import { detectHardware } from './hardware.js'
import { findLlamaServerBinary, isLlamaServerInstalled, isLlmReachable, LocalModelProcess } from './llm.js'
import { PermissionRequiredError, PerceptionManager } from './perception/manager.js'
import {
  addKnowledge,
  addMemory,
  getPreference,
  listKnowledge,
  listMemory,
  listPreferences,
  listSkills,
  setPreference,
} from './memory.js'
import {
  deleteModel,
  downloadModel,
  getActiveModel,
  listModels,
  MODEL_CATALOG,
  recommendCatalogEntry,
  recommendedContextSize,
  registerModel,
  setActiveModel,
} from './modelManager.js'
import { checkAccess, grantPermission, listPermissions, revokePermission, type AccessLevel, type PermissionScope } from './permissions.js'
import { canChangeRole, getDeviceRole, setDeviceRole, type DeviceRole } from './roles.js'

export type ServerDeps = {
  db: Db
  config: RuntimeConfig
  modelProcess: LocalModelProcess
  embodiment?: EmbodimentStateMachine
  perception?: PerceptionManager
  // Called after a pairing/unpairing change so index.ts can stop the old
  // task poller and start a new one against the updated config. Optional
  // only so tests that don't care about remote task dispatch can omit it.
  restartTaskPoller?: () => void
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function isAuthorized(req: IncomingMessage, config: RuntimeConfig): boolean {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return false
  return header.slice('Bearer '.length) === config.authToken
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): void {
  const origin = req.headers.origin
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

export function ctxFrom(deps: ServerDeps, embodiment: EmbodimentStateMachine, perception: PerceptionManager): RuntimeContext {
  const active = getActiveModel(deps.db)
  return {
    db: deps.db,
    projectRoot: deps.config.projectRoot ?? process.cwd(),
    llmBaseUrl: deps.modelProcess.baseUrl,
    modelKey: active?.key ?? 'local-model',
    embodiment,
    worldModel: perception.worldModel,
    platformApiUrl: deps.config.platformApiUrl,
    deviceToken: deps.config.deviceToken,
  }
}

export function createHttpServer(deps: ServerDeps) {
  const embodiment = deps.embodiment ?? new EmbodimentStateMachine()
  const perception = deps.perception ?? new PerceptionManager(deps.db)

  return createServer(async (req, res) => {
    applyCors(req, res, deps.config)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    // /health is intentionally unauthenticated -- it's how the frontend
    // shows "AI READY" without already holding the token, and it leaks no
    // project data, only process/model status.
    if (path === '/health' && req.method === 'GET') {
      const active = getActiveModel(deps.db)
      const llmUp = deps.modelProcess.isRunning() && (await isLlmReachable(deps.modelProcess.baseUrl, 1500))
      send(res, 200, {
        status: 'ok',
        runtime: 'local',
        model: active ? { key: active.key, name: active.name } : null,
        llm_reachable: llmUp,
        // Real audit finding: without this, diagnosing "which llama-server
        // process is local-runtime actually talking to" required a second
        // request to /runtime/status -- the endpoint someone would
        // naturally check first (/health) didn't say. That gap is exactly
        // how an independently-started llama-server on a different port
        // (e.g. llama-server's own conventional default, 8080, if it was
        // ever launched by hand outside this runtime) can be mistaken for
        // the one this runtime manages: both answer real requests, so a
        // spot-check against the wrong port still "looks" healthy.
        llm_base_url: deps.modelProcess.baseUrl,
      })
      return
    }

    // Browser pairing: how a plain browser tab (no Electron IPC bridge --
    // e.g. the hosted Control Center) obtains this device's auth token
    // without it ever being baked into a public build. Deliberately also
    // unauthenticated (nothing else to authenticate *with* yet), but not
    // open to just anyone: applyCors() above already only attaches
    // Access-Control-Allow-Origin for a request whose Origin header is in
    // config.allowedOrigins (an exact-match allowlist of official Yahalla
    // origins -- see config.ts). A browser enforces CORS on the caller's
    // side, so a page at any other origin can still send this request, but
    // cannot read the response body back -- only a tab already running at
    // a known Yahalla origin can complete pairing. A direct top-level
    // visit to this URL (no Origin header at all, e.g. typed by hand)
    // still returns the token in plain JSON -- equivalent to opening
    // ~/.yahalla/runtime/config.json directly, i.e. already assumes local
    // machine access.
    if (path === '/pair/token' && req.method === 'GET') {
      send(res, 200, { baseUrl: `http://127.0.0.1:${deps.config.port}`, authToken: deps.config.authToken })
      return
    }

    if (!isAuthorized(req, deps.config)) {
      send(res, 401, { success: false, error: 'Missing or invalid local runtime token.' })
      return
    }

    try {
      if (path === '/hardware' && req.method === 'GET') {
        const hardware = detectHardware()
        return send(res, 200, { hardware, recommended: recommendCatalogEntry(hardware) })
      }

      if (path === '/models' && req.method === 'GET') {
        return send(res, 200, { catalog: MODEL_CATALOG, installed: listModels(deps.db) })
      }

      const registerMatch = path.match(/^\/models\/([^/]+)\/register$/)
      if (registerMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const catalogEntry = MODEL_CATALOG.find((m) => m.key === registerMatch[1])
        const name = String(body.name ?? catalogEntry?.name ?? registerMatch[1])
        const urlStr = String(body.url ?? catalogEntry?.url ?? '')
        const sha256 = typeof body.sha256 === 'string' ? body.sha256 : catalogEntry?.sha256
        return send(res, 200, registerModel(deps.db, registerMatch[1], name, urlStr, sha256))
      }

      const downloadMatch = path.match(/^\/models\/([^/]+)\/download$/)
      if (downloadMatch && req.method === 'POST') {
        const model = await downloadModel(deps.db, downloadMatch[1])
        return send(res, 200, model)
      }

      const activateMatch = path.match(/^\/models\/([^/]+)\/activate$/)
      if (activateMatch && req.method === 'POST') {
        const model = setActiveModel(deps.db, activateMatch[1])
        return send(res, 200, model)
      }

      const deleteMatch = path.match(/^\/models\/([^/]+)$/)
      if (deleteMatch && req.method === 'DELETE') {
        deleteModel(deps.db, deleteMatch[1])
        return send(res, 200, { success: true })
      }

      if (path === '/runtime/start' && req.method === 'POST') {
        const active = getActiveModel(deps.db)
        if (!active?.file_path) {
          return send(res, 400, { success: false, error: 'No active, downloaded model. Download and activate one first.' })
        }
        const binary = findLlamaServerBinary()
        const ctxSize = recommendedContextSize(active.key)
        deps.modelProcess.start(binary, active.file_path, ['--ctx-size', String(ctxSize)])
        const ready = await deps.modelProcess.waitUntilReady(60_000)
        return send(res, ready ? 200 : 504, { success: ready, base_url: deps.modelProcess.baseUrl, ctx_size: ctxSize })
      }

      if (path === '/runtime/stop' && req.method === 'POST') {
        deps.modelProcess.stop()
        return send(res, 200, { success: true })
      }

      if (path === '/runtime/status' && req.method === 'GET') {
        return send(res, 200, {
          running: deps.modelProcess.isRunning(),
          reachable: await isLlmReachable(deps.modelProcess.baseUrl, 1500),
          base_url: deps.modelProcess.baseUrl,
          // Lets the UI tell "no model downloaded/activated yet" apart
          // from "llama-server itself was never installed" -- the first
          // is a normal in-app step, the second needs the user to run
          // scripts/setup-local.sh (or the desktop app's own install
          // flow) once, and the two look identical from "reachable: false"
          // alone.
          llama_server_installed: isLlamaServerInstalled(),
        })
      }

      if (path === '/chat' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const message = String(body.message ?? '')
        if (!message.trim()) return send(res, 400, { success: false, error: 'message is required.' })
        const result = await runChat(ctxFrom(deps, embodiment, perception), message, typeof body.conversation_id === 'string' ? body.conversation_id : undefined)
        return send(res, 200, result)
      }

      // Same as /chat, but emits each content token live over SSE as the
      // model generates it (via agentLoop.ts's onToken, threaded down to
      // llm.ts's chatCompletionStream) instead of waiting for the full
      // answer -- the local-runtime tier's equivalent of the browser
      // tier's already-streaming chat. A `token` frame per delta, then one
      // final `done` frame carrying the exact same ChatResult shape
      // /chat returns (so callers that only care about the final result
      // and not live tokens can ignore the token frames entirely).
      if (path === '/chat/stream' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const message = String(body.message ?? '')
        if (!message.trim()) return send(res, 400, { success: false, error: 'message is required.' })

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const result = await runChat(
          ctxFrom(deps, embodiment, perception),
          message,
          typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          (delta) => res.write(`data: ${JSON.stringify({ kind: 'token', delta })}\n\n`),
        )
        res.write(`data: ${JSON.stringify({ kind: 'done', ...result })}\n\n`)
        res.end()
        return
      }

      const approvalMatch = path.match(/^\/approvals\/([^/]+)\/decide$/)
      if (approvalMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const decision = body.decision === 'reject' ? 'reject' : 'approve'
        const result = await resumeApproval(ctxFrom(deps, embodiment, perception), approvalMatch[1], decision)
        return send(res, 200, result)
      }

      if (path === '/approvals' && req.method === 'GET') {
        const rows = deps.db.prepare('SELECT id, task_id, tool_key, arguments, status, reason, result, created_at, decided_at FROM approvals ORDER BY created_at DESC LIMIT 50').all()
        return send(res, 200, { approvals: rows })
      }

      if (path === '/conversations' && req.method === 'GET') {
        const rows = deps.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50').all()
        return send(res, 200, { conversations: rows })
      }

      const messagesMatch = path.match(/^\/conversations\/([^/]+)\/messages$/)
      if (messagesMatch && req.method === 'GET') {
        const rows = deps.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(messagesMatch[1])
        return send(res, 200, { messages: rows })
      }

      if (path === '/tasks' && req.method === 'GET') {
        const rows = deps.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50').all()
        return send(res, 200, { tasks: rows })
      }

      // Remote command dispatch (task #78-81): pairs this machine against a
      // platform-api deployment so a task created from any browser/device
      // can be routed here and run through this machine's own agentLoop
      // (see taskPoller.ts). The pairing code itself comes from the web
      // Control Center's "Pair a device" flow -- this endpoint only ever
      // consumes a code, it never issues one.
      if (path === '/device/pair' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const platformApiUrl = String(body.platform_api_url ?? '').trim()
        const code = String(body.code ?? '').trim()
        const deviceName = String(body.device_name ?? 'Yahalla Device').trim()
        if (!platformApiUrl || !code) {
          return send(res, 400, { success: false, error: 'platform_api_url and code are required.' })
        }
        try {
          const result = await pairDevice(platformApiUrl, code, deviceName)
          deps.config.platformApiUrl = platformApiUrl
          deps.config.deviceToken = result.token
          saveConfig(deps.config)
          deps.restartTaskPoller?.()
          return send(res, 200, { success: true, device_id: result.deviceId, device_name: result.deviceName })
        } catch (error) {
          return send(res, 502, { success: false, error: error instanceof Error ? error.message : 'Pairing failed.' })
        }
      }

      if (path === '/device/unpair' && req.method === 'POST') {
        delete deps.config.platformApiUrl
        delete deps.config.deviceToken
        saveConfig(deps.config)
        deps.restartTaskPoller?.()
        return send(res, 200, { success: true })
      }

      if (path === '/device/status' && req.method === 'GET') {
        return send(res, 200, {
          paired: Boolean(deps.config.platformApiUrl && deps.config.deviceToken),
          platform_api_url: deps.config.platformApiUrl ?? null,
        })
      }

      if (path === '/memory' && req.method === 'GET') {
        return send(res, 200, { memory: listMemory(deps.db) })
      }
      if (path === '/memory' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return send(res, 200, addMemory(deps.db, String(body.content ?? ''), { scope: body.scope as string, key: body.key as string, importance: body.importance as number }))
      }

      if (path === '/knowledge' && req.method === 'GET') {
        return send(res, 200, { knowledge: listKnowledge(deps.db) })
      }
      if (path === '/knowledge' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return send(res, 200, addKnowledge(deps.db, String(body.title ?? ''), String(body.content ?? '')))
      }

      if (path === '/skills' && req.method === 'GET') {
        return send(res, 200, { skills: listSkills(deps.db) })
      }

      if (path === '/preferences' && req.method === 'GET') {
        return send(res, 200, { preferences: listPreferences(deps.db) })
      }
      if (path === '/preferences' && req.method === 'POST') {
        const body = await readJsonBody(req)
        setPreference(deps.db, String(body.key ?? ''), body.value)
        return send(res, 200, { success: true })
      }

      // GitHub integration (task #82: Integrations Hub): agentLoop's
      // github.read/github.write tools already read the 'github_token'
      // preference (see agentLoop.ts), but there was never a UI path to
      // set it -- setting it required either the generic /preferences
      // endpoint (which round-trips the raw secret back on every GET) or
      // hand-editing the local SQLite file. This validates the token
      // against GitHub itself before storing it (so a typo/expired token
      // never gets silently saved as "connected"), and never returns the
      // raw token back to the caller -- only whether it's configured and,
      // if so, the connected username, mirroring how the Cloud Tier
      // status endpoint on platform-api never echoes back its own key.
      if (path === '/integrations/github' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const token = String(body.token ?? '').trim()
        if (!token) return send(res, 400, { success: false, error: 'A GitHub Personal Access Token is required.' })
        try {
          const response = await fetch(`${githubApiBase()}/user`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'yahalla-ai-os-local-runtime' },
          })
          if (!response.ok) {
            return send(res, 400, { success: false, error: response.status === 401 ? 'GitHub rejected this token -- check it was copied correctly and has not expired.' : `GitHub API returned HTTP ${response.status}.` })
          }
          const user = (await response.json()) as { login?: string }
          setPreference(deps.db, 'github_token', token)
          setPreference(deps.db, 'github_username', user.login ?? null)
          return send(res, 200, { success: true, username: user.login ?? null })
        } catch (error) {
          return send(res, 502, { success: false, error: error instanceof Error ? error.message : 'Could not reach GitHub to validate the token.' })
        }
      }

      if (path === '/integrations/github' && req.method === 'DELETE') {
        setPreference(deps.db, 'github_token', null)
        setPreference(deps.db, 'github_username', null)
        return send(res, 200, { success: true })
      }

      if (path === '/integrations/github/status' && req.method === 'GET') {
        const token = getPreference<string | null>(deps.db, 'github_token')
        const username = getPreference<string | null>(deps.db, 'github_username')
        return send(res, 200, { configured: Boolean(token), username: token ? username ?? null : null })
      }

      // Database connector (Integrations Hub): connecting validates with a
      // real SELECT 1 before storing anything (see database.ts), and the
      // connection string is never returned back once saved -- only name,
      // id, and creation time. The db_query/db_execute/db_list_connections
      // tools (agentLoop.ts) are what actually use these once connected.
      if (path === '/integrations/database' && req.method === 'GET') {
        return send(res, 200, { connections: listDatabaseConnections(deps.db) })
      }

      if (path === '/integrations/database' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const name = String(body.name ?? '').trim()
        const connectionString = String(body.connection_string ?? '').trim()
        if (!name || !connectionString) {
          return send(res, 400, { success: false, error: 'name and connection_string are required.' })
        }
        try {
          const connection = await addDatabaseConnection(deps.db, name, connectionString)
          return send(res, 200, { success: true, connection })
        } catch (error) {
          return send(res, 400, { success: false, error: error instanceof Error ? error.message : 'Could not connect to that database.' })
        }
      }

      const databaseDeleteMatch = path.match(/^\/integrations\/database\/([^/]+)$/)
      if (databaseDeleteMatch && req.method === 'DELETE') {
        const removed = removeDatabaseConnection(deps.db, databaseDeleteMatch[1]!)
        if (!removed) return send(res, 404, { success: false, error: 'Unknown database connection.' })
        return send(res, 200, { success: true })
      }

      if (path === '/permissions' && req.method === 'GET') {
        return send(res, 200, { permissions: listPermissions(deps.db) })
      }
      if (path === '/permissions/grant' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const row = grantPermission(
          deps.db,
          body.scope as PermissionScope,
          String(body.target ?? '*'),
          body.access as AccessLevel,
        )
        return send(res, 200, row)
      }
      if (path === '/permissions/revoke' && req.method === 'POST') {
        const body = await readJsonBody(req)
        revokePermission(deps.db, body.scope as PermissionScope, String(body.target ?? '*'))
        return send(res, 200, { success: true })
      }
      if (path === '/permissions/check' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') as PermissionScope
        const target = url.searchParams.get('target') ?? '*'
        const access = (url.searchParams.get('access') ?? 'read') as AccessLevel
        return send(res, 200, { allowed: checkAccess(deps.db, scope, target, access) })
      }

      // The one-time "trust this project folder" step referenced by
      // permissions.ts's grantPermission comment, but that (until now) no
      // caller anywhere in this repo actually implemented -- meaning every
      // project-scoped tool (get_project_overview, read_project_file, ...)
      // was permission-denied on every fresh install with no way to fix it
      // short of hand-crafting a /permissions/grant call with a target that
      // happened to exactly match this process's resolved project root.
      // These two routes always resolve the target from the server's own
      // ctxFrom() rather than trusting a client-supplied path, so the
      // granted permission's target can never drift from what
      // checkAccess() actually looks up during tool execution.
      if (path === '/project/status' && req.method === 'GET') {
        const ctx = ctxFrom(deps, embodiment, perception)
        return send(res, 200, {
          projectRoot: ctx.projectRoot,
          trusted: checkAccess(deps.db, 'project', ctx.projectRoot, 'read'),
        })
      }
      if (path === '/project/trust' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const access: AccessLevel = body.access === 'read' ? 'read' : 'write'
        const ctx = ctxFrom(deps, embodiment, perception)
        const permission = grantPermission(deps.db, 'project', ctx.projectRoot, access)
        return send(res, 200, { success: true, projectRoot: ctx.projectRoot, permission })
      }

      // Real, code-enforced permission tiers (see roles.ts): GET is always
      // allowed (a normal-role session can see its own role), but POST is
      // itself role-gated -- only an owner/trainer session can change the
      // device's role, so a normal-role session can never promote itself
      // by calling this endpoint directly, the same as it cannot promote
      // itself through chat.
      if (path === '/role' && req.method === 'GET') {
        return send(res, 200, { role: getDeviceRole(deps.db) })
      }
      if (path === '/role' && req.method === 'POST') {
        const currentRole = getDeviceRole(deps.db)
        if (!canChangeRole(currentRole)) {
          return send(res, 403, { success: false, error: `The "${currentRole}" role cannot change this device's role. Only owner/trainer can.` })
        }
        const body = await readJsonBody(req)
        const nextRole = body.role as DeviceRole
        if (nextRole !== 'normal' && nextRole !== 'owner' && nextRole !== 'trainer') {
          return send(res, 400, { success: false, error: 'role must be one of: normal, owner, trainer.' })
        }
        setDeviceRole(deps.db, nextRole)
        return send(res, 200, { success: true, role: nextRole })
      }

      if (path === '/perception/providers' && req.method === 'GET') {
        return send(res, 200, { providers: perception.listProviders() })
      }

      if (path === '/perception/start' && req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          const { sessionId } = await perception.start(String(body.provider ?? 'mock'))
          return send(res, 200, { success: true, sessionId })
        } catch (error) {
          if (error instanceof PermissionRequiredError) {
            embodiment.transition('NEEDS_PERMISSION', `Camera/microphone permission needed (${error.modality})`)
            return send(res, 403, { success: false, error: error.message, modality: error.modality })
          }
          throw error
        }
      }

      if (path === '/perception/stop' && req.method === 'POST') {
        await perception.stop()
        return send(res, 200, { success: true })
      }

      if (path === '/perception/status' && req.method === 'GET') {
        return send(res, 200, perception.status())
      }

      if (path === '/perception/world-model' && req.method === 'GET') {
        return send(res, 200, perception.worldModel.getSnapshot())
      }

      if (path === '/perception/history' && req.method === 'DELETE') {
        perception.clearHistory()
        return send(res, 200, { success: true })
      }

      // Ingestion point for a real external capture source (a future
      // browser/native provider that runs its own local vision/speech
      // model and only ever sends already-derived events here -- never
      // raw frames/audio). Still gated by an active, permitted session.
      if (path === '/perception/events' && req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          perception.ingest(body as any)
          return send(res, 200, { success: true })
        } catch (error) {
          return send(res, 409, { success: false, error: error instanceof Error ? error.message : 'Could not ingest event.' })
        }
      }

      // One SSE stream carrying both perception events and embodiment
      // state/status updates, so the frontend has a single live channel
      // for "what is Yahalla observing" and "what is Yahalla doing".
      if (path === '/live/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ kind: 'embodiment', ...embodiment.getState() })}\n\n`)

        const offPerception = perception.bus.onEvent((event) => {
          res.write(`data: ${JSON.stringify({ kind: 'perception', event })}\n\n`)
        })
        const offEmbodiment = embodiment.onUpdate((update) => {
          res.write(`data: ${JSON.stringify({ kind: 'embodiment', ...update })}\n\n`)
        })
        req.on('close', () => {
          offPerception()
          offEmbodiment()
        })
        return
      }

      send(res, 404, { success: false, error: `No route for ${req.method} ${path}` })
    } catch (error) {
      send(res, 500, { success: false, error: error instanceof Error ? error.message : 'Internal error.' })
    }
  })
}
