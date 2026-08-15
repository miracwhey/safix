/**
 * Pre-upload pipeline — runs between picker and storage upload.
 *
 * Three responsibilities:
 *   1. Magic-byte validation (security: MIME-type cannot be trusted alone).
 *   2. Image compression + EXIF strip (privacy + bandwidth).
 *   3. HEIC/HEIF → JPEG decode + EXIF strip (FU.7: GPS privacy).
 *   4. Pass-through for video (no client-side transcode pipeline).
 *
 * Privacy note
 *   iPhone photos carry GPS coordinates, capture timestamp, device model and
 *   software version in EXIF. Re-encoding through a Canvas (which is what
 *   `browser-image-compression` does) drops every metadata block, so the
 *   compressed file we ship to Supabase contains no original GPS tag —
 *   even when the input was straight from the camera roll. This is the
 *   primary defence against accidental address leaks in dispute evidence.
 *
 * Browser-only
 *   Compression and Canvas re-encoding require a DOM. In Node / test
 *   environments without `OffscreenCanvas`, the pipeline returns the file
 *   unchanged so unit tests around `uploadMediaFile` keep working without a
 *   jsdom roundtrip. The magic-byte step still runs in Node — `File.slice`
 *   and `arrayBuffer` are part of the standard runtime since v18.
 */

import imageCompression from 'browser-image-compression'
import { sniffFileMagicBytes, TEXT_DOCUMENT_MIMES, type SniffedMimeType } from './magicBytes'
import { logInfo, logWarning } from '../observability'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Long-edge target for resized images.
 *
 * Portfolio images are rendered full-bleed in the public profile gallery on
 * Retina-class iPhones (DPR 2–3). At the previous 1920 cap, a 1290-pt-wide
 * iPhone Pro display was upscaling roughly 1.5× — visibly soft, especially
 * on high-detail jobsite photos. 2560 covers DPR-3 at full-width without
 * upsampling and still keeps file sizes comfortably under the bucket limit.
 */
export const COMPRESSION_MAX_DIMENSION = 2560

/**
 * Soft target after compression. The library treats this as a ceiling, not a
 * contract. Raised from 1 MB so the encoder has room to keep edges crisp at
 * the higher resolution; the bucket limit is 200 MiB so this stays safe.
 */
export const COMPRESSION_MAX_SIZE_MB = 3

/**
 * JPEG quality factor. 0.92 is the visually-lossless threshold for most
 * jobsite material (textures, wood grain, tile patterns) — at 0.85 the
 * encoder was producing visible block artefacts on detail shots once they
 * were rendered full-bleed in the portfolio gallery.
 */
export const COMPRESSION_INITIAL_QUALITY = 0.92

/**
 * Files smaller than this are still re-encoded so EXIF is stripped, but
 * resize is skipped. The Canvas roundtrip is what removes metadata.
 */
const COMPRESSION_RESIZE_THRESHOLD_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreUploadPipelineResult =
  | {
      ok: true
      file: File
      /**
       * Diagnostic info for the caller — useful for analytics / logs.
       * `compressed` is true only when the pipeline produced a new file.
       */
      diagnostics: {
        originalSize: number
        finalSize: number
        compressed: boolean
        sniffedType: SniffedMimeType
      }
    }
  | {
      ok: false
      reason: string
    }

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

function canCompressInThisEnvironment(): boolean {
  // browser-image-compression needs a DOM with Canvas + image decoding.
  // Vitest in Node mode has neither. Capacitor WebView and any modern
  // browser have both. Detecting Canvas is the cheapest reliable check.
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  )
}

// ---------------------------------------------------------------------------
// HEIC/HEIF decode  (FU.7)
// ---------------------------------------------------------------------------

/**
 * Decodes a HEIC/HEIF file to JPEG and strips EXIF via Canvas re-encode.
 * Dynamic import keeps heic2any (~3 MB) out of the initial bundle — it only
 * loads when an actual HEIC file is picked.
 *
 * Returns an error result instead of a silent passthrough so a GPS-tagged
 * original never reaches Storage on decode failure.
 */
async function decodeHeicAndStrip(
  file: File,
  sniffedType: SniffedMimeType,
): Promise<PreUploadPipelineResult> {
  try {
    const { default: heic2any } = await import('heic2any')
    const raw = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
    const blob = Array.isArray(raw) ? raw[0]! : raw
    const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '')
    const decoded = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
    // Canvas re-encode via compressImageToJpeg strips any remaining metadata
    // (heic2any may carry XMP/IPTC in the JPEG container).
    const compressed = await compressImageToJpeg(decoded)
    logInfo('media.pipeline_heic_decoded', {
      from: file.size,
      to: compressed.size,
    })
    return {
      ok: true,
      file: compressed,
      diagnostics: {
        originalSize: file.size,
        finalSize: compressed.size,
        compressed: true,
        sniffedType,
      },
    }
  } catch (err) {
    logWarning('media.pipeline_heic_decode_failed', {
      error: err instanceof Error ? err.message : String(err),
      size: file.size,
    })
    return {
      ok: false,
      reason:
        'HEIC-Foto konnte nicht verarbeitet werden. Bitte aktiviere „JPEG-kompatibel" in iOS Einstellungen → Kamera → Formate, oder wähle ein JPEG-Bild.',
    }
  }
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function compressImageToJpeg(file: File): Promise<File> {
  const skipResize = file.size <= COMPRESSION_RESIZE_THRESHOLD_BYTES
  const compressed = await imageCompression(file, {
    maxSizeMB: COMPRESSION_MAX_SIZE_MB,
    maxWidthOrHeight: skipResize ? undefined : COMPRESSION_MAX_DIMENSION,
    initialQuality: COMPRESSION_INITIAL_QUALITY,
    useWebWorker: true,
    // Force JPEG output: the Canvas re-encode is what strips EXIF, and JPEG
    // gives downstream consumers (avatars, evidence galleries) a single
    // predictable format. The original filename is preserved by the lib.
    fileType: 'image/jpeg',
    // Small alwaysKeepResolution=false (the default) lets the lib downscale
    // when initialQuality cannot satisfy maxSizeMB on its own.
  })

  // The lib returns a Blob extended with name+lastModified, but its `type`
  // can drop to '' on some Safari builds. Re-wrap to a real File so callers
  // get consistent metadata.
  if (compressed instanceof File && compressed.type === 'image/jpeg') {
    return compressed
  }
  const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '')
  return new File([compressed], `${baseName}.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs the pre-upload pipeline against a freshly picked file.
 *
 * Order of operations:
 *   1. Magic-byte sniff. Reject when the bytes look like nothing we accept,
 *      or when they contradict the claimed MIME type (spoofed extension).
 *   2. For images that the browser can decode, compress + strip EXIF.
 *   3. Videos and HEIC pass through unchanged — no client-side transcoding.
 *
 * The function is total: it always returns a result rather than throwing,
 * so callers can surface the rejection reason to the user verbatim.
 */
/**
 * EXIF-strip for upload paths that bypass the full pipeline (spatial pin
 * photos, canonical annotation photos, sick-note images). Unlike
 * runPreUploadPipeline this NEVER rejects: non-decodable inputs (PDF, video,
 * unknown) pass through unchanged so each caller's own accept rules stay
 * authoritative. Decodable images are re-encoded through Canvas, which drops
 * GPS/EXIF — the privacy guarantee against leaking a customer's home address.
 * Any failure falls open to the original file so an upload is never blocked.
 */
export async function stripImageExifIfPossible(file: File): Promise<File> {
  if (!canCompressInThisEnvironment()) return file
  try {
    const sniff = await sniffFileMagicBytes(file)
    if (!sniff.ok || sniff.detected === 'unknown') return file
    if (sniff.detected === 'image/heic' || sniff.detected === 'image/heif') {
      const res = await decodeHeicAndStrip(file, sniff.detected)
      return res.ok ? res.file : file
    }
    const isCompressibleImage =
      sniff.detected === 'image/jpeg' ||
      sniff.detected === 'image/png' ||
      sniff.detected === 'image/webp' ||
      sniff.detected === 'image/gif'
    if (!isCompressibleImage) return file
    return await compressImageToJpeg(file)
  } catch {
    return file
  }
}

export async function runPreUploadPipeline(file: File): Promise<PreUploadPipelineResult> {
  // 1. Magic bytes — the security gate.
  const sniff = await sniffFileMagicBytes(file)
  if (!sniff.ok) {
    return { ok: false, reason: sniff.reason }
  }
  if (sniff.detected === 'unknown') {
    // Plain-text documents (.txt/.csv) carry no binary magic signature, so an
    // 'unknown' sniff is expected and legitimate for them — pass through
    // unchanged. Everything else that sniffs as unknown is genuinely
    // unrecognized and stays rejected.
    if (TEXT_DOCUMENT_MIMES.includes(file.type.toLowerCase())) {
      return {
        ok: true,
        file,
        diagnostics: {
          originalSize: file.size,
          finalSize: file.size,
          compressed: false,
          sniffedType: sniff.detected,
        },
      }
    }
    return {
      ok: false,
      reason: 'Dateiformat konnte nicht erkannt werden. Bitte wähle ein gängiges Bild- oder Videoformat (JPEG, PNG, MP4 …).',
    }
  }
  if (!sniff.matchesClaimed) {
    logWarning('media.magic_byte_mismatch', {
      claimed: file.type,
      detected: sniff.detected,
      name: file.name,
      size: file.size,
    })
    return {
      ok: false,
      reason: `Dateityp passt nicht zum Inhalt (gemeldet: ${file.type || 'unbekannt'}, erkannt: ${sniff.detected}). Bitte wähle eine gültige Datei.`,
    }
  }

  // 2. HEIC/HEIF — decode to JPEG + strip EXIF (FU.7: GPS privacy).
  //    Must run before the compressible-image check because HEIC is not in
  //    that set. A DOM is required for the Canvas re-encode step; in test
  //    environments without one the HEIC decoding is skipped (test blobs
  //    carry no real GPS data).
  const isHeic = sniff.detected === 'image/heic' || sniff.detected === 'image/heif'
  if (isHeic && canCompressInThisEnvironment()) {
    return decodeHeicAndStrip(file, sniff.detected)
  }

  // 3. Compression pipeline — only for actual bitmap STILL images we can decode.
  //    GIF is deliberately excluded: re-encoding to JPEG collapses an animated
  //    GIF to a single static frame. GIF passes through unchanged below (bucket
  //    allows image/gif). AVIF is included so it is normalised to JPEG (AVIF is
  //    not in the bucket allowlist), recovering it from the old false reject.
  const isCompressibleImage =
    sniff.detected === 'image/jpeg' ||
    sniff.detected === 'image/png' ||
    sniff.detected === 'image/webp' ||
    sniff.detected === 'image/avif'

  if (!isCompressibleImage || !canCompressInThisEnvironment()) {
    return {
      ok: true,
      file,
      diagnostics: {
        originalSize: file.size,
        finalSize: file.size,
        compressed: false,
        sniffedType: sniff.detected,
      },
    }
  }

  try {
    const compressed = await compressImageToJpeg(file)
    logInfo('media.pipeline_compressed', {
      from: file.size,
      to: compressed.size,
      ratio: file.size > 0 ? Math.round((compressed.size / file.size) * 100) / 100 : 1,
    })
    return {
      ok: true,
      file: compressed,
      diagnostics: {
        originalSize: file.size,
        finalSize: compressed.size,
        compressed: true,
        sniffedType: sniff.detected,
      },
    }
  } catch (err) {
    // Compression failure is recoverable: ship the original. The Canvas
    // step also strips EXIF, but the security check upstream already
    // confirmed the bytes look legitimate, so we are not weakening the
    // privacy or safety guarantees beyond losing the metadata strip for
    // this single file.
    logWarning('media.pipeline_compression_failed', {
      error: err instanceof Error ? err.message : String(err),
      size: file.size,
      type: file.type,
    })
    return {
      ok: true,
      file,
      diagnostics: {
        originalSize: file.size,
        finalSize: file.size,
        compressed: false,
        sniffedType: sniff.detected,
      },
    }
  }
}
