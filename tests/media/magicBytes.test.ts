import { describe, it, expect } from 'vitest'
import { detectMagicBytes, sniffFileMagicBytes } from '../../src/lib/media/magicBytes'

// ---------------------------------------------------------------------------
// Helpers — produce minimal but valid headers for each format
// ---------------------------------------------------------------------------

function bytes(...nums: number[]): Uint8Array {
  return new Uint8Array(nums)
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

function jpegHeader(): Uint8Array {
  // FF D8 FF E0 (JFIF) — first 4 bytes of any JPEG
  return bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 0x48)
}

function pngHeader(): Uint8Array {
  return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52)
}

function gif89aHeader(): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0, 0, 0])
}

function webpHeader(): Uint8Array {
  // RIFF<size>WEBP
  return new Uint8Array([...ascii('RIFF'), 0x1c, 0, 0, 0, ...ascii('WEBP'), 0x56, 0x50, 0x38, 0x4c])
}

function webmHeader(): Uint8Array {
  // EBML magic
  return bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2, 0x81)
}

function ftypHeader(brand: string): Uint8Array {
  // 4-byte size, then 'ftyp', then 4-byte brand
  const brandBytes = brand.padEnd(4).slice(0, 4)
  return new Uint8Array([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii(brandBytes), 0, 0, 0, 0])
}

function fileFromBytes(name: string, type: string, header: Uint8Array, padTo = 64): File {
  const out = new Uint8Array(Math.max(header.length, padTo))
  out.set(header)
  return new File([out], name, { type })
}

// ---------------------------------------------------------------------------
// detectMagicBytes — pure function
// ---------------------------------------------------------------------------

describe('detectMagicBytes', () => {
  it('detects JPEG from FF D8 FF marker', () => {
    expect(detectMagicBytes(jpegHeader())).toBe('image/jpeg')
  })

  it('detects PNG from full 8-byte signature', () => {
    expect(detectMagicBytes(pngHeader())).toBe('image/png')
  })

  it('detects GIF89a', () => {
    expect(detectMagicBytes(gif89aHeader())).toBe('image/gif')
  })

  it('detects GIF87a', () => {
    const header = new Uint8Array([...ascii('GIF87a'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMagicBytes(header)).toBe('image/gif')
  })

  it('detects WebP from RIFF/WEBP container', () => {
    expect(detectMagicBytes(webpHeader())).toBe('image/webp')
  })

  it('detects WebM from EBML signature', () => {
    expect(detectMagicBytes(webmHeader())).toBe('video/webm')
  })

  it('detects MP4 from ftyp+isom brand', () => {
    expect(detectMagicBytes(ftypHeader('isom'))).toBe('video/mp4')
  })

  it('detects QuickTime from ftyp+qt   brand', () => {
    expect(detectMagicBytes(ftypHeader('qt  '))).toBe('video/quicktime')
  })

  it('detects HEIC from ftyp+heic brand', () => {
    expect(detectMagicBytes(ftypHeader('heic'))).toBe('image/heic')
  })

  it('detects HEIF from ftyp+mif1 brand', () => {
    expect(detectMagicBytes(ftypHeader('mif1'))).toBe('image/heif')
  })

  it('returns unknown for arbitrary bytes', () => {
    expect(detectMagicBytes(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBe('unknown')
  })

  it('returns unknown for an empty buffer', () => {
    expect(detectMagicBytes(new Uint8Array(0))).toBe('unknown')
  })

  it('returns unknown when ftyp is present but truncated before the brand', () => {
    const truncated = new Uint8Array([0, 0, 0, 0x20, ...ascii('ftyp')])
    expect(detectMagicBytes(truncated)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// sniffFileMagicBytes — File API roundtrip
// ---------------------------------------------------------------------------

describe('sniffFileMagicBytes', () => {
  it('matches when claimed JPEG MIME aligns with the bytes', async () => {
    const file = fileFromBytes('photo.jpg', 'image/jpeg', jpegHeader())
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detected).toBe('image/jpeg')
      expect(result.matchesClaimed).toBe(true)
    }
  })

  it('flags a mismatch when bytes do not match the claimed MIME', async () => {
    // Claims image/jpeg but bytes are PNG → spoofing attempt
    const file = fileFromBytes('payload.jpg', 'image/jpeg', pngHeader())
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detected).toBe('image/png')
      expect(result.matchesClaimed).toBe(false)
    }
  })

  it('treats HEIC and HEIF as interchangeable on iOS', async () => {
    const file = fileFromBytes('img.heic', 'image/heif', ftypHeader('heic'))
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detected).toBe('image/heic')
      expect(result.matchesClaimed).toBe(true)
    }
  })

  it('treats QuickTime / MP4 ftyp as interchangeable', async () => {
    const file = fileFromBytes('clip.mov', 'video/mp4', ftypHeader('qt  '))
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detected).toBe('video/quicktime')
      expect(result.matchesClaimed).toBe(true)
    }
  })

  it('returns ok=false for an empty file', async () => {
    const file = new File([], 'empty.jpg', { type: 'image/jpeg' })
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(false)
  })

  it('reports unknown for random bytes claimed as JPEG', async () => {
    const file = fileFromBytes('random.jpg', 'image/jpeg', bytes(0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4))
    const result = await sniffFileMagicBytes(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.detected).toBe('unknown')
      expect(result.matchesClaimed).toBe(false)
    }
  })
})
