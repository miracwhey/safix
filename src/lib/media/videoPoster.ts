/**
 * Video poster-frame extraction.
 *
 * Why
 *   iPhone-recorded videos default to HEVC inside a `.mov` container. iOS
 *   Safari plays them natively but Chrome on Android cannot decode HEVC —
 *   the `<video>` tile shows black until the browser gives up, and the
 *   customer perceives the upload as broken. A static JPEG poster captured
 *   from the first decodable frame guarantees the cover image is visible
 *   on every platform, even when the codec itself does not play.
 *
 * How
 *   Load the file into a hidden `<video>` element via an object URL, seek
 *   to the first half-second so the frame is past the leading black, draw
 *   it onto a Canvas at the video's intrinsic resolution and read it back
 *   as a JPEG `File`. The Canvas roundtrip also strips any container-side
 *   metadata so the poster carries no GPS / device-tag, matching the
 *   privacy guarantees the bitmap-image pipeline provides.
 *
 * When it returns null
 *   - The browser cannot decode the video at all (HEVC on a desktop Chrome
 *     building the upload from a drag-and-drop, fringe codec on Android).
 *   - The DOM environment has no Canvas (Vitest in Node mode).
 *   - The video element times out before reporting a usable frame.
 *   In all of these the caller stores `posterUrl = null` and the renderer
 *   falls back to the native `<video>` first-frame behaviour. Failure here
 *   must NOT block the upload.
 */

import { logInfo, logWarning } from '../observability'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Where to seek before grabbing the frame. iPhone clips often start with a
 *  fraction of a second of dark frames during the AE/AF lock. 0.5 s is past
 *  that window for most material; if the clip is shorter we clamp to the
 *  midpoint instead. */
const POSTER_SEEK_SECONDS = 0.5

/** JPEG quality — slightly above the standard pipeline quality because the
 *  poster is the only static representation customers see when the codec
 *  fails, so artefacts here are very visible. */
const POSTER_JPEG_QUALITY = 0.9

/** Max long-edge for the poster. Keeping it close to the upload-pipeline
 *  ceiling (2560) lets the poster double as a high-DPR preview without
 *  bloating bandwidth — most posters land at 200–500 KB. */
const POSTER_MAX_DIMENSION = 2560

/** Hard timeout: if the browser cannot reach a usable frame in this long,
 *  give up and let the caller proceed with no poster rather than blocking
 *  the publish flow. */
const POSTER_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

function canExtractInThisEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function awaitEvent(target: EventTarget, event: string, errorEvent = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      target.removeEventListener(event, onOk)
      target.removeEventListener(errorEvent, onErr)
      resolve()
    }
    const onErr = (e: Event) => {
      target.removeEventListener(event, onOk)
      target.removeEventListener(errorEvent, onErr)
      reject(new Error(`${event}_failed: ${(e as ErrorEvent).message ?? 'unknown'}`))
    }
    target.addEventListener(event, onOk, { once: true })
    target.addEventListener(errorEvent, onErr, { once: true })
  })
}

function computePosterDimensions(
  videoWidth: number,
  videoHeight: number
): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { width: 0, height: 0 }
  }
  const longEdge = Math.max(videoWidth, videoHeight)
  if (longEdge <= POSTER_MAX_DIMENSION) {
    return { width: videoWidth, height: videoHeight }
  }
  const scale = POSTER_MAX_DIMENSION / longEdge
  return {
    width: Math.round(videoWidth * scale),
    height: Math.round(videoHeight * scale),
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extracts a JPEG poster frame from a video file. Total operation: never
 * throws — returns `null` on any failure so the calling upload pipeline
 * can proceed without a poster rather than aborting the publish.
 */
export async function extractVideoPosterFrame(file: File): Promise<File | null> {
  if (!canExtractInThisEnvironment()) {
    return null
  }

  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  // `preload="auto"` is required so the browser actually buffers enough to
  // produce a frame; `metadata` alone is sometimes insufficient on iOS.
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = objectUrl

  try {
    await withTimeout(awaitEvent(video, 'loadeddata'), POSTER_TIMEOUT_MS, 'video_loadeddata')

    const seekTarget = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(POSTER_SEEK_SECONDS, video.duration / 2)
      : POSTER_SEEK_SECONDS

    if (Math.abs(video.currentTime - seekTarget) > 0.01) {
      video.currentTime = seekTarget
      await withTimeout(awaitEvent(video, 'seeked'), POSTER_TIMEOUT_MS, 'video_seek')
    }

    const { width, height } = computePosterDimensions(video.videoWidth, video.videoHeight)
    if (width === 0 || height === 0) {
      logWarning('media.poster_extract_no_dimensions', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      })
      return null
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return null
    }
    ctx.drawImage(video, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', POSTER_JPEG_QUALITY)
    })
    if (!blob || blob.size === 0) {
      return null
    }

    const baseName = (file.name || 'video').replace(/\.[^.]+$/, '')
    const poster = new File([blob], `${baseName}-poster.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })

    logInfo('media.poster_extracted', {
      videoSize: file.size,
      posterSize: poster.size,
      width,
      height,
      seekedTo: video.currentTime,
    })
    return poster
  } catch (err) {
    // HEVC on desktop Chrome, exotic codecs on Android, container without a
    // decodable first frame — all land here. The upload still proceeds
    // without a poster; the renderer falls back to the native first-frame
    // for the platforms that can decode the video themselves.
    logWarning('media.poster_extract_failed', {
      error: err instanceof Error ? err.message : String(err),
      mimeType: file.type,
      size: file.size,
    })
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Extracts both the JPEG poster frame AND probes the video duration in a
 * single `<video>` pass. Used by `VideoComposerSheet` before the send workflow
 * so the pending bubble can show a thumbnail immediately and the workflow can
 * enforce the 60-second limit before inserting the optimistic row.
 *
 * Never throws. If poster extraction fails, `poster` is `null` (upload
 * proceeds without one). If duration cannot be read (live stream, some HLS
 * containers), `durationMs` is `0` — the caller must treat `0` as unknown.
 */
export async function extractVideoPosterAndDuration(
  file: File,
): Promise<{ poster: File | null; durationMs: number; width: number; height: number }> {
  if (!canExtractInThisEnvironment()) {
    return { poster: null, durationMs: 0, width: 0, height: 0 }
  }

  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = objectUrl

  try {
    await withTimeout(awaitEvent(video, 'loadeddata'), POSTER_TIMEOUT_MS, 'video_loadeddata')

    // Capture duration + intrinsic dimensions before seek — both are available
    // after loadeddata. Intrinsic w/h drive the chat bubble aspect ratio so a
    // portrait clip is not cropped to a fixed 16:9.
    const durationMs =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1000)
        : 0
    const intrinsicWidth = video.videoWidth > 0 ? video.videoWidth : 0
    const intrinsicHeight = video.videoHeight > 0 ? video.videoHeight : 0

    const seekTarget =
      durationMs > 0 ? Math.min(POSTER_SEEK_SECONDS, video.duration / 2) : POSTER_SEEK_SECONDS

    if (Math.abs(video.currentTime - seekTarget) > 0.01) {
      video.currentTime = seekTarget
      await withTimeout(awaitEvent(video, 'seeked'), POSTER_TIMEOUT_MS, 'video_seek')
    }

    const { width, height } = computePosterDimensions(video.videoWidth, video.videoHeight)
    if (width === 0 || height === 0) {
      return { poster: null, durationMs, width: intrinsicWidth, height: intrinsicHeight }
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return { poster: null, durationMs, width: intrinsicWidth, height: intrinsicHeight }
    ctx.drawImage(video, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', POSTER_JPEG_QUALITY)
    })
    if (!blob || blob.size === 0) {
      return { poster: null, durationMs, width: intrinsicWidth, height: intrinsicHeight }
    }

    const baseName = (file.name || 'video').replace(/\.[^.]+$/, '')
    const poster = new File([blob], `${baseName}-poster.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
    return { poster, durationMs, width: intrinsicWidth, height: intrinsicHeight }
  } catch (err) {
    logWarning('media.poster_and_duration_extract_failed', {
      error: err instanceof Error ? err.message : String(err),
      mimeType: file.type,
    })
    return { poster: null, durationMs: 0, width: 0, height: 0 }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
