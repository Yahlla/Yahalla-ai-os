import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto'

// Verifies the JWTs Supabase Auth issues. Supabase projects sign tokens
// one of two ways depending on when/how the project was set up:
//   - HS256, with a single shared secret (Project Settings -> API ->
//     JWT Secret / "Legacy JWT Secret").
//   - ES256, with an asymmetric keypair Supabase manages (newer default),
//     verified against the project's published public keys (JWKS) --
//     nothing secret to configure here at all, just the project's own
//     public URL.
// The algorithm is read from each token's own header and dispatched
// accordingly, so a deployment works against either kind of Supabase
// project without needing to know in advance which one it's using.

export type VerifiedClaims = {
  sub: string
  email?: string
  role?: string
  exp: number
  [key: string]: unknown
}

export class JwtVerificationError extends Error {}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64')
}

function verifyHs256(headerB64: string, payloadB64: string, signatureB64: string, secret: string): void {
  const expectedSignature = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
  const actualSignature = base64UrlDecode(signatureB64)
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) {
    throw new JwtVerificationError('Invalid token signature.')
  }
}

type Jwk = { kty: string; crv: string; x: string; y: string; kid: string }

// Supabase's JWKS rarely changes (only on manual key rotation) -- cached
// for a while per process rather than refetched on every single request,
// with a short TTL so a real rotation is picked up without a restart.
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>()
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000

async function fetchJwks(supabaseUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(supabaseUrl)
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) return cached.keys

  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`)
  if (!response.ok) {
    throw new JwtVerificationError(`Could not fetch Supabase's JWKS (HTTP ${response.status}).`)
  }
  const data = (await response.json()) as { keys?: Jwk[] }
  const keys = data.keys ?? []
  jwksCache.set(supabaseUrl, { keys, fetchedAt: Date.now() })
  return keys
}

function jwkToPublicKey(jwk: Jwk): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' })
}

async function verifyEs256(
  headerB64: string,
  payloadB64: string,
  signatureB64: string,
  kid: string | undefined,
  supabaseUrl: string | undefined,
): Promise<void> {
  if (!supabaseUrl) {
    throw new JwtVerificationError('This project signs tokens with ES256, but SUPABASE_URL is not configured -- cannot fetch its public keys to verify them.')
  }
  const keys = await fetchJwks(supabaseUrl)
  const jwk = (kid ? keys.find((k) => k.kid === kid) : keys[0]) ?? keys[0]
  if (!jwk) throw new JwtVerificationError("Supabase's JWKS has no matching signing key.")

  const publicKey = jwkToPublicKey(jwk)
  // JWT/JOSE ES256 signatures are the raw r||s concatenation ("IEEE
  // P1363"), not the ASN.1 DER encoding node's crypto.verify assumes by
  // default for EC keys -- passing dsaEncoding explicitly is required or
  // every real Supabase-issued signature fails to verify even though
  // it's entirely valid.
  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(signatureB64),
  )
  if (!ok) throw new JwtVerificationError('Invalid token signature.')
}

export async function verifyJwt(
  token: string,
  config: { hs256Secret?: string; supabaseUrl?: string },
): Promise<VerifiedClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtVerificationError('Malformed token.')
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg: string; kid?: string }

  if (header.alg === 'HS256') {
    if (!config.hs256Secret) throw new JwtVerificationError('This project signs tokens with HS256, but no SUPABASE_JWT_SECRET is configured.')
    verifyHs256(headerB64, payloadB64, signatureB64, config.hs256Secret)
  } else if (header.alg === 'ES256') {
    await verifyEs256(headerB64, payloadB64, signatureB64, header.kid, config.supabaseUrl)
  } else {
    throw new JwtVerificationError(`Unsupported JWT algorithm "${header.alg}" (only HS256 and ES256 are supported).`)
  }

  const claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as VerifiedClaims

  if (typeof claims.exp === 'number' && Date.now() / 1000 > claims.exp) {
    throw new JwtVerificationError('Token has expired.')
  }
  if (!claims.sub) {
    throw new JwtVerificationError('Token has no subject (sub) claim.')
  }

  return claims
}
