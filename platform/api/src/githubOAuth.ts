// GitHub OAuth ("Sign in with GitHub") for the platform-level connection --
// replaces copy-pasting a Personal Access Token with a real one-click
// authorize flow. Two moving pieces beyond the standard authorization-code
// exchange:
//
// 1. The `state` parameter has to carry *which human* started the flow
//    across a top-level browser redirect to github.com and back, where no
//    Authorization header can ride along. Rather than a server-side
//    session table, `state` is a stateless, HMAC-signed token (userId +
//    timestamp) verified on the way back -- same signed-token shape as
//    deployments.ts's webhook signature, just carrying a payload instead
//    of a raw body.
// 2. The GitHub OAuth App's Client Secret doubles as the signing key: it's
//    already a deployment-level secret only this server holds, unique to
//    this exact flow, and introducing a second dedicated env var just for
//    state-signing would be one more thing to configure for no real gain.

import { createHmac, timingSafeEqual } from 'node:crypto'

const STATE_MAX_AGE_MS = 10 * 60 * 1000

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function base64UrlDecode(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

export function signOAuthState(secret: string, userId: string): string {
  const payload = base64UrlEncode(`${userId}.${Date.now()}`)
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${signature}`
}

export function verifyOAuthState(secret: string, state: string, maxAgeMs = STATE_MAX_AGE_MS): string | null {
  const parts = state.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts as [string, string]
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const expectedBuf = Buffer.from(expected)
  const actualBuf = Buffer.from(signature)
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null

  const decoded = base64UrlDecode(payload)
  if (!decoded) return null
  const dotIndex = decoded.lastIndexOf('.')
  if (dotIndex === -1) return null
  const userId = decoded.slice(0, dotIndex)
  const timestamp = Number(decoded.slice(dotIndex + 1))
  if (!userId || !Number.isFinite(timestamp)) return null
  if (Date.now() - timestamp > maxAgeMs) return null
  return userId
}

// Overridable so tests can point this at a fake server instead of real
// GitHub -- same pattern as every other GitHub API base URL in this repo.
function githubOAuthBase(): string {
  return process.env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com'
}

export function buildGithubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${githubOAuthBase()}/login/oauth/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'repo')
  url.searchParams.set('state', state)
  return url.toString()
}

export type GithubOAuthExchangeResult = { ok: true; accessToken: string } | { ok: false; error: string }

export async function exchangeGithubOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GithubOAuthExchangeResult> {
  const response = await fetch(`${githubOAuthBase()}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  })
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, error: `GitHub OAuth token exchange returned HTTP ${response.status}: ${text.slice(0, 500)}` }
  }
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'GitHub OAuth token exchange returned a non-JSON response.' }
  }
  if (data.error) {
    return { ok: false, error: `GitHub OAuth error: ${data.error_description ?? data.error}` }
  }
  if (typeof data.access_token !== 'string') {
    return { ok: false, error: 'GitHub OAuth token exchange response had no access_token.' }
  }
  return { ok: true, accessToken: data.access_token }
}
