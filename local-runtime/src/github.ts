// Talks to the GitHub API directly from the user's own device -- there is
// no server in the middle. The token is read from local preferences
// (set once via the Control Center), never sent anywhere but api.github.com.

export async function githubRead(token: string | undefined, args: Record<string, unknown>) {
  if (!token) {
    return { success: false, operation: 'github.read', message: 'No GitHub token configured. Add one in Settings to enable repository listing.' }
  }
  const operation = String(args.operation ?? '')
  if (operation !== 'list_repos') {
    return { success: false, operation: 'github.read', message: `Unsupported operation "${operation}".` }
  }

  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const response = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'yahalla-ai-os-local-runtime' },
  })
  const text = await response.text()
  if (!response.ok) {
    return { success: false, operation: 'github.read', status: response.status, message: 'GitHub API request failed.', details: text.slice(0, 2000) }
  }
  let repos: any[] = []
  try {
    repos = JSON.parse(text)
  } catch {
    repos = []
  }
  const filtered = query ? repos.filter((r) => String(r?.name ?? '').toLowerCase().includes(query)) : repos
  return {
    success: true,
    operation: 'github.read',
    count: filtered.length,
    repos: filtered.map((r) => ({
      name: r.name, full_name: r.full_name, private: r.private, html_url: r.html_url,
      clone_url: r.clone_url, ssh_url: r.ssh_url, default_branch: r.default_branch, updated_at: r.updated_at,
    })),
  }
}

export async function githubWrite(token: string | undefined, args: Record<string, unknown>) {
  if (!token) {
    return { success: false, operation: 'github.write', message: 'No GitHub token configured. Add one in Settings to enable repository creation.' }
  }
  const operation = String(args.operation ?? '')
  if (operation !== 'create_repo') {
    return { success: false, operation: 'github.write', message: `Unsupported operation "${operation}".` }
  }

  const name = String(args.name ?? '').trim()
  if (!name) {
    return { success: false, operation: 'github.write', message: 'name is required.' }
  }

  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'yahalla-ai-os-local-runtime',
    },
    body: JSON.stringify({
      name,
      private: args.private !== false,
      description: typeof args.description === 'string' ? args.description : undefined,
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    return { success: false, operation: 'github.write', status: response.status, message: 'GitHub API request failed.', details: text.slice(0, 2000) }
  }
  let repo: any = {}
  try {
    repo = JSON.parse(text)
  } catch {
    repo = {}
  }
  return {
    success: true,
    operation: 'github.write',
    repo: {
      name: repo.name, full_name: repo.full_name, private: repo.private, html_url: repo.html_url,
      clone_url: repo.clone_url, ssh_url: repo.ssh_url, default_branch: repo.default_branch,
    },
  }
}
