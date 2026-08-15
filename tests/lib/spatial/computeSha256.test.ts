import { describe, it, expect } from 'vitest'
import { computeSha256 } from '../../../src/lib/spatial/storage/computeSha256'

describe('computeSha256', () => {
  it('returns the SHA-256 of an empty blob (deterministic)', async () => {
    const hex = await computeSha256(new Blob([]))
    // Standard SHA-256("") fixture
    expect(hex).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('returns the SHA-256 of "abc" (RFC 6234 test vector)', async () => {
    const hex = await computeSha256(new Blob(['abc']))
    expect(hex).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('produces identical digests for identical bytes regardless of MIME', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02])
    const a = await computeSha256(new Blob([bytes], { type: 'model/vnd.usdz+zip' }))
    const b = await computeSha256(new Blob([bytes], { type: 'application/octet-stream' }))
    expect(a).toBe(b)
  })

  it('produces different digests for different bytes', async () => {
    const a = await computeSha256(new Blob([new Uint8Array([0x00])]))
    const b = await computeSha256(new Blob([new Uint8Array([0x01])]))
    expect(a).not.toBe(b)
  })
})
