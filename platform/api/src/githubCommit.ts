// Real GitHub write operations, driven entirely through the GitHub REST +
// Git Data API from this server -- no git binary, no local clone, no
// working directory on disk. This is deliberate: the platform owner asked
// for zero local Agent involvement anywhere, with every technical
// operation going through the GitHub API directly from the Yahalla AI
// backend. A multi-file, single commit needs the low-level Git Data API
// (blobs -> tree -> commit -> ref update) rather than the simpler Contents
// API, which only commits one file at a time.

// Overridable so tests can point this at a fake server instead of real
// GitHub -- same pattern as deployments.ts's githubApiBase() and
// local-runtime/src/github.ts's githubApiBase().
function githubApiBase(): string {
  return process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com'
}

function headers(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yahalla-ai-os-platform-api',
    ...extra,
  }
}

export type GithubApiError = { ok: false; status: number; error: string }
type GithubApiResult<T> = { ok: true; data: T } | GithubApiError

async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<GithubApiResult<T>> {
  const response = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers as Record<string, string> | undefined) } })
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, status: response.status, error: `GitHub API ${response.status} for ${url}: ${text.slice(0, 500)}` }
  }
  try {
    return { ok: true, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: 502, error: 'GitHub API returned a non-JSON response.' }
  }
}

// Reads a real file's current content -- used by the coding agent to see
// what it's editing before proposing a change. Returns null (not an
// error) for a 404, since "file doesn't exist yet" is a normal, expected
// outcome when creating a new file.
export async function readRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ ok: true; content: string | null } | GithubApiError> {
  const url = `${githubApiBase()}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
  const response = await fetch(url, { headers: headers(token) })
  if (response.status === 404) return { ok: true, content: null }
  const text = await response.text()
  if (!response.ok) return { ok: false, status: response.status, error: `GitHub API ${response.status} reading ${path}: ${text.slice(0, 500)}` }
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, status: 502, error: 'GitHub API returned a non-JSON response.' }
  }
  if (Array.isArray(data)) return { ok: false, status: 400, error: `${path} is a directory, not a file.` }
  if (typeof data.content !== 'string') return { ok: false, status: 502, error: `GitHub API response for ${path} had no content.` }
  return { ok: true, content: Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8') }
}

// Lists real files/directories at a path -- used by the coding agent to
// explore the repo before deciding what to change.
export async function listRepoDir(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ ok: true; entries: { path: string; type: 'file' | 'dir' }[] } | GithubApiError> {
  const url = `${githubApiBase()}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
  const result = await githubJson<any>(url, token)
  if (!result.ok) return result
  const items = Array.isArray(result.data) ? result.data : [result.data]
  return { ok: true, entries: items.map((i: any) => ({ path: i.path, type: i.type === 'dir' ? 'dir' : 'file' })) }
}

export type FileEdit = { path: string; content: string }

export type CommitAndPrResult =
  | { ok: true; branch: string; commitSha: string; pullRequest: { number: number; html_url: string; title: string; state: string; head: string; base: string } }
  | GithubApiError

// The actual "commit/push directly to the repo" operation: creates (or
// reuses) a branch off `base`, writes every file in `files` as one atomic
// commit via the Git Data API (blob per file -> one tree -> one commit),
// moves the branch ref to that commit, then opens a real PR -- still the
// human review checkpoint before anything reaches `base`, matching the
// autonomy-until-PR model already built and tested for local-runtime's
// coding loop (agentLoop.ts), just executed here entirely over the API
// instead of a local git working directory.
export async function commitFilesAndOpenPr(
  token: string,
  args: {
    owner: string
    repo: string
    base?: string
    branch: string
    files: FileEdit[]
    commitMessage: string
    prTitle: string
    prBody?: string
  },
): Promise<CommitAndPrResult> {
  const { owner, repo, files, commitMessage, prTitle, prBody } = args
  const base = args.base?.trim() || 'main'
  const branch = args.branch.trim()
  if (!owner || !repo || !branch || files.length === 0) {
    return { ok: false, status: 400, error: 'owner, repo, branch, and at least one file are required.' }
  }

  const baseRef = await githubJson<{ object: { sha: string } }>(`${githubApiBase()}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`, token)
  if (!baseRef.ok) return baseRef
  const baseSha = baseRef.data.object.sha

  // Reuse the branch if it already exists (e.g. a follow-up commit to an
  // open PR); otherwise create it fresh off base. Either way, parentSha is
  // what the new commit is built on top of.
  const existingBranchRef = await githubJson<{ object: { sha: string } }>(
    `${githubApiBase()}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  )
  let parentSha: string
  if (existingBranchRef.ok) {
    parentSha = existingBranchRef.data.object.sha
  } else {
    const created = await githubJson<{ object: { sha: string } }>(`${githubApiBase()}/repos/${owner}/${repo}/git/refs`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    })
    if (!created.ok) return created
    parentSha = baseSha
  }

  const parentCommit = await githubJson<{ tree: { sha: string } }>(`${githubApiBase()}/repos/${owner}/${repo}/git/commits/${parentSha}`, token)
  if (!parentCommit.ok) return parentCommit

  const blobs: { path: string; sha: string }[] = []
  for (const file of files) {
    const blob = await githubJson<{ sha: string }>(`${githubApiBase()}/repos/${owner}/${repo}/git/blobs`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' }),
    })
    if (!blob.ok) return blob
    blobs.push({ path: file.path, sha: blob.data.sha })
  }

  const tree = await githubJson<{ sha: string }>(`${githubApiBase()}/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: parentCommit.data.tree.sha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    }),
  })
  if (!tree.ok) return tree

  const commit = await githubJson<{ sha: string }>(`${githubApiBase()}/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMessage, tree: tree.data.sha, parents: [parentSha] }),
  })
  if (!commit.ok) return commit

  const refUpdate = await githubJson<unknown>(`${githubApiBase()}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commit.data.sha, force: false }),
  })
  if (!refUpdate.ok) return refUpdate

  // A PR from the same branch may already be open (a follow-up commit) --
  // GitHub 422s on a duplicate create, so check first rather than treating
  // that as a failure.
  const existingPrs = await githubJson<{ number: number; html_url: string; title: string; state: string; head: { ref: string }; base: { ref: string } }[]>(
    `${githubApiBase()}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&state=open`,
    token,
  )
  if (existingPrs.ok && existingPrs.data.length > 0) {
    const pr = existingPrs.data[0]!
    return {
      ok: true,
      branch,
      commitSha: commit.data.sha,
      pullRequest: { number: pr.number, html_url: pr.html_url, title: pr.title, state: pr.state, head: pr.head.ref, base: pr.base.ref },
    }
  }

  const pr = await githubJson<{ number: number; html_url: string; title: string; state: string; head: { ref: string }; base: { ref: string } }>(
    `${githubApiBase()}/repos/${owner}/${repo}/pulls`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: prTitle, head: branch, base, body: prBody }),
    },
  )
  if (!pr.ok) return pr

  return {
    ok: true,
    branch,
    commitSha: commit.data.sha,
    pullRequest: { number: pr.data.number, html_url: pr.data.html_url, title: pr.data.title, state: pr.data.state, head: pr.data.head.ref, base: pr.data.base.ref },
  }
}
