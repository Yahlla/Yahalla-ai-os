const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { test, after, before } = require('node:test')
const { computeRestartDecision, runtimeApi, ensureModelReady, trustProjectRoot, MAX_RESTART_ATTEMPTS, HEALTHY_UPTIME_MS } = require('../src/runtimeSupervisor.cjs')

// --- computeRestartDecision: pure function, no server needed.

test('computeRestartDecision restarts immediately-ish after a quick crash, with growing backoff', () => {
  const first = computeRestartDecision(500, 0)
  assert.equal(first.shouldRestart, true)
  assert.equal(first.attempts, 1)
  assert.equal(first.delayMs, 1000)

  const second = computeRestartDecision(500, 1)
  assert.equal(second.shouldRestart, true)
  assert.equal(second.attempts, 2)
  assert.equal(second.delayMs, 2000)
})

test('computeRestartDecision reaches its largest delay at the last attempt still within budget', () => {
  // MAX_RESTART_ATTEMPTS attempts are allowed before giving up; the delay
  // at the last allowed one (1000 * 2^(MAX_RESTART_ATTEMPTS-1)) is the
  // real largest value this ever produces given today's constants -- the
  // 30s ceiling in the implementation is a defensive bound for a larger
  // MAX_RESTART_ATTEMPTS, not something reachable at the current value,
  // so this asserts the actual observed behavior rather than an
  // unreachable one.
  const decision = computeRestartDecision(500, MAX_RESTART_ATTEMPTS - 1)
  assert.equal(decision.shouldRestart, true)
  assert.equal(decision.delayMs, 1000 * 2 ** (MAX_RESTART_ATTEMPTS - 1))
  assert.ok(decision.delayMs <= 30_000)
})

test('computeRestartDecision gives up after MAX_RESTART_ATTEMPTS consecutive quick crashes', () => {
  let attempts = 0
  let decision
  for (let i = 0; i < MAX_RESTART_ATTEMPTS; i++) {
    decision = computeRestartDecision(500, attempts)
    assert.equal(decision.shouldRestart, true, `attempt ${i + 1} should still restart`)
    attempts = decision.attempts
  }
  decision = computeRestartDecision(500, attempts)
  assert.equal(decision.shouldRestart, false, 'should give up after exceeding the budget')
})

test('computeRestartDecision resets the attempt count after a healthy run', () => {
  const decision = computeRestartDecision(HEALTHY_UPTIME_MS + 1000, 4)
  assert.equal(decision.shouldRestart, true)
  assert.equal(decision.attempts, 1, 'a crash after a healthy run is a fresh failure, not attempt 5')
})

// --- runtimeApi + ensureModelReady: real HTTP against a fake
// local-runtime-shaped server (same discipline as local-runtime's own
// test suite -- real requests, real responses, no mocking of fetch).

function startFakeRuntimeServer(port, handlers) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    const key = `${req.method} ${req.url}`
    const handler = handlers[key]
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'no handler' }))
      return
    }
    const { status, data } = handler(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

test('runtimeApi requires no special setup and surfaces a real HTTP error cleanly', async () => {
  const port = 18430
  const server = await startFakeRuntimeServer(port, {
    'GET /health': () => ({ status: 200, data: { ok: true } }),
  })
  try {
    const ok = await runtimeApi(`http://127.0.0.1:${port}`, 'tok', '/health')
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.data, { ok: true })

    const notFound = await runtimeApi(`http://127.0.0.1:${port}`, 'tok', '/nope')
    assert.equal(notFound.ok, false)
  } finally {
    server.close()
  }
})

test('runtimeApi never throws on a connection failure -- returns {ok:false}', async () => {
  const result = await runtimeApi('http://127.0.0.1:1', 'tok', '/health')
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('ensureModelReady: already reachable -- reports ready immediately, does nothing else', async () => {
  const port = 18431
  const server = await startFakeRuntimeServer(port, {
    'GET /runtime/status': () => ({ status: 200, data: { reachable: true, llama_server_installed: true } }),
  })
  const phases = []
  try {
    await ensureModelReady(`http://127.0.0.1:${port}`, 'tok', (p) => phases.push(p))
    assert.deepEqual(phases, [{ phase: 'ready' }])
  } finally {
    server.close()
  }
})

test('ensureModelReady: llama-server not installed -- reports engine-missing, does not attempt a download', async () => {
  const port = 18432
  const server = await startFakeRuntimeServer(port, {
    'GET /runtime/status': () => ({ status: 200, data: { reachable: false, llama_server_installed: false } }),
  })
  const phases = []
  try {
    await ensureModelReady(`http://127.0.0.1:${port}`, 'tok', (p) => phases.push(p))
    assert.deepEqual(phases, [{ phase: 'engine-missing' }])
  } finally {
    server.close()
  }
})

test('ensureModelReady: full first-run flow -- checking, downloading, starting_engine, ready, in order', async () => {
  const port = 18433
  const recommended = { key: 'small-model', name: 'Small Model', url: 'https://example.test/model.gguf', sha256: null }
  const calls = []
  const server = await startFakeRuntimeServer(port, {
    'GET /runtime/status': () => ({ status: 200, data: { reachable: false, llama_server_installed: true } }),
    'GET /models': () => ({ status: 200, data: { installed: [] } }),
    'GET /hardware': () => ({ status: 200, data: { hardware: {}, recommended } }),
    'POST /models/small-model/register': (body) => {
      calls.push(['register', body])
      return { status: 200, data: { key: 'small-model', status: 'not_downloaded' } }
    },
    'POST /models/small-model/download': () => {
      calls.push(['download'])
      return { status: 200, data: { key: 'small-model', status: 'ready' } }
    },
    'POST /models/small-model/activate': () => {
      calls.push(['activate'])
      return { status: 200, data: { key: 'small-model', active: 1 } }
    },
    'POST /runtime/start': () => {
      calls.push(['start'])
      return { status: 200, data: { success: true, base_url: `http://127.0.0.1:${port}` } }
    },
  })
  const phases = []
  try {
    await ensureModelReady(`http://127.0.0.1:${port}`, 'tok', (p) => phases.push(p))
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['checking', 'downloading', 'starting_engine', 'ready'],
    )
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['register', 'download', 'activate', 'start'],
    )
    assert.equal(calls[0][1].url, recommended.url)
  } finally {
    server.close()
  }
})

test('ensureModelReady: an already-downloaded model skips straight to activate/start, no re-download', async () => {
  const port = 18434
  const calls = []
  const server = await startFakeRuntimeServer(port, {
    'GET /runtime/status': () => ({ status: 200, data: { reachable: false, llama_server_installed: true } }),
    'GET /models': () => ({ status: 200, data: { installed: [{ key: 'already-ready', status: 'ready' }] } }),
    'POST /models/already-ready/activate': () => {
      calls.push('activate')
      return { status: 200, data: { key: 'already-ready', active: 1 } }
    },
    'POST /runtime/start': () => {
      calls.push('start')
      return { status: 200, data: { success: true } }
    },
  })
  const phases = []
  try {
    await ensureModelReady(`http://127.0.0.1:${port}`, 'tok', (p) => phases.push(p))
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['checking', 'starting_engine', 'ready'],
    )
    assert.deepEqual(calls, ['activate', 'start'])
  } finally {
    server.close()
  }
})

// --- trustProjectRoot: audit fix -- launching the desktop app pointed at
// a project folder is this device's real consent signal, but nothing
// previously turned that into an actual /permissions/grant call, so every
// project-scoped tool was permission-denied on every real install. This
// proves main.cjs's new background call actually reaches the real route
// with the real body local-runtime's server.ts expects.

test('trustProjectRoot calls POST /project/trust with a write access request', async () => {
  const port = 18436
  const calls = []
  const server = await startFakeRuntimeServer(port, {
    'POST /project/trust': (body) => {
      calls.push(body)
      return { status: 200, data: { success: true, projectRoot: '/fixture/project', permission: { access: 'write' } } }
    },
  })
  try {
    const result = await trustProjectRoot(`http://127.0.0.1:${port}`, 'tok')
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [{ access: 'write' }])
  } finally {
    server.close()
  }
})

test('trustProjectRoot never throws when the runtime is unreachable', async () => {
  const result = await trustProjectRoot('http://127.0.0.1:1', 'tok')
  assert.equal(result.ok, false)
})

test('ensureModelReady: a download failure reports a clean error phase, not a crash', async () => {
  const port = 18435
  const recommended = { key: 'small-model', name: 'Small Model', url: 'https://example.test/model.gguf' }
  const server = await startFakeRuntimeServer(port, {
    'GET /runtime/status': () => ({ status: 200, data: { reachable: false, llama_server_installed: true } }),
    'GET /models': () => ({ status: 200, data: { installed: [] } }),
    'GET /hardware': () => ({ status: 200, data: { hardware: {}, recommended } }),
    'POST /models/small-model/register': () => ({ status: 200, data: { key: 'small-model' } }),
    'POST /models/small-model/download': () => ({ status: 200, data: { key: 'small-model', status: 'error' } }),
  })
  const phases = []
  try {
    await ensureModelReady(`http://127.0.0.1:${port}`, 'tok', (p) => phases.push(p))
    assert.equal(phases.at(-1).phase, 'error')
  } finally {
    server.close()
  }
})
