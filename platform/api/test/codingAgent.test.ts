import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, before, test } from 'node:test'
import { runCodingAgent } from '../src/codingAgent.js'

// End-to-end proof that the zero-local-agent coding path actually works:
// a fake Anthropic server drives a real tool-use loop (list_files ->
// read_file -> propose_commit), and a fake GitHub server receives the
// real resulting branch/commit/PR calls -- proving the two modules
// (codingAgent.ts, githubCommit.ts) are wired correctly together, not
// just independently correct.

let fakeAnthropic: Server
let fakeAnthropicPort: number
let fakeGithub: Server
let fakeGithubPort: number
let anthropicTurn = 0
let githubRequests: { method: string; url: string }[] = []

function textBlock(text: string) {
  return { type: 'text', text }
}
function toolUseBlock(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input }
}

before(async () => {
  fakeAnthropic = createFakeHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    anthropicTurn += 1

    const send = (content: unknown[]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `msg_${anthropicTurn}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content,
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      )
    }

    if (anthropicTurn === 1) {
      // First turn: explore the repo.
      return send([textBlock('Let me look at the repo.'), toolUseBlock('t1', 'list_files', { path: '' })])
    }
    if (anthropicTurn === 2) {
      // Second turn: read the file it found.
      return send([toolUseBlock('t2', 'read_file', { path: 'src/greeting.ts' })])
    }
    // Third turn: ship the fix.
    return send([
      toolUseBlock('t3', 'propose_commit', {
        branch: 'fix-greeting',
        commit_message: 'Fix the greeting typo',
        pr_title: 'Fix the greeting typo',
        pr_body: 'Corrects "helo" to "hello".',
        files: [{ path: 'src/greeting.ts', content: 'export const greeting = "hello world"\n' }],
      }),
    ])
  })
  await new Promise<void>((resolve) => fakeAnthropic.listen(0, '127.0.0.1', () => resolve()))
  const anthropicAddress = fakeAnthropic.address()
  fakeAnthropicPort = typeof anthropicAddress === 'object' && anthropicAddress ? anthropicAddress.port : 0

  fakeGithub = createFakeHttpServer((req: IncomingMessage, res: ServerResponse) => {
    ;(async () => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const body = bodyText ? JSON.parse(bodyText) : undefined
      const url = req.url ?? ''
      githubRequests.push({ method: req.method ?? '', url })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (url === '/repos/acme/widgets/contents/' && req.method === 'GET') {
        return send(200, [{ path: 'src/greeting.ts', type: 'file' }])
      }
      if (url === '/repos/acme/widgets/contents/src%2Fgreeting.ts' && req.method === 'GET') {
        return send(200, { content: Buffer.from('export const greeting = "helo world"\n').toString('base64'), encoding: 'base64' })
      }
      if (url === '/repos/acme/widgets/git/ref/heads/main' && req.method === 'GET') return send(200, { object: { sha: 'base-sha' } })
      if (url === '/repos/acme/widgets/git/ref/heads/fix-greeting' && req.method === 'GET') return send(404, {})
      if (url === '/repos/acme/widgets/git/refs' && req.method === 'POST') return send(201, {})
      if (url === '/repos/acme/widgets/git/commits/base-sha' && req.method === 'GET') return send(200, { tree: { sha: 'tree-sha' } })
      if (url === '/repos/acme/widgets/git/blobs' && req.method === 'POST') return send(201, { sha: 'blob-sha' })
      if (url === '/repos/acme/widgets/git/trees' && req.method === 'POST') return send(201, { sha: 'new-tree-sha' })
      if (url === '/repos/acme/widgets/git/commits' && req.method === 'POST') return send(201, { sha: 'new-commit-sha' })
      if (url === '/repos/acme/widgets/git/refs/heads/fix-greeting' && req.method === 'PATCH') return send(200, {})
      if (url.startsWith('/repos/acme/widgets/pulls?head=') && req.method === 'GET') return send(200, [])
      if (url === '/repos/acme/widgets/pulls' && req.method === 'POST') {
        return send(201, {
          number: 99,
          html_url: 'https://github.com/acme/widgets/pull/99',
          title: body.title,
          state: 'open',
          head: { ref: body.head },
          base: { ref: body.base },
        })
      }
      send(404, { message: `unhandled ${req.method} ${url}` })
    })().catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => fakeGithub.listen(0, '127.0.0.1', () => resolve()))
  const githubAddress = fakeGithub.address()
  fakeGithubPort = typeof githubAddress === 'object' && githubAddress ? githubAddress.port : 0
})

after(() => {
  fakeAnthropic.close()
  fakeGithub.close()
})

test('runCodingAgent explores real files then ships a real branch/commit/PR, with zero local agent involved', async () => {
  anthropicTurn = 0
  githubRequests = []
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${fakeGithubPort}`

  try {
    const result = await runCodingAgent(
      { apiKey: 'sk-ant-test', model: 'claude-opus-5', baseURL: `http://127.0.0.1:${fakeAnthropicPort}` },
      { token: 'gh-token' },
      { owner: 'acme', repo: 'widgets', instruction: 'Fix the typo in the greeting.' },
    )

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.pullRequest)
    assert.equal(result.pullRequest?.number, 99)
    assert.match(result.summary, /Opened pull request #99/)

    // Really explored before committing -- not a one-shot guess.
    assert.ok(githubRequests.some((r) => r.method === 'GET' && r.url === '/repos/acme/widgets/contents/'))
    assert.ok(githubRequests.some((r) => r.method === 'GET' && r.url === '/repos/acme/widgets/contents/src%2Fgreeting.ts'))
    // Really committed via the Git Data API, not a shortcut.
    assert.ok(githubRequests.some((r) => r.method === 'POST' && r.url === '/repos/acme/widgets/git/blobs'))
    assert.ok(githubRequests.some((r) => r.method === 'POST' && r.url === '/repos/acme/widgets/pulls'))
  } finally {
    delete process.env.GITHUB_API_BASE_URL
  }
})
