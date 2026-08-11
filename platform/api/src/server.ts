import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getPool, withUserSession } from './db.js'
import { verifyJwt } from './jwt.js'
import { authenticateDevice, createPairingCode, exchangePairingCode, recordHeartbeat } from './pairing.js'

export type PlatformConfig = {
  port: number
  supabaseJwtSecret: string
  allowedOrigins: string[]
}

type Identity = { userId: string; kind: 'human' | 'device' }

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

function applyCors(req: IncomingMessage, res: ServerResponse, config: PlatformConfig): void {
  const origin = req.headers.origin
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

// A human request carries the Supabase-issued JWT (three dot-separated
// parts); a paired device carries the opaque bearer token minted at pairing
// time (pairing.ts). Both arrive the same way (Authorization: Bearer ...);
// this is the one place that tells them apart.
async function resolveIdentity(req: IncomingMessage, config: PlatformConfig): Promise<Identity | null> {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)

  if (token.split('.').length === 3) {
    try {
      const claims = verifyJwt(token, config.supabaseJwtSecret)
      return { userId: claims.sub, kind: 'human' }
    } catch {
      return null
    }
  }

  const device = await authenticateDevice(token)
  return device ? { userId: device.authUserId, kind: 'device' } : null
}

export function createPlatformServer(config: PlatformConfig) {
  return createServer(async (req, res) => {
    applyCors(req, res, config)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/health' && req.method === 'GET') {
      try {
        await getPool().query('SELECT 1')
        return send(res, 200, { status: 'ok', service: 'platform-api' })
      } catch (error) {
        return send(res, 503, { status: 'error', error: error instanceof Error ? error.message : 'DB unreachable' })
      }
    }

    try {
      if (path === '/device_exchange' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = await exchangePairingCode(
          String(body.code ?? ''),
          String(body.device_name ?? ''),
          String(body.platform ?? 'other'),
        )
        return send(res, 200, { success: true, device_id: result.deviceId, device_name: result.deviceName, token: result.token })
      }

      const identity = await resolveIdentity(req, config)
      if (!identity) {
        return send(res, 401, { success: false, error: 'Missing or invalid credentials.' })
      }

      if (path === '/pair_device' && req.method === 'POST' && identity.kind === 'human') {
        const body = await readJsonBody(req)
        const { code, expiresAt } = await createPairingCode(identity.userId, typeof body.device_name === 'string' ? body.device_name : undefined)
        return send(res, 200, { success: true, pairing_code: code, expires_at: expiresAt })
      }

      if (path === '/device_heartbeat' && req.method === 'POST' && identity.kind === 'device') {
        const body = await readJsonBody(req)
        await withUserSession(identity.userId, async (client) => {
          const { rows } = await client.query('SELECT id FROM devices WHERE auth_user_id = $1', [identity.userId])
          const deviceId = rows[0]?.id
          if (deviceId) {
            await recordHeartbeat(client, deviceId, typeof body.capabilities === 'object' ? (body.capabilities as Record<string, unknown>) : undefined)
          }
        })
        return send(res, 200, { success: true })
      }

      if (path === '/devices' && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) => client.query('SELECT * FROM devices ORDER BY created_at DESC'))
        return send(res, 200, { devices: rows.rows })
      }

      if (path === '/tasks' && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) =>
          client.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50'),
        )
        return send(res, 200, { tasks: rows.rows })
      }

      if (path === '/approvals' && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) =>
          client.query('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50'),
        )
        return send(res, 200, { approvals: rows.rows })
      }

      const approvalMatch = path.match(/^\/approvals\/([^/]+)\/decide$/)
      if (approvalMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const decision = body.decision === 'reject' ? 'rejected' : 'approved'
        const changed = await withUserSession(identity.userId, (client) =>
          client.query(
            "UPDATE approvals SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3 AND status = 'pending' RETURNING id",
            [decision, identity.userId, approvalMatch[1]],
          ),
        )
        if (changed.rowCount === 0) {
          return send(res, 409, { success: false, error: 'Approval was already decided or does not exist.' })
        }
        return send(res, 200, { success: true, status: decision })
      }

      // Self-evolving agents propose a code change here (diff + git_ref);
      // it never ships on its own. RLS (is_admin(), see the
      // deployment_proposals migration) is the only enforcement of who may
      // see or decide these -- this route does not re-check admin status
      // itself, same division of responsibility as /approvals above.
      if (path === '/deployments' && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) =>
          client.query('SELECT * FROM deployment_proposals ORDER BY created_at DESC LIMIT 50'),
        )
        return send(res, 200, { deployments: rows.rows })
      }

      if (path === '/deployments' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const title = String(body.title ?? '')
        const gitRef = String(body.git_ref ?? '')
        const diff = String(body.diff ?? '')
        if (!title || !gitRef || !diff) {
          return send(res, 400, { success: false, error: 'title, git_ref, and diff are required.' })
        }
        const created = await withUserSession(identity.userId, (client) =>
          client.query(
            `INSERT INTO deployment_proposals (title, description, git_ref, base_ref, diff, proposed_by, proposed_by_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
              title,
              typeof body.description === 'string' ? body.description : null,
              gitRef,
              typeof body.base_ref === 'string' ? body.base_ref : 'main',
              diff,
              identity.userId,
              typeof body.proposed_by_agent === 'string' ? body.proposed_by_agent : null,
            ],
          ),
        )
        return send(res, 200, { success: true, deployment: created.rows[0] })
      }

      const deploymentMatch = path.match(/^\/deployments\/([^/]+)\/decide$/)
      if (deploymentMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const decision = body.decision === 'reject' ? 'rejected' : 'approved'
        const changed = await withUserSession(identity.userId, (client) =>
          client.query(
            "UPDATE deployment_proposals SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3 AND status = 'pending' RETURNING id",
            [decision, identity.userId, deploymentMatch[1]],
          ),
        )
        if (changed.rowCount === 0) {
          return send(res, 409, { success: false, error: 'Deployment proposal was already decided or does not exist.' })
        }
        return send(res, 200, { success: true, status: decision })
      }

      send(res, 404, { success: false, error: `No route for ${req.method} ${path}` })
    } catch (error) {
      send(res, 500, { success: false, error: error instanceof Error ? error.message : 'Internal error.' })
    }
  })
}
