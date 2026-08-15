/**
 * FU.7 — HEIC decode branch tests.
 *
 * The main preUploadPipeline tests run in Node (no DOM → canCompressInThisEnvironment()
 * returns false → HEIC pass-through). This file stubs the DOM globals so the
 * HEIC decode branch actually executes, and mocks heic2any to avoid a real
 * browser decode engine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const heic2anyMock = vi.fn()

vi.mock('heic2any', () => ({
  default: heic2anyMock,
}))
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('browser-image-compression', () => ({
  default: vi.fn(async (file: File) => file),
}))

import { runPreUploadPipeline } from '../../src/lib/media/preUploadPipeline'

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

function heicFile(name = 'photo.heic', type = 'image/heic'): File {
  const header = [0, 0, 0, 0x20, ...ascii('ftypheic'), 0, 0, 0, 0]
  const buf = new Uint8Array(64)
  buf.set(header)
  return new File([buf], name, { type })
}

// Stub minimal DOM globals so canCompressInThisEnvironment() returns true.
beforeEach(() => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { createElement: vi.fn() })
  heic2anyMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FU.7 — HEIC decode branch (with DOM)', () => {
  it('decodes HEIC to JPEG when heic2any succeeds', async () => {
    const jpegBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
    heic2anyMock.mockResolvedValue(jpegBlob)

    const file = heicFile()
    const result = await runPreUploadPipeline(file)

    expect(heic2anyMock).toHaveBeenCalledWith(
      expect.objectContaining({ blob: file, toType: 'image/jpeg' }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.type).toBe('image/jpeg')
      expect(result.diagnostics.compressed).toBe(true)
      expect(result.diagnostics.sniffedType).toBe('image/heic')
    }
  })

  it('handles heic2any returning a Blob array (multi-frame)', async () => {
    const jpegBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
    heic2anyMock.mockResolvedValue([jpegBlob, jpegBlob])

    const result = await runPreUploadPipeline(heicFile())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.type).toBe('image/jpeg')
    }
  })

  it('returns ok:false when heic2any throws (no silent GPS passthrough)', async () => {
    const { logWarning } = await import('../../src/lib/observability')
    heic2anyMock.mockRejectedValue(new Error('unsupported codec'))

    const result = await runPreUploadPipeline(heicFile())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/HEIC-Foto/)
    }
    expect(logWarning).toHaveBeenCalledWith(
      'media.pipeline_heic_decode_failed',
      expect.objectContaining({ error: 'unsupported codec' }),
    )
  })

  it('also decodes HEIF files (image/heif variant)', async () => {
    const jpegBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
    heic2anyMock.mockResolvedValue(jpegBlob)

    const heifHeader = [0, 0, 0, 0x18, ...ascii('ftypmif1'), 0, 0, 0, 0]
    const buf = new Uint8Array(64)
    buf.set(heifHeader)
    const heif = new File([buf], 'photo.heif', { type: 'image/heif' })

    const result = await runPreUploadPipeline(heif)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.diagnostics.sniffedType).toBe('image/heif')
    }
  })
})
