import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { callCloudTier, loadCloudTierConfig, type CloudTierConfig } from '../src/cloudTier.js'

// Real Anthropic Messages API support: routes chat requests through the
// official @anthropic-ai/sdk instead of the OpenAI-compatible shape used by
// the original Groq-backed cloud tier. Tested against a fake HTTP server
// that speaks the real Anthropic wire shape (POST /v1/messages, x-api-key +
// anthropic-version headers, {content: [{type, text}]} response) so this
// proves the actual request/response translation, not just that a mock was
// called.

let fakeAnthropic: Server
let fakeAnthropicPort: number
let lastRequest: { headers: Record<string, string | string[] | undefined>; body: any } | null = null
let responseBehavior: 'ok' | 'refusal' | 'auth-error' | 'rate-limit' = 'ok'

before(async () => {
  fakeAnthropic = createFakeHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    lastRequest = { headers: req.headers, body }

    if (responseBehavior === 'auth-error') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      return
    }
    if (responseBehavior === 'rate-limit') {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } }))
      return
    }
    if (responseBehavior === 'refusal') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: 'refusal',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      )
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'مرحباً! هذا رد حقيقي وكامل من Claude.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 12 },
      }),
    )
  })
  await new Promise<void>((resolve) => fakeAnthropic.listen(0, '127.0.0.1', () => resolve()))
  const address = fakeAnthropic.address()
  fakeAnthropicPort = typeof address === 'object' && address ? address.port : 0
})

after(() => {
  fakeAnthropic.close()
})

function anthropicConfig(): CloudTierConfig {
  return { provider: 'anthropic', url: `http://127.0.0.1:${fakeAnthropicPort}`, model: 'claude-opus-5', apiKey: 'sk-ant-test-key' }
}

test('loadCloudTierConfig prefers a real ANTHROPIC_API_KEY over the generic CLOUD_TIER_API_KEY', () => {
  const config = loadCloudTierConfig({ ANTHROPIC_API_KEY: 'sk-ant-real', CLOUD_TIER_API_KEY: 'groq-key' } as NodeJS.ProcessEnv)
  assert.equal(config?.provider, 'anthropic')
  assert.equal(config?.apiKey, 'sk-ant-real')
  assert.equal(config?.model, 'claude-opus-5')
  assert.equal(config?.url, 'https://api.anthropic.com')
})

test('loadCloudTierConfig falls back to the OpenAI-compatible provider when only CLOUD_TIER_API_KEY is set', () => {
  const config = loadCloudTierConfig({ CLOUD_TIER_API_KEY: 'groq-key' } as NodeJS.ProcessEnv)
  assert.equal(config?.provider, 'openai')
  assert.equal(config?.model, 'llama-3.3-70b-versatile')
})

test('loadCloudTierConfig returns null when neither key is set', () => {
  assert.equal(loadCloudTierConfig({} as NodeJS.ProcessEnv), null)
})

test('callCloudTier (anthropic) sends a real x-api-key + anthropic-version request and returns the real reply text', async () => {
  responseBehavior = 'ok'
  const result = await callCloudTier(anthropicConfig(), [
    { role: 'system', content: 'You are Yahalla, a helpful executive partner.' },
    { role: 'user', content: 'مرحباً' },
  ])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.content, 'مرحباً! هذا رد حقيقي وكامل من Claude.')

  assert.equal(lastRequest?.headers['x-api-key'], 'sk-ant-test-key')
  assert.ok(lastRequest?.headers['anthropic-version'])
  assert.equal(lastRequest?.body.model, 'claude-opus-5')
  // system role pulled out of messages into the top-level `system` field --
  // the Messages API has no system-role message.
  assert.equal(lastRequest?.body.system, 'You are Yahalla, a helpful executive partner.')
  assert.deepEqual(lastRequest?.body.messages, [{ role: 'user', content: 'مرحباً' }])
  assert.ok(lastRequest?.body.max_tokens >= 4096, 'expects a generous max_tokens for detailed answers')
})

test('callCloudTier (anthropic) surfaces a refusal as a clean error, not a crash', async () => {
  responseBehavior = 'refusal'
  const result = await callCloudTier(anthropicConfig(), [{ role: 'user', content: 'anything' }])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /declined/)
  responseBehavior = 'ok'
})

test('callCloudTier (anthropic) surfaces an auth error from a bad key as a clean error', async () => {
  responseBehavior = 'auth-error'
  const result = await callCloudTier(anthropicConfig(), [{ role: 'user', content: 'anything' }])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /rejected the API key/)
  responseBehavior = 'ok'
})

test('callCloudTier (anthropic) surfaces a rate limit as a 429, not a generic failure', async () => {
  responseBehavior = 'rate-limit'
  const result = await callCloudTier(anthropicConfig(), [{ role: 'user', content: 'anything' }])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 429)
  responseBehavior = 'ok'
})
