import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { callCloudTier, resolveCloudTierConfig, type CloudTierConfig } from './cloudTier.js'
import { getPool, withServiceRole, withUserSession } from './db.js'
import { proposeLatestDeployment, verifyGithubWebhookSignature } from './deployments.js'
import { verifyJwt } from './jwt.js'
import { toVectorLiteral, validateEmbedding } from './memory.js'
import { authenticateDevice, createPairingCode, ensureHumanUser, exchangePairingCode, recordHeartbeat } from './pairing.js'
import { getCloudTierStatus, saveCloudTierSettings } from './settings.js'

export type PlatformConfig = {
  port: number
  // Supabase projects sign tokens with HS256 (a shared secret) or ES256
  // (a managed keypair, verified via the project's public JWKS) -- see
  // jwt.ts for why both are supported. A deployment only needs whichever
  // one its actual Supabase project uses.
  supabaseJwtSecret?: string
  supabaseUrl?: string
  allowedOrigins: string[]
  cloudTier: CloudTierConfig | null
  // owner/repo used by POST /deployments/propose_latest and the push
  // webhook to fetch the real latest-main commit + diff from GitHub's
  // public API. Defaults to this project's own repo.
  githubRepo?: string
  // Secret configured on the GitHub repo's webhook (Settings -> Webhooks).
  // Required to accept POST /webhooks/github -- without it the endpoint
  // stays disabled (404) rather than accepting unverifiable requests.
  githubWebhookSecret?: string
}

type Identity = { userId: string; kind: 'human' | 'device' }

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
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
      const claims = await verifyJwt(token, { hs256Secret: config.supabaseJwtSecret, supabaseUrl: config.supabaseUrl })
      await ensureHumanUser(claims.sub, typeof claims.email === 'string' ? claims.email : undefined)
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

      // GitHub calls this directly on every push -- it has no Supabase JWT
      // or device pairing token, so it can't go through resolveIdentity like
      // every other route below. Its only credential is the HMAC signature
      // GitHub computes over the raw body with the shared webhook secret
      // (verifyGithubWebhookSignature), which is why the body must be read
      // as raw bytes here rather than via readJsonBody. This is the
      // permanent replacement for manually clicking "Ship latest main":
      // every push to main now queues a pending proposal on its own: a
      // human still has to click Approve & Ship, same as any other
      // proposal, so nothing reaches live production without that click.
      if (path === '/webhooks/github' && req.method === 'POST') {
        if (!config.githubWebhookSecret) {
          return send(res, 404, { success: false, error: 'GitHub webhook not configured on this deployment.' })
        }
        const raw = await readRawBody(req)
        const signature = req.headers['x-hub-signature-256']
        if (!verifyGithubWebhookSignature(raw, typeof signature === 'string' ? signature : undefined, config.githubWebhookSecret)) {
          return send(res, 401, { success: false, error: 'Invalid webhook signature.' })
        }

        const event = req.headers['x-github-event']
        let payload: { ref?: string }
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          return send(res, 400, { success: false, error: 'Invalid JSON payload.' })
        }

        if (event !== 'push' || payload.ref !== 'refs/heads/main') {
          return send(res, 200, { success: true, ignored: true })
        }

        const githubRepo = config.githubRepo ?? 'Yahlla/Yahalla-ai-os'
        const result = await withServiceRole((client) =>
          proposeLatestDeployment(githubRepo, (text, params) => client.query(text, params), null, 'github-webhook'),
        )
        if (result.outcome === 'github_unreachable') {
          return send(res, 502, { success: false, error: `Could not reach GitHub to check the latest commit on ${result.repo}.` })
        }
        return send(res, 200, { success: true, ...result })
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

      // Real device task dispatch: a human creates a task addressed to
      // their own paired device (auto-picked if they have exactly one
      // online), the device polls /tasks/next to atomically claim the
      // oldest queued one assigned to it (FOR UPDATE SKIP LOCKED --safe
      // even if a device somehow polls twice concurrently), executes it
      // with its own real file/git/tool access, and reports the result
      // to /tasks/:id/complete. RLS (assigned_device = current_device_id())
      // is what actually enforces a device only ever sees/updates its own
      // tasks -- this handler leans on that rather than re-checking it in
      // application code.
      if (path === '/tasks' && req.method === 'POST') {
        if (identity.kind !== 'human') return send(res, 403, { success: false, error: 'Only a human can create a task.' })
        const body = await readJsonBody(req)
        const title = String(body.title ?? '').trim()
        if (!title) return send(res, 400, { success: false, error: 'title is required.' })

        const outcome = await withUserSession(identity.userId, async (client) => {
          let deviceId = typeof body.device_id === 'string' ? body.device_id : null
          if (!deviceId) {
            const { rows: devices } = await client.query<{ id: string; name: string }>(
              "SELECT id, name FROM devices WHERE owner_id = $1 AND status = 'online' AND revoked_at IS NULL",
              [identity.userId],
            )
            if (devices.length === 0) {
              return { error: 'No paired, online device found. Pair a device (Devices page) and make sure it is running.' }
            }
            if (devices.length > 1) {
              return { error: `Multiple online devices -- specify device_id: ${devices.map((d) => `${d.name} (${d.id})`).join(', ')}` }
            }
            deviceId = devices[0]!.id
          }
          const { rows } = await client.query(
            `INSERT INTO tasks (title, description, status, requested_by, assigned_device, input)
             VALUES ($1, $2, 'queued', $3, $4, $5) RETURNING *`,
            [title, typeof body.description === 'string' ? body.description : null, identity.userId, deviceId, JSON.stringify(body.input ?? {})],
          )
          return { task: rows[0] }
        })
        if ('error' in outcome) return send(res, 409, { success: false, error: outcome.error })
        return send(res, 200, { success: true, task: outcome.task })
      }

      if (path === '/tasks/next' && req.method === 'GET') {
        if (identity.kind !== 'device') return send(res, 403, { success: false, error: 'Only a paired device can claim tasks.' })
        const { rows } = await withUserSession(identity.userId, (client) =>
          client.query(
            `UPDATE tasks SET status = 'running', started_at = now(), updated_at = now()
             WHERE id = (SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
             RETURNING *`,
          ),
        )
        return send(res, 200, { task: rows[0] ?? null })
      }

      const taskCompleteMatch = path.match(/^\/tasks\/([^/]+)\/complete$/)
      if (taskCompleteMatch && req.method === 'POST') {
        if (identity.kind !== 'device') return send(res, 403, { success: false, error: 'Only a paired device can complete tasks.' })
        const body = await readJsonBody(req)
        const status = body.status === 'failed' ? 'failed' : 'completed'
        const { rows } = await withUserSession(identity.userId, (client) =>
          client.query(
            `UPDATE tasks SET status = $2, output = $3, error = $4, completed_at = now(), updated_at = now()
             WHERE id = $1 RETURNING *`,
            [taskCompleteMatch[1], status, JSON.stringify(body.output ?? {}), body.error ? JSON.stringify(body.error) : null],
          ),
        )
        if (rows.length === 0) return send(res, 404, { success: false, error: 'Task not found or not assigned to this device.' })
        return send(res, 200, { success: true, task: rows[0] })
      }

      // Lets the human who created a task (chat composer task dispatch,
      // see task #80) poll it to completion. RLS's "Users can read their
      // own requested tasks" policy (requested_by = auth.uid()) is what
      // actually scopes this to the caller's own tasks.
      const taskGetMatch = path.match(/^\/tasks\/([^/]+)$/)
      if (taskGetMatch && req.method === 'GET') {
        const { rows } = await withUserSession(identity.userId, (client) => client.query('SELECT * FROM tasks WHERE id = $1', [taskGetMatch[1]]))
        if (rows.length === 0) return send(res, 404, { success: false, error: 'Task not found.' })
        return send(res, 200, { success: true, task: rows[0] })
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

      // Zero-terminal "ship the latest code" button: no human has to know
      // git or construct a diff by hand. Fetches the real latest commit on
      // main and a real diff against whatever was last actually deployed
      // (both from GitHub's public API, server-side so there's no CORS
      // concern) and proposes it -- still requires the normal Approve &
      // Ship click below before deploy-agent picks it up.
      if (path === '/deployments/propose_latest' && req.method === 'POST') {
        if (identity.kind !== 'human') return send(res, 403, { success: false, error: 'Only a human can propose a deployment.' })

        const githubRepo = config.githubRepo ?? 'Yahlla/Yahalla-ai-os'
        const result = await withUserSession(identity.userId, (client) =>
          proposeLatestDeployment(githubRepo, (text, params) => client.query(text, params), identity.userId, null),
        )
        if (result.outcome === 'github_unreachable') {
          return send(res, 502, { success: false, error: `Could not reach GitHub to check the latest commit on ${result.repo}.` })
        }
        if (result.outcome === 'up_to_date') {
          return send(res, 200, { success: true, up_to_date: true, message: 'Already up to date -- the last deployment already shipped this exact commit.' })
        }
        return send(res, 200, { success: true, deployment: result.deployment })
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

      // Conversation persistence -- chat history lives on Strato (the
      // conversations/conversation_messages tables and their RLS policies
      // already exist verbatim from supabase/migrations, applied to this
      // self-hosted DB the same way as everything else), not only in the
      // browser tab's React state, so it survives a reload or a different
      // device signing into the same account. Storing text is ordinary,
      // cheap work -- nothing here is a model call.
      if (path === '/conversations' && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) =>
          client.query(
            "SELECT * FROM conversations WHERE status <> 'deleted' ORDER BY updated_at DESC LIMIT 50",
          ),
        )
        return send(res, 200, { conversations: rows.rows })
      }

      if (path === '/conversations' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const created = await withUserSession(identity.userId, (client) =>
          client.query(
            `INSERT INTO conversations (owner_id, project_id, title)
             VALUES ($1, $2, $3) RETURNING *`,
            [
              identity.userId,
              typeof body.project_id === 'string' ? body.project_id : null,
              typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New conversation',
            ],
          ),
        )
        return send(res, 200, { success: true, conversation: created.rows[0] })
      }

      const conversationMessagesMatch = path.match(/^\/conversations\/([^/]+)\/messages$/)
      if (conversationMessagesMatch && req.method === 'GET') {
        const rows = await withUserSession(identity.userId, (client) =>
          client.query(
            'SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500',
            [conversationMessagesMatch[1]],
          ),
        )
        return send(res, 200, { messages: rows.rows })
      }

      if (conversationMessagesMatch && req.method === 'POST') {
        const body = await readJsonBody(req)
        const role = String(body.role ?? '')
        if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
          return send(res, 400, { success: false, error: 'role must be one of user, assistant, system, tool.' })
        }
        const conversationId = conversationMessagesMatch[1]
        const created = await withUserSession(identity.userId, async (client) => {
          // Checked explicitly (rather than letting a mismatched id hit
          // conversation_messages' RLS WITH CHECK) so an unowned or
          // nonexistent conversation gets a clean 404 instead of a raw
          // RLS-violation exception -- INSERT's WITH CHECK throws on
          // failure, it doesn't just return zero rows the way this
          // UPDATE's USING clause does. Doing the ownership check and the
          // insert in the same transaction also means the insert's own
          // WITH CHECK is guaranteed to pass once we get this far.
          const owned = await client.query(
            "UPDATE conversations SET updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING id",
            [conversationId],
          )
          if (owned.rowCount === 0) return null
          return client.query(
            `INSERT INTO conversation_messages (conversation_id, role, content, tool_activity, metadata)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [
              conversationId,
              role,
              typeof body.content === 'string' ? body.content : '',
              JSON.stringify(Array.isArray(body.tool_activity) ? body.tool_activity : []),
              JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
            ],
          )
        })
        if (!created) {
          return send(res, 404, { success: false, error: 'Conversation not found.' })
        }
        return send(res, 200, { success: true, message: created.rows[0] })
      }

      // Central, cross-device semantic memory -- the embedding itself is
      // computed on the caller's own device (browser/local-runtime) and
      // sent here as a plain float array; this route only ever stores and
      // searches vectors via pgvector, it never runs a model. That split
      // is what keeps this appropriate for a resource-modest coordination
      // server.
      if (path === '/memory' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const content = String(body.content ?? '')
        if (!content.trim()) return send(res, 400, { success: false, error: 'content is required.' })

        let embedding: number[]
        try {
          embedding = validateEmbedding(body.embedding)
        } catch (error) {
          return send(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid embedding.' })
        }

        const source = typeof body.source === 'string' ? body.source : 'agent'
        const created = await withUserSession(identity.userId, (client) =>
          client.query(
            `INSERT INTO memory_entries (owner_id, project_id, source, content, embedding, metadata)
             VALUES ($1, $2, $3, $4, $5::vector, $6) RETURNING id, owner_id, project_id, source, content, metadata, created_at`,
            [
              identity.userId,
              typeof body.project_id === 'string' ? body.project_id : null,
              source,
              content,
              toVectorLiteral(embedding),
              JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
            ],
          ),
        )
        return send(res, 200, { success: true, entry: created.rows[0] })
      }

      if (path === '/memory/search' && req.method === 'POST') {
        const body = await readJsonBody(req)
        let embedding: number[]
        try {
          embedding = validateEmbedding(body.embedding)
        } catch (error) {
          return send(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid embedding.' })
        }
        const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50)
        const projectId = typeof body.project_id === 'string' ? body.project_id : null

        const rows = await withUserSession(identity.userId, (client) =>
          client.query(
            `SELECT id, project_id, source, content, metadata, created_at,
                    1 - (embedding <=> $1::vector) AS similarity
             FROM memory_entries
             WHERE ($2::uuid IS NULL OR project_id = $2::uuid)
             ORDER BY embedding <=> $1::vector
             LIMIT $3`,
            [toVectorLiteral(embedding), projectId, limit],
          ),
        )
        return send(res, 200, { results: rows.rows })
      }

      if (path === '/memory' && req.method === 'GET') {
        const projectId = url.searchParams.get('project_id')
        const rows = await withUserSession(identity.userId, (client) =>
          projectId
            ? client.query(
                'SELECT id, project_id, source, content, metadata, created_at FROM memory_entries WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50',
                [projectId],
              )
            : client.query(
                'SELECT id, project_id, source, content, metadata, created_at FROM memory_entries ORDER BY created_at DESC LIMIT 50',
              ),
        )
        return send(res, 200, { entries: rows.rows })
      }

      // Opt-in cloud smart tier -- see cloudTier.ts for why this lives here
      // (server-side only, key never sent to the browser) rather than in
      // local-runtime or the frontend. Any authenticated user of this
      // platform can call it; there is no separate opt-in flag on the user
      // record because the tier as a whole is already opt-in at the
      // deployment level (nothing configured, neither in the database nor
      // CLOUD_TIER_API_KEY, = route always 503s).
      if (path === '/smart-tier/chat' && req.method === 'POST') {
        const cloudTier = await resolveCloudTierConfig(config.cloudTier)
        if (!cloudTier) {
          return send(res, 503, { success: false, error: 'Cloud smart tier is not configured on this deployment.' })
        }
        const body = await readJsonBody(req)
        const messages = Array.isArray(body.messages) ? body.messages : null
        if (!messages || messages.some((m) => typeof m?.role !== 'string' || typeof m?.content !== 'string')) {
          return send(res, 400, { success: false, error: 'messages must be an array of {role, content}.' })
        }
        const result = await callCloudTier(cloudTier, messages)
        if (!result.ok) {
          return send(res, result.status, { success: false, error: result.error })
        }
        return send(res, 200, { success: true, content: result.content, model: cloudTier.model })
      }

      // Admin-only settings for the cloud smart tier, backed by the
      // platform_settings table (RLS-gated to is_admin()) rather than an
      // env file -- this is what lets the Control Center's Settings page
      // configure it with no terminal step. The raw key is write-only:
      // GET never returns it, only whether one is currently set.
      if (path === '/settings/cloud-tier' && req.method === 'GET') {
        const status = await getCloudTierStatus(identity.userId)
        return send(res, 200, status)
      }

      if (path === '/settings/cloud-tier' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
        if (!apiKey) return send(res, 400, { success: false, error: 'api_key is required.' })
        const provider = body.provider === 'anthropic' ? 'anthropic' : body.provider === 'openai' ? 'openai' : undefined
        try {
          await saveCloudTierSettings(identity.userId, {
            apiKey,
            url: typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined,
            model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
            provider,
          })
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          if (code === '42501') {
            return send(res, 403, { success: false, error: 'Only an admin can change platform settings.' })
          }
          throw error
        }
        return send(res, 200, { success: true })
      }

      send(res, 404, { success: false, error: `No route for ${req.method} ${path}` })
    } catch (error) {
      send(res, 500, { success: false, error: error instanceof Error ? error.message : 'Internal error.' })
    }
  })
}
