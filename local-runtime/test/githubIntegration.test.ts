import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { PerceptionManager } from '../src/perception/manager.js'
import type { RuntimeConfig } from '../src/config.js'
import type { Db } from '../src/db.js'
import { openDb } from '../src/db.js'
import { createHttpServer } from '../src/server.js'
import { LocalModelProcess } from '../src/llm.js'
import { getPreference } from '../src/memory.js'

// Stands in for api.github.com: /user validates a bearer token (used by
// the /integrations/github connect route), /user/repos lists repos for a
// valid token (used by the actual github.read tool, proving the whole
// chain -- connect, then agentLoop uses what was connected -- really works,
// not just that the two halves look compatible on paper).
function startFakeGithub(port: number): Promise<Server> {
  const server = createFakeHttpServer(async (req, res) => {
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (token !== 'good-token') return send(401, { message: 'Bad credentials' })

    if (req.url === '/user' && req.method === 'GET') {
      return send(200, { login: 'octo-owner' })
    }
    if (req.url?.startsWith('/user/repos') && req.method === 'GET') {
      return send(200, [{ name: 'yahalla-ai-os', full_name: 'octo-owner/yahalla-ai-os', private: true, html_url: 'https://github.com/octo-owner/yahalla-ai-os', clone_url: '', ssh_url: '', default_branch: 'main', updated_at: '2026-01-01T00:00:00Z' }])
    }
    send(404, {})
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let fakeGithub: Server
let db: Db
let httpServer: Server
let baseUrl: string
const authToken = 'test-token'

before(async () => {
  fakeGithub = await startFakeGithub(18101)
  process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:18101'

  db = openDb(':memory:')
  const modelProcess = new LocalModelProcess(18102)
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  const embodiment = new EmbodimentStateMachine()
  const perception = new PerceptionManager(db)

  httpServer = createHttpServer({ db, config, modelProcess, embodiment, perception })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
  fakeGithub.close()
  delete process.env.GITHUB_API_BASE_URL
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('status starts out not configured', async () => {
  const { status, body } = await api('/integrations/github/status')
  assert.equal(status, 200)
  assert.equal(body.configured, false)
  assert.equal(body.username, null)
})

test('connecting with an empty token is rejected', async () => {
  const { status, body } = await api('/integrations/github', { method: 'POST', body: JSON.stringify({ token: '' }) })
  assert.equal(status, 400)
  assert.match(body.error, /required/)
})

test('connecting with a token GitHub rejects is not stored', async () => {
  const { status, body } = await api('/integrations/github', { method: 'POST', body: JSON.stringify({ token: 'bad-token' }) })
  assert.equal(status, 400)
  assert.match(body.error, /rejected this token/)

  const statusAfter = await api('/integrations/github/status')
  assert.equal(statusAfter.body.configured, false)
})

test('connecting with a real, valid token stores it and returns the username, not the token', async () => {
  const { status, body } = await api('/integrations/github', { method: 'POST', body: JSON.stringify({ token: 'good-token' }) })
  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.username, 'octo-owner')
  assert.equal(body.token, undefined)

  const statusAfter = await api('/integrations/github/status')
  assert.equal(statusAfter.body.configured, true)
  assert.equal(statusAfter.body.username, 'octo-owner')

  assert.equal(getPreference<string>(db, 'github_token'), 'good-token')
})

test('the connected token is what agentLoop\'s github.read tool actually uses (real end-to-end proof)', async () => {
  const { githubRead } = await import('../src/github.js')
  const { getPreference: readPref } = await import('../src/memory.js')
  const token = readPref<string>(db, 'github_token')
  const result = await githubRead(token, { operation: 'list_repos' })
  assert.equal(result.success, true)
  assert.equal((result as any).count, 1)
  assert.equal((result as any).repos[0].full_name, 'octo-owner/yahalla-ai-os')
})

test('disconnecting clears the stored token and username', async () => {
  const { status, body } = await api('/integrations/github', { method: 'DELETE' })
  assert.equal(status, 200)
  assert.equal(body.success, true)

  const statusAfter = await api('/integrations/github/status')
  assert.equal(statusAfter.body.configured, false)
  assert.equal(statusAfter.body.username, null)
})

test('unauthenticated requests to the integrations routes are rejected', async () => {
  const response = await fetch(`${baseUrl}/integrations/github/status`)
  assert.equal(response.status, 401)
})
