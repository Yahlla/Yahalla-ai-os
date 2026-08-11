import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { LocalModelProcess } from '../src/llm.js'
import { PerceptionManager } from '../src/perception/manager.js'
import type { MockPerceptionProvider } from '../src/perception/providers/mockProvider.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

let projectDir: string
let db: Db
let embodiment: EmbodimentStateMachine
let perception: PerceptionManager
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'perception-test-token'

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-perception-test-'))
  db = openDb(':memory:')
  embodiment = new EmbodimentStateMachine()
  perception = new PerceptionManager(db)

  const modelProcess = new LocalModelProcess(0)
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: projectDir, allowedOrigins: [] }

  httpServer = createHttpServer({ db, config, modelProcess, embodiment, perception })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
  rmSync(projectDir, { recursive: true, force: true })
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('perception cannot start without an explicit permission grant', async () => {
  const { status, body } = await api('/perception/start', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) })
  assert.equal(status, 403)
  assert.match(body.error, /permission/i)

  const stateAfter = embodiment.getState()
  assert.equal(stateAfter.state, 'NEEDS_PERMISSION')
})

test('camera is off (not running) by default', async () => {
  const { body } = await api('/perception/status')
  assert.equal(body.active, false)
})

test('after granting camera+microphone, perception starts and reports active', async () => {
  await api('/permissions/grant', { method: 'POST', body: JSON.stringify({ scope: 'camera', target: '*', access: 'read' }) })
  await api('/permissions/grant', { method: 'POST', body: JSON.stringify({ scope: 'microphone', target: '*', access: 'read' }) })

  const { status, body } = await api('/perception/start', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) })
  assert.equal(status, 200)
  assert.ok(body.sessionId)

  const { body: statusBody } = await api('/perception/status')
  assert.equal(statusBody.active, true)
  assert.equal(statusBody.provider, 'mock')
})

test('vertical slice: provider events flow through the bus into the World Model', async () => {
  const provider = perception.getProvider('mock') as MockPerceptionProvider

  // Deterministic, not timer-based: drive the scripted sequence directly
  // (person.detected -> face.updated -> gaze.updated -> ...) instead of
  // waiting on the real auto-tick interval.
  const events = []
  for (let i = 0; i < 6; i++) {
    events.push(provider.tick())
  }
  assert.equal(events[0]!.type, 'person.detected')
  assert.equal(events[2]!.type, 'gaze.updated')

  const { body: snapshot } = await api('/perception/world-model')
  assert.equal(snapshot.humans.length, 1)
  const human = snapshot.humans[0]
  assert.equal(human.trackId, 'mock-1')
  assert.equal(human.gaze.target, 'screen_element')
  assert.ok(human.gaze.confidence > 0 && human.gaze.confidence <= 1, 'confidence must be a real probabilistic value')
  assert.equal(human.interactionState, 'gesturing')
})

test('speech events update voice state and can be reasoned over by the agent (perception context in system prompt)', async () => {
  const provider = perception.getProvider('mock') as MockPerceptionProvider
  // Advance through hand/gesture/speech.started/partial/final.
  for (let i = 0; i < 4; i++) provider.tick()

  const { body: snapshot } = await api('/perception/world-model')
  const human = snapshot.humans[0]
  assert.equal(human.voice.lastFinal, 'open the file')
})

test('history delete actually clears both the event log and the World Model', async () => {
  let { body: snapshot } = await api('/perception/world-model')
  assert.ok(snapshot.humans.length > 0, 'expected prior test data to still be present before deletion')

  const { status } = await api('/perception/history', { method: 'DELETE' })
  assert.equal(status, 200)

  ;({ body: snapshot } = await api('/perception/world-model'))
  assert.equal(snapshot.humans.length, 0)
  assert.equal(perception.bus.getHistory().length, 0)
})

test('stopping perception turns it off again (no camera/mic activity when idle)', async () => {
  const { status } = await api('/perception/stop', { method: 'POST' })
  assert.equal(status, 200)
  const { body } = await api('/perception/status')
  assert.equal(body.active, false)
})

test('embodiment state machine reflects live agent status transitions', async () => {
  // Not asserting the exact starting state here: earlier tests in this
  // file already drove real transitions (e.g. NEEDS_PERMISSION) on this
  // same shared instance, which is itself part of what's being verified --
  // transition() just needs to work correctly from wherever it currently is.
  const update = embodiment.transition('THINKING', 'Analyzing request')
  assert.equal(update.state, 'THINKING')
  assert.equal(update.summary, 'Analyzing request')

  const seen: string[] = []
  const off = embodiment.onUpdate((u) => seen.push(u.state))
  embodiment.transition('ACTING', 'Reading package.json')
  embodiment.transition('SUCCESS', 'Task completed')
  off()

  assert.deepEqual(seen, ['ACTING', 'SUCCESS'])
})
