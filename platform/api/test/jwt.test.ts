import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { after, before, test } from 'node:test'
import { verifyJwt, JwtVerificationError } from '../src/jwt.js'

function base64Url(input: Buffer | object): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input))
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// A real EC P-256 keypair, the same kind Supabase's ES256 projects use --
// this is what makes this test actually catch encoding mistakes (the
// r||s "ieee-p1363" vs ASN.1 DER gotcha) rather than assuming they're
// right.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const KID = 'test-key-1'

function signEs256(claims: Record<string, unknown>): string {
  const header = base64Url({ alg: 'ES256', kid: KID, typ: 'JWT' })
  const payload = base64Url(claims)
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${base64Url(signature)}`
}

let jwksServer: import('node:http').Server
let jwksUrl: string
let jwksBody: unknown

before(async () => {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string; crv: string; kty: string }
  jwksBody = { keys: [{ ...jwk, kid: KID }] }

  jwksServer = createFakeHttpServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jwksBody))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()))
  const address = jwksServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  jwksUrl = `http://127.0.0.1:${port}`
})

after(() => {
  jwksServer.close()
})

test('verifyJwt accepts a genuinely valid ES256 token verified against a real JWKS endpoint', async () => {
  const token = signEs256({ sub: 'user-1', email: 'a@test.local', exp: Math.floor(Date.now() / 1000) + 3600 })
  const claims = await verifyJwt(token, { supabaseUrl: jwksUrl })
  assert.equal(claims.sub, 'user-1')
  assert.equal(claims.email, 'a@test.local')
})

test('verifyJwt rejects an ES256 token whose signature was tampered with', async () => {
  const token = signEs256({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
  const parts = token.split('.')
  const tampered = `${parts[0]}.${base64Url({ sub: 'someone-else', exp: Math.floor(Date.now() / 1000) + 3600 })}.${parts[2]}`
  await assert.rejects(() => verifyJwt(tampered, { supabaseUrl: jwksUrl }), JwtVerificationError)
})

test('verifyJwt rejects an expired ES256 token', async () => {
  const token = signEs256({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 60 })
  await assert.rejects(() => verifyJwt(token, { supabaseUrl: jwksUrl }), /expired/)
})

test('verifyJwt rejects ES256 when no SUPABASE_URL is configured to fetch keys from', async () => {
  const token = signEs256({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
  await assert.rejects(() => verifyJwt(token, {}), /SUPABASE_URL/)
})

test('verifyJwt still verifies HS256 tokens (legacy projects)', async () => {
  const { createHmac } = await import('node:crypto')
  const secret = 'test-hs256-secret'
  const header = base64Url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64Url({ sub: 'user-2', exp: Math.floor(Date.now() / 1000) + 3600 })
  const sig = base64Url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())
  const claims = await verifyJwt(`${header}.${payload}.${sig}`, { hs256Secret: secret })
  assert.equal(claims.sub, 'user-2')
})

test('verifyJwt rejects an unsupported algorithm', async () => {
  const header = base64Url({ alg: 'RS256', typ: 'JWT' })
  const payload = base64Url({ sub: 'user-3', exp: Math.floor(Date.now() / 1000) + 3600 })
  await assert.rejects(() => verifyJwt(`${header}.${payload}.fake`, { supabaseUrl: jwksUrl, hs256Secret: 'x' }), /Unsupported/)
})
