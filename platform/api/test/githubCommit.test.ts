import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, before, test } from 'node:test'
import { commitFilesAndOpenPr, listRepoDir, readRepoFile } from '../src/githubCommit.js'

// Pure GitHub-API commit/PR pipeline -- no git binary, no local clone. This
// is the operation the platform owner asked for directly: "execute a
// commit/push straight to the repository" from the server itself, with
// zero local Agent involved. Verified against a fake server that
// implements the real Git Data API sequence (ref -> commits -> blobs ->
// trees -> commits -> ref update -> pulls), asserting the actual request
// bodies sent at each step, not just that *a* request happened.

type Recorded = { method: string; url: string; body: any }
let fakeGithub: Server
let fakeGithubPort: number
let requests: Recorded[] = []
let existingBranchExists = false
let existingOpenPr: any = null

function handler(req: IncomingMessage, res: ServerResponse): void {
  ;(async () => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const body = bodyText ? JSON.parse(bodyText) : undefined
    const url = req.url ?? ''
    requests.push({ method: req.method ?? '', url, body })

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (url === '/repos/acme/widgets/git/ref/heads/main' && req.method === 'GET') {
      return send(200, { object: { sha: 'base-sha-1' } })
    }
    if (url === '/repos/acme/widgets/git/ref/heads/feature-x' && req.method === 'GET') {
      if (existingBranchExists) return send(200, { object: { sha: 'existing-branch-sha' } })
      return send(404, { message: 'Not Found' })
    }
    if (url === '/repos/acme/widgets/git/refs' && req.method === 'POST') {
      assert.equal(body.ref, 'refs/heads/feature-x')
      assert.equal(body.sha, 'base-sha-1')
      return send(201, { ref: body.ref, object: { sha: body.sha } })
    }
    if (url.match(/^\/repos\/acme\/widgets\/git\/commits\/(base-sha-1|existing-branch-sha)$/) && req.method === 'GET') {
      return send(200, { tree: { sha: 'parent-tree-sha' } })
    }
    if (url === '/repos/acme/widgets/git/blobs' && req.method === 'POST') {
      assert.equal(body.encoding, 'base64')
      const decoded = Buffer.from(body.content, 'base64').toString('utf8')
      return send(201, { sha: `blob-${Buffer.from(decoded).length}-${decoded.length}` })
    }
    if (url === '/repos/acme/widgets/git/trees' && req.method === 'POST') {
      assert.equal(body.base_tree, 'parent-tree-sha')
      assert.ok(Array.isArray(body.tree) && body.tree.length > 0)
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644')
        assert.equal(entry.type, 'blob')
      }
      return send(201, { sha: 'new-tree-sha' })
    }
    if (url === '/repos/acme/widgets/git/commits' && req.method === 'POST') {
      assert.equal(body.tree, 'new-tree-sha')
      assert.ok(Array.isArray(body.parents) && body.parents.length === 1)
      return send(201, { sha: 'new-commit-sha' })
    }
    if (url === '/repos/acme/widgets/git/refs/heads/feature-x' && req.method === 'PATCH') {
      assert.equal(body.sha, 'new-commit-sha')
      assert.equal(body.force, false)
      return send(200, { ref: 'refs/heads/feature-x', object: { sha: body.sha } })
    }
    if (url.startsWith('/repos/acme/widgets/pulls?head=') && req.method === 'GET') {
      return send(200, existingOpenPr ? [existingOpenPr] : [])
    }
    if (url === '/repos/acme/widgets/pulls' && req.method === 'POST') {
      assert.equal(body.title, 'Fix the login bug')
      assert.equal(body.head, 'feature-x')
      assert.equal(body.base, 'main')
      return send(201, {
        number: 42,
        html_url: 'https://github.com/acme/widgets/pull/42',
        title: body.title,
        state: 'open',
        head: { ref: body.head },
        base: { ref: body.base },
      })
    }
    if (url === '/repos/acme/widgets/contents/src%2Fapp.ts' && req.method === 'GET') {
      return send(200, { content: Buffer.from('export const x = 1\n').toString('base64'), encoding: 'base64' })
    }
    if (url === '/repos/acme/widgets/contents/src%2Fmissing.ts' && req.method === 'GET') {
      return send(404, { message: 'Not Found' })
    }
    if (url === '/repos/acme/widgets/contents/' && req.method === 'GET') {
      return send(200, [
        { path: 'src', type: 'dir' },
        { path: 'README.md', type: 'file' },
      ])
    }
    send(404, { message: `unhandled ${req.method} ${url}` })
  })().catch((error) => {
    res.writeHead(500)
    res.end(String(error))
  })
}

before(async () => {
  fakeGithub = createFakeHttpServer(handler)
  await new Promise<void>((resolve) => fakeGithub.listen(0, '127.0.0.1', () => resolve()))
  const address = fakeGithub.address()
  fakeGithubPort = typeof address === 'object' && address ? address.port : 0
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${fakeGithubPort}`
})

after(() => {
  fakeGithub.close()
  delete process.env.GITHUB_API_BASE_URL
})

test('commitFilesAndOpenPr creates a branch off base, one atomic commit, and a real PR', async () => {
  requests = []
  existingBranchExists = false
  existingOpenPr = null

  const result = await commitFilesAndOpenPr('gh-token', {
    owner: 'acme',
    repo: 'widgets',
    branch: 'feature-x',
    files: [
      { path: 'src/app.ts', content: 'export const x = 2\n' },
      { path: 'README.md', content: '# Widgets\n' },
    ],
    commitMessage: 'Fix the login bug',
    prTitle: 'Fix the login bug',
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.branch, 'feature-x')
  assert.equal(result.commitSha, 'new-commit-sha')
  assert.equal(result.pullRequest.number, 42)
  assert.equal(result.pullRequest.html_url, 'https://github.com/acme/widgets/pull/42')

  // Real sequence: ref -> create branch -> parent commit -> 2 blobs -> tree -> commit -> ref update -> PR
  const methodsAndUrls = requests.map((r) => `${r.method} ${r.url}`)
  assert.ok(methodsAndUrls.includes('GET /repos/acme/widgets/git/ref/heads/main'))
  assert.ok(methodsAndUrls.includes('POST /repos/acme/widgets/git/refs'))
  assert.equal(requests.filter((r) => r.url === '/repos/acme/widgets/git/blobs').length, 2, 'one blob per file')
})

test('commitFilesAndOpenPr reuses an existing branch instead of failing when it already exists', async () => {
  requests = []
  existingBranchExists = true
  existingOpenPr = null

  const result = await commitFilesAndOpenPr('gh-token', {
    owner: 'acme',
    repo: 'widgets',
    branch: 'feature-x',
    files: [{ path: 'src/app.ts', content: 'export const x = 3\n' }],
    commitMessage: 'Follow-up fix',
    prTitle: 'Fix the login bug',
  })

  assert.equal(result.ok, true)
  // Must NOT try to create the ref again -- it already exists.
  assert.equal(requests.filter((r) => r.method === 'POST' && r.url === '/repos/acme/widgets/git/refs').length, 0)
})

test('commitFilesAndOpenPr reuses an already-open PR instead of erroring on a duplicate create', async () => {
  requests = []
  existingBranchExists = true
  existingOpenPr = {
    number: 7,
    html_url: 'https://github.com/acme/widgets/pull/7',
    title: 'Fix the login bug',
    state: 'open',
    head: { ref: 'feature-x' },
    base: { ref: 'main' },
  }

  const result = await commitFilesAndOpenPr('gh-token', {
    owner: 'acme',
    repo: 'widgets',
    branch: 'feature-x',
    files: [{ path: 'src/app.ts', content: 'export const x = 4\n' }],
    commitMessage: 'Another follow-up',
    prTitle: 'Fix the login bug',
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.pullRequest.number, 7)
  assert.equal(requests.filter((r) => r.method === 'POST' && r.url === '/repos/acme/widgets/pulls').length, 0)
})

test('commitFilesAndOpenPr surfaces a real upstream error cleanly', async () => {
  requests = []
  existingBranchExists = false
  existingOpenPr = null

  const result = await commitFilesAndOpenPr('gh-token', {
    owner: 'acme',
    repo: 'does-not-exist',
    branch: 'feature-x',
    files: [{ path: 'a.txt', content: 'x' }],
    commitMessage: 'x',
    prTitle: 'x',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /404/)
})

test('readRepoFile returns real decoded content for an existing file', async () => {
  const result = await readRepoFile('gh-token', 'acme', 'widgets', 'src/app.ts')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.content, 'export const x = 1\n')
})

test('readRepoFile returns null (not an error) for a file that does not exist yet', async () => {
  const result = await readRepoFile('gh-token', 'acme', 'widgets', 'src/missing.ts')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.content, null)
})

test('listRepoDir returns real directory entries', async () => {
  const result = await listRepoDir('gh-token', 'acme', 'widgets', '')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.entries, [
    { path: 'src', type: 'dir' },
    { path: 'README.md', type: 'file' },
  ])
})
