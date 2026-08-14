import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// Real end-to-end proof (audit request #3, human-like conversation) that
// language switching mid-conversation actually reaches the model on a
// per-message basis, through the real /chat path, in the same
// conversation_id -- not a unit test of detectLanguage() in isolation.
// Captures the real system prompt sent to the LLM on each round and
// asserts it names the correct language for THAT message, proving the
// instruction is derived fresh per-message (buildSystemPrompt calls
// detectLanguage(currentMessage), not the conversation's first message or
// a cached value).

const capturedSystemPrompts: string[] = []

function startFakeLlm(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const systemMessage = body.messages.find((m: any) => m.role === 'system')
    capturedSystemPrompts.push(String(systemMessage?.content ?? ''))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'multilingual-test-token'

before(async () => {
  db = openDb(':memory:')
  fakeLlm = await startFakeLlm(18480)
  const modelProcess = new LocalModelProcess(18480)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
  fakeLlm.close()
})

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return response.json()
}

test('language switches mid-conversation: Arabic, then German, then English, all in the SAME conversation, each gets the correct instruction', async () => {
  const arabicMessage = 'مرحباً، أحتاج مساعدة في مشروعي البرمجي اليوم.'
  const first = await api('/chat', { method: 'POST', body: JSON.stringify({ message: arabicMessage }) })
  assert.equal(first.status, 'completed')
  const conversationId = first.conversationId

  const germanMessage = 'Kannst du mir bitte auf Deutsch weiterhelfen? Ich habe eine Frage zu meinem Code.'
  const second = await api('/chat', { method: 'POST', body: JSON.stringify({ message: germanMessage, conversation_id: conversationId }) })
  assert.equal(second.status, 'completed')
  assert.equal(second.conversationId, conversationId, 'must stay in the same conversation across a language switch')

  const englishMessage = 'Actually, let us continue in English from now on.'
  const third = await api('/chat', { method: 'POST', body: JSON.stringify({ message: englishMessage, conversation_id: conversationId }) })
  assert.equal(third.status, 'completed')
  assert.equal(third.conversationId, conversationId)

  assert.equal(capturedSystemPrompts.length, 3)
  assert.match(capturedSystemPrompts[0]!, /Always reply in Arabic/)
  assert.match(capturedSystemPrompts[1]!, /Always reply in German/)
  assert.match(capturedSystemPrompts[2]!, /Always reply in English/)

  // Context retention across the switch: history must still carry the
  // earlier turns even after the language changed -- checked via the real
  // conversation history endpoint, not assumed.
  const history = await api(`/conversations/${conversationId}/messages`)
  const userMessages = history.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)
  assert.deepEqual(userMessages, [arabicMessage, germanMessage, englishMessage], 'all three turns, in order, in the same conversation, regardless of language switching')
})
