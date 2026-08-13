import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { test } from 'node:test'
import { chatCompletionStream, isLlamaServerInstalled } from '../src/llm.js'

test('isLlamaServerInstalled returns true for a real, runnable binary', () => {
  // node itself always exists and supports --version -- a stand-in for
  // "llama-server is actually installed and runs", without depending on
  // llama.cpp being present in this test environment.
  assert.equal(isLlamaServerInstalled(process.execPath), true)
})

test('isLlamaServerInstalled returns false for a binary that does not exist', () => {
  assert.equal(isLlamaServerInstalled('/definitely/not/a/real/path/llama-server'), false)
})

test('isLlamaServerInstalled returns false for a binary that exits non-zero on --version', () => {
  // /bin/false (or an equivalent always-present, always-failing binary)
  // exits 1 for any invocation, including --version -- must not be
  // mistaken for "installed and working".
  assert.equal(isLlamaServerInstalled('/bin/false'), false)
})

// chatCompletionStream: real HTTP against a fake SSE server implementing
// the exact frame format llama-server's OpenAI-compatible streaming
// endpoint uses -- not a mock of chatCompletionStream itself, a real
// fetch against a real server emitting real `data: {...}\n\n` frames.

async function withFakeSseServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createFakeHttpServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

test('chatCompletionStream reassembles content deltas and forwards each one to onToken', async () => {
  await withFakeSseServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sseFrame({ choices: [{ delta: { role: 'assistant' } }] }))
      res.write(sseFrame({ choices: [{ delta: { content: 'Hel' } }] }))
      res.write(sseFrame({ choices: [{ delta: { content: 'lo, ' } }] }))
      res.write(sseFrame({ choices: [{ delta: { content: 'world!' } }] }))
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseUrl) => {
      const tokens: string[] = []
      const result = await chatCompletionStream(baseUrl, { model: 'x', messages: [] }, (delta) => tokens.push(delta))
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(tokens, ['Hel', 'lo, ', 'world!'])
      assert.equal(result.data.choices[0].message.content, 'Hello, world!')
      assert.equal(result.data.choices[0].message.tool_calls, undefined)
    },
  )
})

test('chatCompletionStream reassembles a tool call spread across multiple deltas, without forwarding it as text', async () => {
  await withFakeSseServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_project_file', arguments: '' } }] } }] }))
      res.write(sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }))
      res.write(sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }))
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseUrl) => {
      const tokens: string[] = []
      const result = await chatCompletionStream(baseUrl, { model: 'x', messages: [] }, (delta) => tokens.push(delta))
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(tokens, [])
      assert.equal(result.data.choices[0].message.content, null)
      assert.deepEqual(result.data.choices[0].message.tool_calls, [
        { id: 'call_1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"a.txt"}' } },
      ])
    },
  )
})

test('chatCompletionStream surfaces a clean error on a non-200 response', async () => {
  await withFakeSseServer(
    (req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('internal error')
    },
    async (baseUrl) => {
      const result = await chatCompletionStream(baseUrl, { model: 'x', messages: [] }, () => {})
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.match(result.errorMessage, /HTTP 500/)
    },
  )
})

test('chatCompletionStream handles frames split across multiple TCP chunks', async () => {
  await withFakeSseServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = sseFrame({ choices: [{ delta: { content: 'split-frame-token' } }] })
      // Write the frame in two pieces with a delay between them, forcing
      // separate TCP reads on the client side rather than one clean chunk.
      res.write(frame.slice(0, 10))
      setTimeout(() => {
        res.write(frame.slice(10))
        res.write('data: [DONE]\n\n')
        res.end()
      }, 20)
    },
    async (baseUrl) => {
      const tokens: string[] = []
      const result = await chatCompletionStream(baseUrl, { model: 'x', messages: [] }, (delta) => tokens.push(delta))
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(tokens, ['split-frame-token'])
    },
  )
})
