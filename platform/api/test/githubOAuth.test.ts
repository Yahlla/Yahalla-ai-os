import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGithubAuthorizeUrl, signOAuthState, verifyOAuthState } from '../src/githubOAuth.js'

const SECRET = 'test-oauth-client-secret'

test('a freshly signed state round-trips back to the same userId', () => {
  const state = signOAuthState(SECRET, 'user-123')
  assert.equal(verifyOAuthState(SECRET, state), 'user-123')
})

test('a state signed with a different secret is rejected', () => {
  const state = signOAuthState('other-secret', 'user-123')
  assert.equal(verifyOAuthState(SECRET, state), null)
})

test('a tampered payload is rejected even if the signature is well-formed hex', () => {
  const state = signOAuthState(SECRET, 'user-123')
  const [, signature] = state.split('.')
  const tampered = `${Buffer.from('someone-else.9999999999999').toString('base64url')}.${signature}`
  assert.equal(verifyOAuthState(SECRET, tampered), null)
})

test('a malformed state (wrong number of parts) is rejected', () => {
  assert.equal(verifyOAuthState(SECRET, 'not-a-real-state'), null)
  assert.equal(verifyOAuthState(SECRET, 'a.b.c'), null)
})

test('an expired state is rejected', () => {
  const state = signOAuthState(SECRET, 'user-123')
  assert.equal(verifyOAuthState(SECRET, state, -1), null)
})

test('buildGithubAuthorizeUrl includes client_id, redirect_uri, scope, and state', () => {
  const url = new URL(buildGithubAuthorizeUrl('client-abc', 'https://example.com/auth/github/callback', 'signed-state'))
  assert.equal(url.origin, 'https://github.com')
  assert.equal(url.pathname, '/login/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), 'client-abc')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/auth/github/callback')
  assert.equal(url.searchParams.get('scope'), 'repo')
  assert.equal(url.searchParams.get('state'), 'signed-state')
})
