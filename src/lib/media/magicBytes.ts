/**
 * Magic-byte sniffing for uploaded media files.
 *
 * `file.type` is set by the browser from the file extension and can be
 * spoofed by a hostile client (e.g. renaming `payload.exe` → `photo.jpg`
 * still leaves `file.type === 'image/jpeg'` on most browsers, and a script
 * can override it outright). MIME-type whitelist alone is therefore not a
 * security check — it is a UX hint.
 *
 * This module reads the first 16 bytes of the file and matches them against
 * the canonical signature for each format we accept. It is the second leg
 * of the upload contract: if the bytes do not look like the claimed type,
 * the upload is rejected before any storage write.
 *
 * Signatures used:
 *   JPEG  : FF D8 FF                                 (any sub-marker)
 *   PNG   : 89 50 4E 47 0D 0A 1A 0A
 *   GIF   : 47 49 46 38 [37|39] 61                   ("GIF87a" / "GIF89a")
 *   WebP  : 52 49 46 46 .. .. .. .. 57 45 42 50      ("RIFF????WEBP")
 *   MP4 / QuickTime / HEIC: ?? ?? ?? ?? 66 74 79 70  ("ftyp" at offset 4)
 *                          followed by a 4-byte brand at offset 8.
 *   WebM  : 1A 45 DF A3                              (EBML header)
 *
 * HEIC is intentionally accepted: iOS 11+ captures HEIC by default, and the
 * native picker only auto-converts to JPEG when the WebView's `<input>`
 * uses an `image/*` wildcard. If an iPhone hands us raw HEIC, we still want
 * the upload to succeed rather than fail at the magic-byte gate.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SniffedMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/heic'
  | 'image/heif'
  | 'image/avif'
  | 'video/mp4'
  | 'video/quicktime'
  | 'video/webm'
  | 'application/pdf'
  | 'application/zip'
  | 'application/x-ole-storage'
  | 'unknown'

/** OOXML documents (.docx/.xlsx/.pptx) are ZIP containers — bytes sniff as application/zip. */
export const OOXML_DOCUMENT_MIMES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

/** Legacy Office (.doc/.xls/.ppt) are OLE2 compound files — bytes sniff as application/x-ole-storage. */
export const LEGACY_OFFICE_MIMES: readonly string[] = [
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]

/** Plain-text documents carry no binary signature — sniffed as 'unknown', allowed by claim only. */
export const TEXT_DOCUMENT_MIMES: readonly string[] = ['text/plain', 'text/csv']

export type MagicByteSniffResult =
  | {
      ok: true
      detected: SniffedMimeType
      /** True when the detected type matches the file.type passed by caller. */
      matchesClaimed: boolean
    }
  | {
      ok: false
      reason: string
    }

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/** Compares a slice of bytes against an expected sequence. `?` means wildcard. */
function matches(bytes: Uint8Array, offset: number, expected: readonly (number | '?')[]): boolean {
  if (offset + expected.length > bytes.length) return false
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]
    if (e === '?') continue
    if (bytes[offset + i] !== e) return false
  }
  return true
}

const ASCII = (s: string): readonly number[] => Array.from(s, (c) => c.charCodeAt(0))

/**
 * Maps an `ftyp` brand (4-character ASCII at offset 8 of an ISO base media
 * file) to the MIME type we report. Brands not listed here fall back to
 * generic MP4 — Apple uses the HEIC subset for photos.
 */
function mimeFromFtypBrand(brand: string): SniffedMimeType {
  const b = brand.toLowerCase().trim()
  if (b === 'heic' || b === 'heix' || b === 'heim' || b === 'heis') return 'image/heic'
  if (b === 'mif1' || b === 'msf1' || b === 'mif2' || b === 'msf2' || b === 'hevc' || b === 'hevx') return 'image/heif'
  if (b === 'avif' || b === 'avis') return 'image/avif'
  if (b === 'qt') return 'video/quicktime'
  return 'video/mp4'
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Identifies the format of a buffer by its first bytes. Returns
 * `'unknown'` when nothing matches — callers decide whether to reject.
 *
 * Pure function; takes the raw bytes so it can be called from tests
 * without a File polyfill.
 */
export function detectMagicBytes(bytes: Uint8Array): SniffedMimeType {
  // JPEG — any sub-marker
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'

  // PNG
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'

  // GIF87a / GIF89a
  if (matches(bytes, 0, ASCII('GIF87a'))) return 'image/gif'
  if (matches(bytes, 0, ASCII('GIF89a'))) return 'image/gif'

  // WebP — RIFF????WEBP
  if (matches(bytes, 0, ASCII('RIFF')) && matches(bytes, 8, ASCII('WEBP'))) {
    return 'image/webp'
  }

  // WebM — EBML header
  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'

  // ISO BMFF (MP4 / MOV / HEIC / AVIF) — `ftyp` box at offset 4, brand at offset 8
  if (matches(bytes, 4, ASCII('ftyp'))) {
    if (bytes.length < 12) return 'unknown'
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    return mimeFromFtypBrand(brand)
  }

  // PDF — "%PDF"
  if (matches(bytes, 0, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'

  // ZIP container — "PK\x03\x04" (local file), also empty/spanned variants.
  // OOXML documents (.docx/.xlsx/.pptx) are ZIP archives.
  if (
    matches(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    matches(bytes, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    matches(bytes, 0, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip'
  }

  // OLE2 compound binary — legacy Office (.doc/.xls/.ppt)
  if (matches(bytes, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/x-ole-storage'
  }

  return 'unknown'
}

// ---------------------------------------------------------------------------
// File API entry point
// ---------------------------------------------------------------------------

const HEADER_BYTES_TO_READ = 16

/**
 * Reads the first {@link HEADER_BYTES_TO_READ} bytes of a {@link File} and
 * sniffs its actual format, then compares against the MIME type the
 * browser/picker reported.
 *
 * Returns `{ ok: false }` only when bytes cannot be read at all (storage
 * failure). An unknown signature yields `ok: true, detected: 'unknown'`
 * with `matchesClaimed: false` — the caller decides how to react.
 */
export async function sniffFileMagicBytes(file: File): Promise<MagicByteSniffResult> {
  let bytes: Uint8Array
  try {
    const slice = file.slice(0, HEADER_BYTES_TO_READ)
    const buffer = await slice.arrayBuffer()
    bytes = new Uint8Array(buffer)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Datei konnte nicht gelesen werden.',
    }
  }

  if (bytes.length === 0) {
    return { ok: false, reason: 'Datei ist leer.' }
  }

  const detected = detectMagicBytes(bytes)
  const claimed = file.type.toLowerCase()

  // Treat HEIC/HEIF as interchangeable — iOS reports them under both names.
  const equivalent =
    detected === claimed ||
    (detected === 'image/heic' && (claimed === 'image/heic' || claimed === 'image/heif')) ||
    (detected === 'image/heif' && (claimed === 'image/heic' || claimed === 'image/heif')) ||
    // QuickTime files often arrive with the `video/mp4` MIME from Android
    // pickers; treat the ftyp container as interchangeable across MP4 brands.
    (detected === 'video/mp4' && claimed === 'video/quicktime') ||
    (detected === 'video/quicktime' && claimed === 'video/mp4') ||
    // OOXML docs (.docx/.xlsx/.pptx) ARE ZIP containers — bytes sniff as
    // application/zip but file.type carries the specific Office mime. Treat the
    // container as satisfying the claim (also a plain .zip claiming zip).
    (detected === 'application/zip' &&
      (claimed === 'application/zip' ||
        claimed === 'application/x-zip-compressed' ||
        OOXML_DOCUMENT_MIMES.includes(claimed))) ||
    // Legacy Office (.doc/.xls/.ppt) are OLE2 compound files.
    (detected === 'application/x-ole-storage' && LEGACY_OFFICE_MIMES.includes(claimed))

  return {
    ok: true,
    detected,
    matchesClaimed: equivalent,
  }
}
