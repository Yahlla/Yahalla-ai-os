import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { closePool, getPool } from '../src/db.js'
import { pollOnce } from '../src/worker.js'

let ownerId: string
let workDir: string
let composeFile = 'platform/docker-compose.yml'

before(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  if (!process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set to run these tests.')

  ownerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ownerId, 'deploy-owner@test.local'])

  workDir = await mkdtemp(join(tmpdir(), 'yahalla-worker-'))
  const binDir = join(workDir, 'bin')
  await mkdir(binDir)
  const makeFakeBin = async (name: string, script: string) => {
    const path = join(binDir, name)
    await writeFile(path, `#!/bin/sh\n${script}\n`)
    await chmod(path, 0o755)
  }
  await makeFakeBin('git', 'echo "git $*"')
  await makeFakeBin('docker', 'echo "docker $*"')
  process.env.PATH = `${binDir}:${process.env.PATH}`
})

after(async () => {
  await closePool()
})

async function insertProposal(status: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO deployment_proposals (title, git_ref, diff, status, proposed_by, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $5, now()) RETURNING id`,
    ['Test proposal', 'main', '--- a\n+++ b\n', status, ownerId],
  )
  return rows[0].id
}

test('pollOnce returns null when the approved queue is empty', async () => {
  const result = await pollOnce({ repoDir: workDir, composeFile })
  assert.equal(result, null)
})

test('pollOnce ignores pending/rejected proposals and only claims approved ones', async () => {
  await insertProposal('pending')
  await insertProposal('rejected')
  const result = await pollOnce({ repoDir: workDir, composeFile })
  assert.equal(result, null)
})

test('pollOnce claims an approved proposal, deploys it, and marks it deployed', async () => {
  const id = await insertProposal('approved')
  const claimedId = await pollOnce({ repoDir: workDir, composeFile })
  assert.equal(claimedId, id)

  const { rows } = await getPool().query('SELECT status, deploy_log, deployed_at FROM deployment_proposals WHERE id = $1', [id])
  assert.equal(rows[0].status, 'deployed')
  assert.ok(rows[0].deployed_at)
  assert.match(rows[0].deploy_log, /docker compose/)
})

test('pollOnce marks a proposal failed when the deploy step fails, without touching deployed_at', async () => {
  const binDir = join(workDir, 'bin')
  await writeFile(join(binDir, 'git'), '#!/bin/sh\necho "network unreachable" >&2\nexit 1\n')
  await chmod(join(binDir, 'git'), 0o755)

  const id = await insertProposal('approved')
  const claimedId = await pollOnce({ repoDir: workDir, composeFile })
  assert.equal(claimedId, id)

  const { rows } = await getPool().query('SELECT status, deploy_log, deployed_at FROM deployment_proposals WHERE id = $1', [id])
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows[0].deployed_at, null)
  assert.match(rows[0].deploy_log, /network unreachable/)
})
