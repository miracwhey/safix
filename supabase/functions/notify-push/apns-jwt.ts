/**
 * APNs JWT (ES256) builder.
 *
 * Pure helpers — no Deno / Node specifics, only Web Crypto SubtleCrypto. The
 * Deno runtime in Supabase Edge Functions and Node ≥20 (used in vitest)
 * both expose the same WebCrypto API, so this module is testable under
 * vitest without a Deno runner.
 *
 * APNs JWT spec: ES256 over `header.payload`, where:
 *   - header = { alg: "ES256", kid: <key id from Apple Developer> }
 *   - payload = { iss: <team id>, iat: <unix seconds>, exp? }
 *
 * Apple recommends caching the JWT for ~50 minutes (must rotate within an
 * hour). The cache lives at the call-site, not here — this module always
 * builds a fresh signature.
 */

const TEXT_ENCODER = new TextEncoder()

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(TEXT_ENCODER.encode(JSON.stringify(obj)))
}

/** Decodes a PEM-wrapped PKCS#8 private key into raw DER bytes. */
export function pemToPkcs8Bytes(pem: string): Uint8Array {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  if (cleaned.length === 0) {
    throw new Error('apns-jwt: empty PEM input')
  }
  const bin = atob(cleaned)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function importApnsPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8Bytes(pem)
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

export type BuildJwtArgs = {
  key: CryptoKey
  keyId: string
  teamId: string
  /** Override for testing — defaults to current unix seconds. */
  nowSeconds?: number
}

/**
 * Builds a fresh APNs JWT. The signature uses raw R || S concatenation
 * (64 bytes for P-256) — that's the WebCrypto default for ECDSA, which
 * matches the JOSE/APNs requirement.
 */
export async function buildApnsJwt(args: BuildJwtArgs): Promise<string> {
  const { key, keyId, teamId } = args
  if (!keyId) throw new Error('apns-jwt: keyId required')
  if (!teamId) throw new Error('apns-jwt: teamId required')

  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' }
  const iat = Math.floor((args.nowSeconds ?? Date.now() / 1000))
  const payload = { iss: teamId, iat }

  const headerB64 = base64UrlEncodeJson(header)
  const payloadB64 = base64UrlEncodeJson(payload)
  const signingInput = `${headerB64}.${payloadB64}`

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    TEXT_ENCODER.encode(signingInput),
  )
  const sigB64 = base64UrlEncode(new Uint8Array(signature))
  return `${signingInput}.${sigB64}`
}

/**
 * Decodes a JWT into its three parts without verifying the signature.
 * Used only by tests — APNs verifies the signature server-side.
 */
export function decodeJwtParts(jwt: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signatureBytes: number
} {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    throw new Error('decodeJwtParts: malformed JWT')
  }
  const decode = (s: string): Record<string, unknown> => {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    return JSON.parse(atob(padded + '='.repeat(padLen)))
  }
  const sigPadded = parts[2].replace(/-/g, '+').replace(/_/g, '/')
  const sigPadLen = (4 - (sigPadded.length % 4)) % 4
  const sigBin = atob(sigPadded + '='.repeat(sigPadLen))
  return {
    header: decode(parts[0]),
    payload: decode(parts[1]),
    signatureBytes: sigBin.length,
  }
}
