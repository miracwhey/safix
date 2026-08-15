import { describe, it, expect } from 'vitest'
import { detectMagicBytes, sniffFileMagicBytes } from '../../src/lib/media/magicBytes'
import { runPreUploadPipeline } from '../../src/lib/media/preUploadPipeline'

// Real-world upload format coverage: documents (PDF / Office / text) and AVIF
// were rejected by the magic-byte gate. These lock in the robust support added
// alongside the bucket allowlist + content-type fixes.

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37] // "%PDF-1.7"
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00] // "PK\x03\x04" (OOXML/.docx)
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] // legacy Office (.doc/.xls)
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]
const AVIF = [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] // ftyp 'avif'

function fileFrom(bytes: number[], name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

describe('detectMagicBytes — document + AVIF signatures', () => {
  it('recognises PDF', () => expect(detectMagicBytes(new Uint8Array(PDF))).toBe('application/pdf'))
  it('recognises ZIP container (OOXML)', () => expect(detectMagicBytes(new Uint8Array(ZIP))).toBe('application/zip'))
  it('recognises OLE2 (legacy Office)', () => expect(detectMagicBytes(new Uint8Array(OLE))).toBe('application/x-ole-storage'))
  it('maps an AVIF ftyp brand to image/avif (not video/mp4)', () =>
    expect(detectMagicBytes(new Uint8Array(AVIF))).toBe('image/avif'))
})

describe('sniffFileMagicBytes — container claims', () => {
  it('a .docx (ZIP bytes) claiming the OOXML mime matchesClaimed', async () => {
    const f = fileFrom(ZIP, 'angebot.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const r = await sniffFileMagicBytes(f)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.detected).toBe('application/zip'); expect(r.matchesClaimed).toBe(true) }
  })
  it('a legacy .doc (OLE bytes) claiming application/msword matchesClaimed', async () => {
    const f = fileFrom(OLE, 'angebot.doc', 'application/msword')
    const r = await sniffFileMagicBytes(f)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.detected).toBe('application/x-ole-storage'); expect(r.matchesClaimed).toBe(true) }
  })
  it('a PDF claiming application/pdf matchesClaimed', async () => {
    const r = await sniffFileMagicBytes(fileFrom(PDF, 'rechnung.pdf', 'application/pdf'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.matchesClaimed).toBe(true)
  })
})

describe('runPreUploadPipeline — document + text passthrough, spoof guard', () => {
  it('passes a PDF through unchanged (was a hard reject)', async () => {
    const res = await runPreUploadPipeline(fileFrom(PDF, 'rechnung.pdf', 'application/pdf'))
    expect(res.ok).toBe(true)
    if (res.ok) { expect(res.file.type).toBe('application/pdf'); expect(res.diagnostics.compressed).toBe(false) }
  })
  it('passes a .docx (ZIP) through unchanged', async () => {
    const res = await runPreUploadPipeline(
      fileFrom(ZIP, 'angebot.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    )
    expect(res.ok).toBe(true)
  })
  it('passes a plain-text document through despite no magic signature', async () => {
    const res = await runPreUploadPipeline(
      new File(['Materialliste\n- Fliesen\n- Mörtel'], 'liste.txt', { type: 'text/plain' }),
    )
    expect(res.ok).toBe(true)
  })
  it('still rejects a spoof: JPEG bytes claiming application/pdf (anti-spoof preserved)', async () => {
    const res = await runPreUploadPipeline(fileFrom(JPEG, 'evil.pdf', 'application/pdf'))
    expect(res.ok).toBe(false)
  })
  it('still rejects a genuinely unknown binary', async () => {
    const res = await runPreUploadPipeline(fileFrom([0x00, 0x01, 0x02, 0x03], 'x.bin', 'application/octet-stream'))
    expect(res.ok).toBe(false)
  })
})
