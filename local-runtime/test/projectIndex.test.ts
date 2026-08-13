import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { buildProjectIndex, getProjectIndex } from '../src/projectIndex.js'

// A real, small multi-language fixture on disk -- two package.json files
// (a "monorepo" root + a nested package), a tsconfig, a JS file inside
// node_modules that must be excluded, and a real git repo -- so the index
// is asserted against real filesystem/git state, not a mocked walk.
function buildFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-projectindex-fixture-'))

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root-pkg', version: '1.0.0', scripts: { build: 'tsc' }, dependencies: { react: '^19.0.0' } }))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
  writeFileSync(join(dir, 'README.md'), '# fixture\n')

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return null }\n')

  mkdirSync(join(dir, 'packages', 'sub'), { recursive: true })
  writeFileSync(
    join(dir, 'packages', 'sub', 'package.json'),
    JSON.stringify({ name: '@fixture/sub', version: '0.0.1', devDependencies: { typescript: '^5.0.0' } }),
  )
  writeFileSync(join(dir, 'packages', 'sub', 'index.js'), 'module.exports = {}\n')

  // Must be excluded from the walk entirely.
  mkdirSync(join(dir, 'node_modules', 'some-dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'some-dep', 'index.js'), '// should never be counted\n')

  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'yahalla-test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Yahalla Test'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'initial fixture'], { cwd: dir })

  return dir
}

let fixtureDir: string

before(() => {
  fixtureDir = buildFixtureProject()
})

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

test('buildProjectIndex detects languages, excludes node_modules, and reports accurate file count', () => {
  const index = buildProjectIndex(fixtureDir)
  assert.equal(index.truncated, false)
  assert.ok(index.languages['TypeScript'] >= 1, 'src/index.ts')
  assert.ok(index.languages['TypeScript (React)'] >= 1, 'App.tsx')
  assert.ok(index.languages['JavaScript'] >= 1, 'packages/sub/index.js')
  assert.ok(index.languages['Markdown'] >= 1, 'README.md')
  // node_modules/some-dep/index.js must never be counted.
  const totalCountedFiles = Object.values(index.languages).reduce((a, b) => a + b, 0)
  assert.ok(totalCountedFiles < 20, 'node_modules contents must be excluded from the walk')
})

test('buildProjectIndex finds every package.json (monorepo-aware) with real scripts/dependencies', () => {
  const index = buildProjectIndex(fixtureDir)
  assert.equal(index.packages.length, 2)

  const root = index.packages.find((p) => p.name === 'root-pkg')
  assert.ok(root)
  assert.deepEqual(root!.scripts, ['build'])
  assert.deepEqual(root!.dependencies, ['react'])

  const sub = index.packages.find((p) => p.name === '@fixture/sub')
  assert.ok(sub)
  assert.equal(sub!.path, join('packages', 'sub'))
  assert.deepEqual(sub!.devDependencies, ['typescript'])
})

test('buildProjectIndex reports config files and top-level layout', () => {
  const index = buildProjectIndex(fixtureDir)
  assert.ok(index.configFiles.includes('package.json'))
  assert.ok(index.configFiles.includes('tsconfig.json'))
  assert.ok(index.configFiles.includes(join('packages', 'sub', 'package.json')))
  assert.ok(index.topLevelEntries.includes('src/'))
  assert.ok(index.topLevelEntries.includes('README.md'))
  assert.equal(index.topLevelEntries.includes('node_modules/'), false)
})

test('buildProjectIndex reports real git state', () => {
  const index = buildProjectIndex(fixtureDir)
  assert.equal(index.git.branch, 'main')
  assert.match(index.git.latestCommit ?? '', /initial fixture/)
  assert.equal(index.git.isDirty, false)

  writeFileSync(join(fixtureDir, 'src', 'index.ts'), 'export const x = 2\n')
  const dirtyIndex = buildProjectIndex(fixtureDir)
  assert.equal(dirtyIndex.git.isDirty, true)
})

test('buildProjectIndex on a directory that is not a git repo reports null git fields, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-projectindex-nogit-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'nogit-pkg' }))
    const index = buildProjectIndex(dir)
    assert.equal(index.git.branch, null)
    assert.equal(index.git.isDirty, null)
    assert.equal(index.packages[0]?.name, 'nogit-pkg')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getProjectIndex caches: a second call without forceRefresh does not see a file added in between', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-projectindex-cache-'))
  try {
    writeFileSync(join(dir, 'a.md'), 'a\n')
    const first = getProjectIndex(dir)
    assert.equal(first.languages['Markdown'], 1)

    writeFileSync(join(dir, 'b.md'), 'b\n')
    const cached = getProjectIndex(dir)
    assert.equal(cached.languages['Markdown'], 1, 'cached result must not reflect the new file yet')

    const refreshed = getProjectIndex(dir, { forceRefresh: true })
    assert.equal(refreshed.languages['Markdown'], 2, 'forceRefresh must see the new file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Integration: the get_project_overview tool through the real /chat
// HTTP surface, proving the agent loop actually wires the tool call
// through to a real index of a real project directory.

function startFakeLlm(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const hasToolResult = body.messages.some((m: any) => m.role === 'tool')

    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (hasToolResult) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'overview-received' } }] }))
      return
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_overview', type: 'function', function: { name: 'get_project_overview', arguments: '{}' } }],
            },
          },
        ],
      }),
    )
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'test-token'

before(async () => {
  db = openDb(':memory:')
  grantPermission(db, 'project', fixtureDir, 'write')

  fakeLlm = await startFakeLlm(18097)
  const modelProcess = new LocalModelProcess(18097)
  ;(modelProcess as any).child = { exitCode: null, killed: false }

  const config: RuntimeConfig = { port: 0, authToken, projectRoot: fixtureDir, allowedOrigins: ['http://localhost:5173'] }
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  httpServer.close()
  fakeLlm.close()
})

test('chat: get_project_overview executes inline and returns a real structural overview', async () => {
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ message: 'get me oriented on this project' }),
  })
  const body = (await response.json()) as any
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'get_project_overview')
  assert.equal(body.executedTools[0].result.success, true)
  const overview = body.executedTools[0].result.overview
  assert.ok(overview.packages.some((p: any) => p.name === 'root-pkg'))
  assert.equal(overview.git.branch, 'main')
})
