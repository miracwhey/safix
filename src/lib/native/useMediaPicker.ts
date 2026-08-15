/**
 * useMediaPicker — unified media-picker hook.
 *
 * Bridges the native Capacitor Camera plugin (iOS/Android) and the web
 * `<input type="file">` fallback behind one API. Components do not branch
 * on platform — they call `pickMedia({ kind })` and render `<input {...inputProps} />`
 * once. The hook decides the source.
 *
 * Native path (image-only):
 *   Uses @capacitor/camera with `Source.Prompt` so the user picks Camera vs.
 *   Library, returns at quality 85, with `correctOrientation` so EXIF rotation
 *   does not show up sideways. The Camera plugin does not support video, so
 *   `kind: 'video'` and `kind: 'image-or-video'` fall back to the hidden file
 *   input even on native — that path uses the iOS native picker through the
 *   WebView and lets HEIC auto-convert via the `image/*` wildcard accept.
 *
 * Web path:
 *   Triggers the hidden `<input>` programmatically, awaits the change event,
 *   resolves with the chosen File or null on cancel/no-file.
 *
 * The hook is owner-agnostic — it produces a `File`. Compression, validation,
 * EXIF stripping, and persistence are downstream concerns handled by
 * mediaUploadService and (block M1+M3) the pre-upload pipeline.
 */

import { useCallback, useRef, useState, type ChangeEvent } from 'react'
import { Capacitor } from '@capacitor/core'
import { IMAGE_ACCEPT, IMAGE_VIDEO_ACCEPT } from '../media/mediaUploadService'
import { logWarning } from '../observability'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaPickKind = 'image' | 'video' | 'image-or-video'

/**
 * Source for the native picker. On web this is ignored — the file input
 * always shows the system picker which already exposes camera + library.
 */
export type MediaPickSource = 'camera' | 'photos' | 'prompt'

export type MediaPickOptions = {
  kind?: MediaPickKind
  source?: MediaPickSource
}

export type MediaPickerInputProps = {
  ref: React.RefObject<HTMLInputElement | null>
  type: 'file'
  accept: string
  className: string
  'aria-hidden': boolean
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}

export type MediaPicker = {
  /**
   * Open the picker and resolve with the chosen File. Resolves to `null`
   * when the user cancels, denies permission, or chooses no file. Rejects
   * only on unexpected platform errors so callers can surface them.
   */
  pickMedia: (opts?: MediaPickOptions) => Promise<File | null>
  /**
   * Spread onto a single hidden `<input type="file">` rendered once per hook
   * instance. The hook drives its lifecycle.
   */
  inputProps: MediaPickerInputProps
  /** True when the native Camera plugin is available (iOS/Android shell). */
  isNative: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function acceptFor(kind: MediaPickKind): string {
  switch (kind) {
    case 'image':
      return IMAGE_ACCEPT
    case 'video':
      return 'video/*'
    case 'image-or-video':
      return IMAGE_VIDEO_ACCEPT
  }
}

function looksLikeUserCancel(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const message = ('message' in err ? String((err as { message: unknown }).message) : '').toLowerCase()
  return (
    message.includes('cancel') ||
    message.includes('canceled') ||
    message.includes('cancelled') ||
    message.includes('user denied')
  )
}

async function photoToFile(webPath: string, format: string | undefined): Promise<File | null> {
  const response = await fetch(webPath)
  const blob = await response.blob()
  const normalizedFormat = (format ?? 'jpeg').toLowerCase()
  const ext = normalizedFormat === 'jpeg' ? 'jpg' : normalizedFormat
  const mime = blob.type || `image/${normalizedFormat === 'jpg' ? 'jpeg' : normalizedFormat}`
  if (!blob.size) return null
  return new File([blob], `photo-${Date.now()}.${ext}`, {
    type: mime,
    lastModified: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPicker(): MediaPicker {
  const inputRef = useRef<HTMLInputElement>(null)
  const resolverRef = useRef<((file: File | null) => void) | null>(null)
  const [accept, setAccept] = useState<string>(IMAGE_VIDEO_ACCEPT)
  const isNative = Capacitor.isNativePlatform()

  const pickFromInput = useCallback((kind: MediaPickKind): Promise<File | null> => {
    setAccept(acceptFor(kind))
    return new Promise<File | null>((resolve) => {
      // If a previous pick is still pending (e.g. duplicate clicks), settle it
      // with null so we don't leak a resolver — then take over.
      if (resolverRef.current) {
        resolverRef.current(null)
      }
      resolverRef.current = resolve
      // setState is async; defer the click so the input has the new accept
      // value applied before the picker opens.
      requestAnimationFrame(() => {
        inputRef.current?.click()
      })
    })
  }, [])

  const pickMedia = useCallback(
    async (opts: MediaPickOptions = {}): Promise<File | null> => {
      const kind = opts.kind ?? 'image'

      // Native path is image-only. Video and mixed picks fall back to the
      // file input, which on iOS still routes through the native system
      // picker via the WebView.
      if (isNative && kind === 'image') {
        try {
          const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
          const sourceMap: Record<MediaPickSource, (typeof CameraSource)[keyof typeof CameraSource]> = {
            camera: CameraSource.Camera,
            photos: CameraSource.Photos,
            prompt: CameraSource.Prompt,
          }
          const photo = await Camera.getPhoto({
            quality: 85,
            allowEditing: false,
            resultType: CameraResultType.Uri,
            source: sourceMap[opts.source ?? 'prompt'],
            correctOrientation: true,
            saveToGallery: false,
            // JPEG output — predictable for downstream compression/EXIF strip
            // and avoids the iOS HEIC roundtrip when the user picked from the
            // library on a modern iPhone.
            promptLabelHeader: 'Foto auswählen',
            promptLabelPhoto: 'Aus Mediathek',
            promptLabelPicture: 'Foto aufnehmen',
          })
          if (!photo.webPath) return null
          return await photoToFile(photo.webPath, photo.format)
        } catch (err) {
          if (looksLikeUserCancel(err)) return null
          // Fall back to the file input so a misconfigured native plugin
          // does not strand the user. Surface the warning so it shows up in
          // logs without blocking the upload.
          logWarning('media.native_picker_fallback', {
            error: err instanceof Error ? err.message : String(err),
          })
          return pickFromInput(kind)
        }
      }

      return pickFromInput(kind)
    },
    [isNative, pickFromInput]
  )

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    const resolve = resolverRef.current
    resolverRef.current = null
    // Reset so re-selecting the same file fires another change event.
    if (inputRef.current) inputRef.current.value = ''
    resolve?.(file)
  }, [])

  const inputProps: MediaPickerInputProps = {
    ref: inputRef,
    type: 'file',
    accept,
    className: 'hidden',
    'aria-hidden': true,
    onChange: handleChange,
  }

  return { pickMedia, inputProps, isNative }
}
