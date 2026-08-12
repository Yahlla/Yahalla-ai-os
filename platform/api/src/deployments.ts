// Fetches real data from GitHub's public API to back the "Ship latest
// main" convenience button (Admin -> Deployments) -- server-side, not from
// the browser, so there's no CORS concern and the diff shown to the admin
// before they click Approve & Ship is the actual diff, not a placeholder.

// Overridable so tests can point this at a fake server instead of real
// GitHub -- same pattern as local-runtime's github.ts githubApiBase().
function githubApiBase(): string {
  return process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com'
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
