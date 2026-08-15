import { describe, it, expect } from 'vitest'
import { runPreUploadPipeline } from '../../src/lib/media/preUploadPipeline'

// ---------------------------------------------------------------------------
// Helpers — minimum-viable file headers for the formats we accept.
// ---------------------------------------------------------------------------

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

function fileFromHeader(name: string, type: string, header: number[], padTo = 64): File {
  const total = Math.max(header.length, padTo)
  const buf = new Uint8Array(total)
  buf.set(header)
  return new File([buf], name, { type })
}

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF'), 0, 1, 1]
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MP4_FTYP_HEADER = [0, 0, 0, 0x20, ...ascii('ftypisom'), 0, 0, 0, 0]

// ---------------------------------------------------------------------------
// Tests — these run in node, so the compression branch is short-circuited
// by the canCompressInThisEnvironment() guard. We validate the gating
// behaviour (magic-byte + pass-through) here; integration of the full
// Canvas roundtrip belongs in a browser-environment test.
// ---------------------------------------------------------------------------

describe('runPreUploadPipeline', () => {
  it('passes a JPEG through unchanged in non-browser environments', async () => {
    const file = fileFromHeader('photo.jpg', 'image/jpeg', JPEG_HEADER)
    const result = await runPreUploadPipeline(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file).toBe(file)
      expect(result.diagnostics.compressed).toBe(false)
      expect(result.diagnostics.sniffedType).toBe('image/jpeg')
    }
  })

  it('rejects files whose bytes contradict the claimed MIME (spoofing)', async () => {
    // Claims image/jpeg but the bytes are PNG.
    const spoofed = fileFromHeader('payload.jpg', 'image/jpeg', PNG_HEADER)
    const result = await runPreUploadPipeline(spoofed)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/passt nicht zum Inhalt/)
    }
  })

  it('rejects files whose bytes match no known signature', async () => {
    const garbage = fileFromHeader('mystery.jpg', 'image/jpeg', [1, 2, 3, 4, 5, 6, 7, 8])
    const result = await runPreUploadPipeline(garbage)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/nicht erkannt/)
    }
  })

  it('rejects an empty file at the magic-byte stage', async () => {
    const empty = new File([], 'empty.jpg', { type: 'image/jpeg' })
    const result = await runPreUploadPipeline(empty)
    expect(result.ok).toBe(false)
  })

  it('passes MP4 video through without attempting compression', async () => {
    const video = fileFromHeader('clip.mp4', 'video/mp4', MP4_FTYP_HEADER, 128)
    const result = await runPreUploadPipeline(video)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file).toBe(video)
      expect(result.diagnostics.compressed).toBe(false)
      expect(result.diagnostics.sniffedType).toBe('video/mp4')
    }
  })

  it('treats HEIC photos as pass-through (no client transcode)', async () => {
    const heic = fileFromHeader(
      'img.heic',
      'image/heic',
      [0, 0, 0, 0x20, ...ascii('ftypheic'), 0, 0, 0, 0],
      64
    )
    const result = await runPreUploadPipeline(heic)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file).toBe(heic)
      expect(result.diagnostics.sniffedType).toBe('image/heic')
    }
  })
})
