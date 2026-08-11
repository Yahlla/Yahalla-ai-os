import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resumeApproval, runChat, type RuntimeContext } from './agentLoop.js'
import type { RuntimeConfig } from './config.js'
import type { Db } from './db.js'
import { detectHardware } from './hardware.js'
import { findLlamaServerBinary, isLlmReachable, LocalModelProcess } from './llm.js'
import {
  addKnowledge,
  addMemory,
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
  registerModel,
  setActiveModel,
} from './modelManager.js'
import { checkAccess, grantPermission, listPermissions, revokePermission, type AccessLevel, type PermissionScope } from './permissions.js'

export type ServerDeps = {
  db: Db
  config: RuntimeConfig
  modelProcess: LocalModelProcess
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

function ctxFrom(deps: ServerDeps): RuntimeContext {
  const active = getActiveModel(deps.db)
  return {
    db: deps.db,
    projectRoot: deps.config.projectRoot ?? process.cwd(),
    llmBaseUrl: deps.modelProcess.baseUrl,
    modelKey: active?.key ?? 'local-model',
  }
}

export function createHttpServer(deps: ServerDeps) {
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
      })
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
        deps.modelProcess.start(binary, active.file_path)
        const ready = await deps.modelProcess.waitUntilReady(60_000)
        return send(res, ready ? 200 : 504, { success: ready, base_url: deps.modelProcess.baseUrl })
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
        })
      }

      if (path === '/chat' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const message = String(body.message ?? '')
        if (!message.trim()) return send(res, 400, { success: false, error: 'message is required.' })
        const result = await runChat(ctxFrom(deps), message, typeof body.conversation_id === 'string' ? body.conversation_id : undefined)
        return send(res, 200, result)
      }

      const approvalMatch = path.match(/^\/approvals\/([^/]+)\/decide$/)
      if (approvalMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const decision = body.decision === 'reject' ? 'reject' : 'approve'
        const result = await resumeApproval(ctxFrom(deps), approvalMatch[1], decision)
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

      send(res, 404, { success: false, error: `No route for ${req.method} ${path}` })
    } catch (error) {
      send(res, 500, { success: false, error: error instanceof Error ? error.message : 'Internal error.' })
    }
  })
}
