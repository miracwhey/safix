/**
 * APNs JWT builder — pure WebCrypto, runs the same code path under Node 20+
 * (vitest) and Deno (Edge Function runtime).
 *
 * The test key is a freshly-generated P-256 PKCS#8 key — never used against
 * real APNs. We do NOT round-trip through APNs in tests; instead we verify:
 *   1. PEM stripping yields valid PKCS#8 bytes that SubtleCrypto accepts.
 *   2. Header/payload claims match the APNs spec.
 *   3. Signature is 64 bytes (R || S, raw — what APNs requires).
 *   4. Signature verifies against the corresponding public key.
 */

import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'

import {
  buildApnsJwt,
  decodeJwtParts,
  importApnsPrivateKey,
  pemToPkcs8Bytes,
} from '../../supabase/functions/notify-push/apns-jwt.ts'

// Polyfill crypto on the global so the Edge module sees it under Node.
// Node ≥20 has it, but vitest's environment can vary.
if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  ;(globalThis as { crypto: unknown }).crypto = webcrypto
}

async function generateTestKeyPair(): Promise<{ pkcs8Pem: string; publicKey: CryptoKey }> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  let bin = ''
  for (let i = 0; i < pkcs8.length; i++) bin += String.fromCharCode(pkcs8[i])
  const b64 = btoa(bin)
  // Wrap to 64-char lines like a real .p8 file.
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
  return { pkcs8Pem, publicKey: kp.publicKey }
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + '='.repeat(padLen))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

describe('pemToPkcs8Bytes', () => {
  it('strips PEM markers and whitespace into valid base64', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const bytes = pemToPkcs8Bytes(pkcs8Pem)
    expect(bytes.length).toBeGreaterThan(50)
  })

  it('throws on empty input', () => {
    expect(() => pemToPkcs8Bytes('')).toThrow(/empty PEM/)
  })

  it('handles real-world line wrapping (no surrounding whitespace)', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const noNewlines = pkcs8Pem.replace(/\n/g, '')
    expect(() => pemToPkcs8Bytes(noNewlines)).not.toThrow()
  })
})

describe('importApnsPrivateKey', () => {
  it('imports a P-256 PKCS#8 PEM into a sign-capable CryptoKey', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    expect(key.type).toBe('private')
    expect(key.algorithm.name).toBe('ECDSA')
  })
})

describe('buildApnsJwt', () => {
  it('produces three dot-separated parts', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    const jwt = await buildApnsJwt({ key, keyId: 'VMUD73M4W7', teamId: 'KXJRXU59ZB' })
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('encodes the APNs-required header claims (alg=ES256, kid, typ=JWT)', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    const jwt = await buildApnsJwt({ key, keyId: 'KEYID12345', teamId: 'TEAM123456' })
    const { header } = decodeJwtParts(jwt)
    expect(header.alg).toBe('ES256')
    expect(header.kid).toBe('KEYID12345')
    expect(header.typ).toBe('JWT')
  })

  it('encodes iss=teamId and iat (unix seconds)', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    const jwt = await buildApnsJwt({
      key,
      keyId: 'K1',
      teamId: 'TEAMABC',
      nowSeconds: 1_700_000_000,
    })
    const { payload } = decodeJwtParts(jwt)
    expect(payload.iss).toBe('TEAMABC')
    expect(payload.iat).toBe(1_700_000_000)
  })

  it('produces a 64-byte raw R||S ECDSA signature (APNs requirement)', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    const jwt = await buildApnsJwt({ key, keyId: 'K1', teamId: 'T1' })
    const { signatureBytes } = decodeJwtParts(jwt)
    expect(signatureBytes).toBe(64)
  })

  it('signature verifies against the matching public key', async () => {
    const { pkcs8Pem, publicKey } = await generateTestKeyPair()
    const privateKey = await importApnsPrivateKey(pkcs8Pem)
    const jwt = await buildApnsJwt({ key: privateKey, keyId: 'K1', teamId: 'T1' })
    const [h, p, s] = jwt.split('.')
    const data = new TextEncoder().encode(`${h}.${p}`)
    const sig = base64UrlToBytes(s)
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      publicKey,
      sig,
      data,
    )
    expect(ok).toBe(true)
  })

  it('throws when keyId or teamId is missing', async () => {
    const { pkcs8Pem } = await generateTestKeyPair()
    const key = await importApnsPrivateKey(pkcs8Pem)
    await expect(buildApnsJwt({ key, keyId: '', teamId: 'T1' })).rejects.toThrow(/keyId/)
    await expect(buildApnsJwt({ key, keyId: 'K1', teamId: '' })).rejects.toThrow(/teamId/)
  })
})
