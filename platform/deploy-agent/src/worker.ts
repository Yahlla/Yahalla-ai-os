import { withServiceRole } from './db.js'
import { runDeploy, type DeployResult, type DeployTarget } from './deploy.js'

export type DeployAgentConfig = {
  repoDir: string
  composeFile: string
}

type ClaimedProposal = {
  id: string
  git_ref: string
}

// FOR UPDATE SKIP LOCKED is the standard single-claim-per-worker idiom: if
// two deploy-agent processes ever poll at once, each gets a different
// pending row (or none) instead of racing to deploy the same one twice.
async function claimNextProposal(): Promise<ClaimedProposal | null> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `SELECT id, git_ref FROM deployment_proposals
       WHERE status = 'approved'
       ORDER BY decided_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    )
    const proposal = rows[0] as ClaimedProposal | undefined
    if (!proposal) return null
    await client.query("UPDATE deployment_proposals SET status = 'deploying', updated_at = now() WHERE id = $1", [proposal.id])
    return proposal
  })
}

async function finishProposal(id: string, result: DeployResult): Promise<void> {
  await withServiceRole((client) =>
    client.query(
      `UPDATE deployment_proposals
       SET status = $2,
           deploy_log = $3,
           deployed_at = CASE WHEN $2 = 'deployed' THEN now() ELSE deployed_at END,
           updated_at = now()
       WHERE id = $1`,
      [id, result.success ? 'deployed' : 'failed', result.log],
    ),
  )
}

// One full cycle: claim at most one admin-approved proposal and drive it to
// deployed/failed, then return. Claiming and the final status update are
// each their own short transaction; the actual git+docker work happens
// outside any transaction since it can take minutes and must not hold a DB
// lock open while it runs. Returns the proposal id acted on, or null if the
// approved queue was empty.
export async function pollOnce(config: DeployAgentConfig): Promise<string | null> {
  const proposal = await claimNextProposal()
  if (!proposal) return null

  const target: DeployTarget = { repoDir: config.repoDir, composeFile: config.composeFile, gitRef: proposal.git_ref }
  const result = await runDeploy(target)
  await finishProposal(proposal.id, result)
  return proposal.id
}
