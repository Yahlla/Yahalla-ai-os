import { createHmac, timingSafeEqual } from 'node:crypto'

// Verifies the HS256 JWTs Supabase Auth issues, using the project's JWT
// secret (Project Settings -> API -> JWT Secret in the Supabase
// dashboard). Hand-rolled rather than adding a dependency: HS256
// verification is exactly "recompute the HMAC, compare in constant time"
// -- a well-understood, small amount of code, and the only JWT operation
// this service needs (it never issues tokens, only verifies ones Supabase
// already signed). RS256/JWKS-based projects are a documented future
// extension point, not needed for the default Supabase JWT secret setup.

export type VerifiedClaims = {
  sub: string
  email?: string
  role?: string
  exp: number
  [key: string]: unknown
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64')
}

export class JwtVerificationError extends Error {}

export function verifyJwt(token: string, secret: string): VerifiedClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtVerificationError('Malformed token.')
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'))
  if (header.alg !== 'HS256') {
    throw new JwtVerificationError(`Unsupported JWT algorithm "${header.alg}" (only HS256 is supported).`)
  }

  const expectedSignature = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
  const actualSignature = base64UrlDecode(signatureB64)

  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw new JwtVerificationError('Invalid token signature.')
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
