// Fetches real data from GitHub's public API to back the "Ship latest
// main" convenience button (Admin -> Deployments) and the push-to-main
// webhook (see server.ts POST /webhooks/github) -- server-side, not from
// the browser, so there's no CORS concern and the diff shown to the admin
// before they click Approve & Ship is the actual diff, not a placeholder.

import { createHmac, timingSafeEqual } from 'node:crypto'

// Overridable so tests can point this at a fake server instead of real
// GitHub -- same pattern as local-runtime's github.ts githubApiBase().
function githubApiBase(): string {
  return process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com'
}

// GitHub signs every webhook delivery with HMAC-SHA256 over the raw request
// body, keyed by the secret configured on the webhook (X-Hub-Signature-256:
// "sha256=<hex>"). Verifying this is the only thing standing between
// "anyone who finds the URL can queue a deployment proposal" and a real
// GitHub push -- timingSafeEqual (not ===) so a mismatched signature can't
// be brute-forced byte-by-byte via response-time differences.
export function verifyGithubWebhookSignature(payload: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
  const expectedBuf = Buffer.from(expected)
  const actualBuf = Buffer.from(signatureHeader)
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export async function fetchLatestMainCommit(repo: string): Promise<{ sha: string; message: string } | null> {
  const response = await fetch(`${githubApiBase()}/repos/${repo}/commits/main`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yahalla-ai-os-platform-api' },
  })
  if (!response.ok) return null
  const data = (await response.json()) as { sha?: string; commit?: { message?: string } }
  if (!data.sha) return null
  return { sha: data.sha, message: data.commit?.message ?? '' }
}

const MAX_DIFF_CHARS = 60_000

export async function fetchCompareDiff(repo: string, base: string, head: string): Promise<string | null> {
  const response = await fetch(`${githubApiBase()}/repos/${repo}/compare/${base}...${head}`, {
    headers: { Accept: 'application/vnd.github.v3.diff', 'User-Agent': 'yahalla-ai-os-platform-api' },
  })
  if (!response.ok) return null
  const text = await response.text()
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n\n... (truncated, ${text.length} chars total)` : text
}

// A minimal shape covering both pg.PoolClient.query and the fake DB clients
// tests use -- deliberately not importing `pg` here so this module stays
// usable from tests without a real Postgres type dependency.
export type DeploymentQueryRunner = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

export type ProposeLatestOutcome =
  | { outcome: 'up_to_date' }
  | { outcome: 'github_unreachable'; repo: string }
  | { outcome: 'proposed'; deployment: Record<string, unknown> }

// The actual "Ship latest main" logic: fetch the real latest commit on
// main, diff it against whatever was last actually deployed, and insert a
// pending proposal -- still requiring a human's Approve & Ship click before
// deploy-agent picks it up. Shared between the human-triggered HTTP route
// (POST /deployments/propose_latest, runs as the calling human via
// withUserSession) and the GitHub push webhook (POST /webhooks/github,
// runs as service_role via withServiceRole since a webhook has no human/
// device identity of its own) -- same behavior either way, just who/what
// is recorded as having proposed it.
export async function proposeLatestDeployment(
  githubRepo: string,
  runQuery: DeploymentQueryRunner,
  proposedBy: string | null,
  proposedByAgent: string | null,
): Promise<ProposeLatestOutcome> {
  const latest = await fetchLatestMainCommit(githubRepo)
  if (!latest) return { outcome: 'github_unreachable', repo: githubRepo }

  const priorDeployed = await runQuery("SELECT git_ref FROM deployment_proposals WHERE status = 'deployed' ORDER BY deployed_at DESC LIMIT 1")
  const baseRef = priorDeployed.rows[0]?.git_ref as string | undefined

  if (baseRef === latest.sha) return { outcome: 'up_to_date' }

  const diff = baseRef ? await fetchCompareDiff(githubRepo, baseRef, latest.sha) : null

  const created = await runQuery(
    `INSERT INTO deployment_proposals (title, description, git_ref, base_ref, diff, proposed_by, proposed_by_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      `Ship latest main (${latest.sha.slice(0, 7)})`,
      latest.message.slice(0, 500),
      latest.sha,
      baseRef ?? latest.sha,
      diff ?? `No prior deployment on record to diff against -- this proposal ships commit ${latest.sha} on main.\n\n${latest.message}`,
      proposedBy,
      proposedByAgent,
    ],
  )
  return { outcome: 'proposed', deployment: created.rows[0]! }
}
