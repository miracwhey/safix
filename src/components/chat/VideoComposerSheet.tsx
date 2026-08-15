/**
 * Block D Slice 4 — Video-Composer action sheet.
 *
 * Two paths:
 *   • "Aufnehmen"       → <input capture="camcorder"> opens native camera recorder
 *   • "Aus Galerie"     → <input accept="video/*"> opens media library
 *
 * After the user picks/records a file:
 *   1. Show loading indicator while probing duration + extracting poster
 *   2. Call onVideoReady({ blob, mimeType, fileExtension, durationMs, posterFile })
 *
 * Validation that is USER-FACING (size, duration) happens here so the sheet
 * can show a clear error before closing. Hard invariant validation runs
 * again inside sendVideoMessageWorkflow.
 *
 * Camera permission handling (native only):
 *   If `navigator.mediaDevices.getUserMedia` is denied before the input fires,
 *   the browser shows its own permission dialog — no extra handling needed for
 *   web. On iOS the system-level dialog appears; no JS API for this path.
 */

import { useCallback, useRef, useState } from 'react'
import { extractVideoPosterAndDuration } from '../../lib/media/videoPoster'
import Spinner from '../system/Spinner'

const VIDEO_MAX_SIZE_BYTES = 100 * 1024 * 1024
const VIDEO_MAX_DURATION_MS = 60_000

export interface VideoReadyPayload {
  blob: Blob
  mimeType: string
  fileExtension: string
  durationMs: number
  width: number
  height: number
  posterFile: File | null
}

type Props = {
  onVideoReady: (payload: VideoReadyPayload) => void
  onClose: () => void
}

export function VideoComposerSheet({ onVideoReady, onClose }: Props) {
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const processFile = useCallback(
    async (file: File) => {
      setProcessing(true)
      setError(null)
      try {
        if (file.size === 0) {
          setError('Datei ist leer — bitte ein anderes Video wählen.')
          return
        }
        if (file.size > VIDEO_MAX_SIZE_BYTES) {
          setError(
            `Video zu groß (max. 100 MB). Dieses Video hat ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
          )
          return
        }

        // Reject genuinely unsupported containers (mkv/avi/mpeg/wmv/ogg …) with
        // a clear message instead of letting Storage 400 silently. MP4-family
        // containers are normalised to a bucket-allowed, playable type.
        const normalizedMime = normalizeSupportedVideoMime(file.type)
        if (!normalizedMime) {
          setError('Dieses Videoformat wird nicht unterstützt. Bitte sende ein MP4-, MOV- oder WebM-Video.')
          return
        }

        const { poster, durationMs, width, height } = await extractVideoPosterAndDuration(file)

        // Enforce the 60s limit only when the duration is actually known. If the
        // probe could not read it (durationMs <= 0) we do NOT block a legit
        // clip — the 100 MB size cap is the real bound.
        if (durationMs > 0 && durationMs > VIDEO_MAX_DURATION_MS) {
          setError(
            `Video zu lang (max. 60 Sekunden). Dieses Video ist ${Math.round(durationMs / 1000)} Sekunden.`,
          )
          return
        }

        const ext = deriveVideoExtension(normalizedMime, file.name)

        onVideoReady({
          blob: file,
          mimeType: normalizedMime,
          fileExtension: ext,
          durationMs,
          width,
          height,
          posterFile: poster,
        })
        onClose()
      } catch {
        setError('Video konnte nicht verarbeitet werden. Bitte erneut versuchen.')
      } finally {
        setProcessing(false)
      }
    },
    [onVideoReady, onClose],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''
      void processFile(file)
    },
    [processFile],
  )

  return (
    <>
      {/* Hidden file inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="video/*"
        capture="environment"
        className="hidden"
        onChange={handleInputChange}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleInputChange}
      />

      {/* Backdrop — z-50 so it dims OVER the BottomNav (z-40), not under it. */}
      <div
        className="fixed inset-0 z-50 bg-black/40"
        onClick={onClose}
        aria-hidden
      />

      {/* Sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-[480px] overflow-hidden rounded-t-2xl bg-white">
          {processing ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-8">
              <Spinner size="md" tone="brand" />
              <p className="text-[14px] text-slate-500">Video wird vorbereitet…</p>
            </div>
          ) : (
            <>
              <div className="px-4 pb-3 pt-4">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
                <p className="text-center text-[13px] font-semibold text-slate-700">Video senden</p>
              </div>

              {error ? (
                <div className="mx-4 mb-3 rounded-xl bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700 ring-1 ring-rose-200">
                  {error}
                </div>
              ) : null}

              <button
                type="button"
                className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition active:bg-slate-50"
                onClick={() => { setError(null); cameraInputRef.current?.click() }}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                  <CameraIcon />
                </span>
                <span>
                  <span className="block text-[15px] font-medium text-slate-900">Aufnehmen</span>
                  <span className="block text-[12px] text-slate-400">Kamera öffnen · max. 60 Sek.</span>
                </span>
              </button>

              <div className="mx-4 h-px bg-slate-100" />

              <button
                type="button"
                className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition active:bg-slate-50"
                onClick={() => { setError(null); galleryInputRef.current?.click() }}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                  <GalleryIcon />
                </span>
                <span>
                  <span className="block text-[15px] font-medium text-slate-900">Aus Galerie wählen</span>
                  <span className="block text-[12px] text-slate-400">MP4, MOV · max. 100 MB</span>
                </span>
              </button>

              <button
                type="button"
                className="w-full py-4 text-center text-[15px] font-medium text-slate-400 transition active:text-slate-600"
                onClick={onClose}
              >
                Abbrechen
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Normalises a picked video's mime to a bucket-allowed, playable container, or
 * returns null when the container is genuinely unsupported (different codec/
 * container that the bucket rejects and the player can't decode) so the
 * composer rejects it with a clear message rather than a silent Storage 400.
 * Strips any `;codecs=…` parameter so the stored content-type matches the
 * bucket allowlist (which lists bare containers).
 */
function normalizeSupportedVideoMime(rawType: string): string | null {
  const essence = (rawType || '').split(';')[0].trim().toLowerCase()
  // MP4-family / ISO-BMFF — playable; normalise to a bucket-allowed type.
  if (
    essence === 'video/mp4' ||
    essence === 'video/x-m4v' ||
    essence === 'video/3gpp' ||
    essence === 'video/3gpp2' ||
    essence === '' // some Android pickers report no type for a recorded clip
  ) {
    return 'video/mp4'
  }
  if (essence === 'video/quicktime' || essence === 'video/hevc') return 'video/quicktime'
  if (essence === 'video/webm') return 'video/webm'
  // mkv / avi / mpeg / ogg / wmv … — different container, not bucket-allowed.
  return null
}

function deriveVideoExtension(mime: string, filename: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-m4v': 'm4v',
    'video/hevc': 'mov',
  }
  if (map[mime]) return map[mime]
  const ext = filename.split('.').pop()
  return ext && /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : 'mp4'
}

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M2 6.5A1.5 1.5 0 0 1 3.5 5h1.086a1 1 0 0 0 .707-.293l.914-.914A1 1 0 0 1 6.914 3.5h6.172a1 1 0 0 1 .707.293l.914.914A1 1 0 0 0 15.414 5H16.5A1.5 1.5 0 0 1 18 6.5v9A1.5 1.5 0 0 1 16.5 17h-13A1.5 1.5 0 0 1 2 15.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="11" r="2.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function GalleryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="2" width="16" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 13l4-4 3 3 3-3.5 6 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="6.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
