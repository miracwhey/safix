/**
 * Block D Slice 1 Phase 1b — Chat Attachment Uploader.
 *
 * Reuses media/preUploadPipeline (HEIC→JPEG, EXIF strip, magic-byte sniff)
 * and media/videoPoster (poster-frame for videos) and writes to chat-*
 * storage buckets.
 *
 * Path-Schema (pending/composer-send): `{provider}/{thread}/pending/{clientMessageId}.{ext}`
 * — deterministic per clientMessageId so a retry upserts onto the SAME object
 * (no blob leak, stable echo-match) instead of scattering random-UUID orphans.
 * Segment 2 MUST stay the threadId — the storage RLS per-path-prefix policies
 * key on it (participant-of-thread). The legacy edit path keeps a messageId
 * segment (`{provider}/{thread}/{message}/…`) because the message row exists.
 *
 * Every upload (voice / photo / document / video / poster) goes through ONE
 * XHR path (`uploadBlobViaXhr`): it enforces `xhr.timeout = chatUploadTimeoutMs`
 * (size-scaled), a 30s stall watchdog (no progress event ⇒ abort ⇒ transient),
 * an external AbortSignal (from `uploadWithRetry`), and optional progress — the
 * storage-js client had none of these, so a hung 5G/WKWebView socket pinned the
 * pending bubble forever.
 *
 * RLS (Storage): per-bucket Per-Path-Prefix-RLS — caller must be a participant
 * of the target thread and (for chat-customer) cannot be a worker.
 *
 * **Atomicity contract (P0-3 fix)**:
 * `uploadChatAttachmentBlob` only uploads to storage and returns metadata;
 * the chat_messages-row + chat_attachments-rows are written in a single
 * transaction by `rpc_send_chat_message_with_attachments`. If the RPC fails,
 * `cleanupOrphanAttachmentBlobs` removes the orphan storage objects.
 *
 * The legacy `uploadChatAttachment` (single-call upload + DB insert) is
 * retained for chat-message-edit attachments where the message already exists
 * and atomicity isn't needed; the new composer-send path goes through
 * `uploadChatAttachmentBlob` + `rpc_send_chat_message_with_attachments`.
 */

import { supabase } from '../../supabase'
import { logError, logInfo, logWarning } from '../../observability'
import { runPreUploadPipeline } from '../../media/preUploadPipeline'
import { extractVideoPosterFrame } from '../../media/videoPoster'
import { ChatStorageUploadError } from '../errors'
import type { ChatAssetType, ChatAttachment, ChatStorageBucket, ChatChannelType } from '../types'

export interface ChatAttachmentUploadInput {
  threadId: string
  channelType: ChatChannelType
  providerId: string | null
  messageId: string
  file: File
}

export interface ChatAttachmentUploadResult {
  attachment: ChatAttachment
}

/** Storage-only upload result — no DB row written. Use with the atomic RPC. */
export interface ChatAttachmentBlob {
  assetType: ChatAssetType
  mimeType: string
  sizeBytes: number
  storageBucket: ChatStorageBucket
  storagePath: string
  width: number | null
  height: number | null
  durationMs: number | null
  posterStoragePath: string | null
}

/** Per-upload transport controls threaded from `uploadWithRetry`. */
export interface ChatUploadControls {
  /** Fresh per-attempt signal — aborts a hung socket deterministically. */
  signal?: AbortSignal
  /** Optional progress (0–100) for a pending-bubble progress ring. */
  onProgress?: (pct: number) => void
}

export interface ChatAttachmentBlobInput extends ChatUploadControls {
  threadId: string
  channelType: ChatChannelType
  providerId: string | null
  /** Drives the deterministic storage path so retries upsert, not leak. */
  clientMessageId: string
  file: File
}

const VIDEO_MIME_PREFIX = 'video/'
const IMAGE_MIME_PREFIX = 'image/'
const AUDIO_MIME_PREFIX = 'audio/'

/**
 * No-progress stall watchdog: if no upload-progress event fires within this
 * window the socket is considered dead and the attempt is aborted (⇒ transient).
 */
export const CHAT_UPLOAD_STALL_TIMEOUT_MS = 30_000

/**
 * Per-attempt wall-clock budget, size-scaled: a floor of 60s plus ~1s per
 * 32 KiB, clamped to 480s. A hung socket can never keep the bubble pending
 * beyond this — the XHR aborts and the retry layer classifies it transient.
 */
export function chatUploadTimeoutMs(sizeBytes: number): number {
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0
  const scaled = 60_000 + Math.round((size / 32_768) * 1_000)
  return Math.min(480_000, Math.max(60_000, scaled))
}

export function bucketForChannel(channelType: ChatChannelType): ChatStorageBucket {
  if (channelType === 'customer') return 'chat-customer'
  if (channelType === 'dispute') return 'chat-dispute'
  return 'chat-internal'
}

export function assetTypeForMime(mime: string): ChatAssetType {
  if (mime.startsWith(IMAGE_MIME_PREFIX)) return 'image'
  if (mime.startsWith(VIDEO_MIME_PREFIX)) return 'video'
  if (mime.startsWith(AUDIO_MIME_PREFIX)) return 'voice'
  return 'document'
}

/** Best-effort HTTP status from a Supabase Storage error / XHR error. */
function storageUploadStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.status === 'number') return o.status
    if (typeof o.statusCode === 'number') return o.statusCode
    if (typeof o.statusCode === 'string') {
      const n = Number(o.statusCode)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/**
 * Throw a {@link ChatStorageUploadError} that preserves the storage status +
 * raw reason. `userMessage` is what surfaces to the UI; the raw reason is kept
 * for diagnostics (and was already logged by the caller) so an allowlist /
 * size regression stays visible instead of collapsing into a generic string.
 */
function throwStorageUploadError(userMessage: string, storageErr: unknown): never {
  throw new ChatStorageUploadError(userMessage, {
    status: storageUploadStatus(storageErr),
    storageReason: storageErr instanceof Error ? storageErr.message : String(storageErr),
  })
}

/**
 * Single XHR upload path for every chat blob. Enforces:
 *   - `xhr.timeout` (size-scaled) — a hung socket aborts instead of hanging.
 *   - 30s stall watchdog — re-armed on each progress event; no progress within
 *     the window ⇒ abort (the socket is dead but the timeout hasn't hit yet).
 *   - external AbortSignal — the per-attempt signal from `uploadWithRetry`.
 *   - `x-upsert: true` — a retry overwrites the deterministic path, no leak.
 *
 * Non-2xx rejects with a status-carrying Error (so `throwStorageUploadError`
 * maps a 400/413/415 to a non-retryable ChatStorageUploadError). Abort / stall /
 * timeout reject WITHOUT a status ⇒ null ⇒ the retry layer treats them transient.
 *
 * Uses the Supabase Storage REST API directly:
 *   POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}
 */
async function uploadBlobViaXhr(
  bucket: string,
  path: string,
  blob: Blob,
  contentType: string,
  controls: ChatUploadControls = {},
): Promise<void> {
  const storageBaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token ?? anonKey

  const url = `${storageBaseUrl}/storage/v1/object/${bucket}/${path}`
  const { signal, onProgress } = controls

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Upload abgebrochen'))
      return
    }

    const xhr = new XMLHttpRequest()
    let settled = false
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const armStall = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        // No progress within the window — abort. `settled` guards against the
        // subsequent 'abort' event so the stall reason (transient) wins.
        try { xhr.abort() } catch { /* ignore */ }
        finish(() => reject(new Error('Upload gestoppt (keine Fortschritte)')))
      }, CHAT_UPLOAD_STALL_TIMEOUT_MS)
    }
    function onAbort() {
      try { xhr.abort() } catch { /* ignore */ }
      finish(() => reject(new Error('Upload abgebrochen')))
    }
    if (signal) signal.addEventListener('abort', onAbort)

    xhr.upload.addEventListener('progress', (e) => {
      armStall()
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.addEventListener('load', () => {
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
        } else {
          reject(Object.assign(new Error(`Upload fehlgeschlagen (${xhr.status})`), { status: xhr.status }))
        }
      })
    })
    // Network error carries status 0 — transient (status-0 is NOT a 4xx).
    xhr.addEventListener('error', () =>
      finish(() => reject(Object.assign(new Error('Upload Netzwerkfehler'), { status: 0 }))))
    xhr.addEventListener('abort', () => finish(() => reject(new Error('Upload abgebrochen'))))
    // xhr.timeout fired — no status ⇒ transient, the retry layer replays it.
    xhr.addEventListener('timeout', () => finish(() => reject(new Error('Upload-Zeitüberschreitung'))))

    xhr.open('POST', url)
    xhr.timeout = chatUploadTimeoutMs(blob.size)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', anonKey)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.setRequestHeader('x-upsert', 'true')
    armStall()
    xhr.send(blob)
  })
}

/**
 * Reads the intrinsic pixel dimensions of an image File so the chat bubble can
 * render it at its true aspect ratio (portrait phone photos were being cropped
 * to a fixed 4:3 because width/height were never captured). Browser-only;
 * returns null in Node/test environments or on any decode failure.
 */
async function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file)
      const dims = { width: bmp.width, height: bmp.height }
      bmp.close?.()
      if (dims.width > 0 && dims.height > 0) return dims
    } catch {
      // fall through to the <img> path
    }
  }
  if (
    typeof document !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const url = URL.createObjectURL(file)
    try {
      const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
        img.onerror = () => resolve(null)
        img.src = url
      })
      if (dims && dims.width > 0 && dims.height > 0) return dims
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  return null
}

function sanitizePathSegment(input: string): string {
  let s: string
  try {
    s = decodeURIComponent(input)
  } catch {
    s = input
  }
  s = s
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  if (s.length === 0) s = '_'
  return s
}

function deriveExtension(mime: string, filename: string | undefined): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'weba',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  }
  if (map[mime]) return map[mime]
  const ext = (filename ?? '').split('.').pop()
  return ext && /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : 'bin'
}

function resolveExtension(mime: string, filename: string | undefined, hint: string | undefined): string {
  if (hint && /^[a-zA-Z0-9]{1,8}$/.test(hint)) return hint.toLowerCase()
  return deriveExtension(mime, filename)
}

function buildStoragePath(input: {
  providerId: string | null
  threadId: string
  messageId: string
  mime: string
  filename: string | undefined
}): string {
  const provider = sanitizePathSegment(input.providerId ?? 'no-provider')
  const thread = sanitizePathSegment(input.threadId)
  const message = sanitizePathSegment(input.messageId)
  const ext = deriveExtension(input.mime, input.filename)
  const base = crypto.randomUUID()
  return `${provider}/${thread}/${message}/${base}.${ext}`
}

/**
 * Deterministic storage-only path used before the message row exists:
 * `{provider}/{thread}/pending/{clientMessageId}.{ext}`. Stable per
 * clientMessageId ⇒ a retry (`x-upsert: true`) overwrites the same object
 * instead of leaking a fresh random-UUID orphan, and the echo-match keys on it.
 * Segment 2 stays the threadId (storage RLS per-path-prefix policies key on it).
 */
function buildPendingStoragePath(input: {
  providerId: string | null
  threadId: string
  clientMessageId: string
  mime: string
  filename: string | undefined
  fileExtension?: string
}): string {
  const provider = sanitizePathSegment(input.providerId ?? 'no-provider')
  const thread = sanitizePathSegment(input.threadId)
  const cmid = sanitizePathSegment(input.clientMessageId)
  const ext = resolveExtension(input.mime, input.filename, input.fileExtension)
  return `${provider}/${thread}/pending/${cmid}.${ext}`
}

/**
 * Storage-only attachment upload. Returns metadata for use with
 * `rpc_send_chat_message_with_attachments`. NO chat_attachments row is
 * inserted — the RPC will do that atomically with chat_messages.
 *
 * On failure, throws {@link ChatStorageUploadError}. Caller is responsible for
 * not committing the RPC if upload fails (which is already the natural flow
 * because the RPC input includes the storage_path the upload returned).
 */
export async function uploadChatAttachmentBlob(
  input: ChatAttachmentBlobInput,
): Promise<ChatAttachmentBlob> {
  const pipeline = await runPreUploadPipeline(input.file)
  if (!pipeline.ok) {
    throw new Error(pipeline.reason)
  }
  const file = pipeline.file
  const bucket: ChatStorageBucket = bucketForChannel(input.channelType)
  const assetType = assetTypeForMime(file.type)
  const path = buildPendingStoragePath({
    providerId: input.providerId,
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    mime: file.type,
    filename: file.name,
  })

  logInfo('chat.attachment.blob_upload_started', {
    threadId: input.threadId,
    bucket,
    assetType,
    sizeBytes: file.size,
    mime: file.type,
  })

  try {
    await uploadBlobViaXhr(bucket, path, file, file.type, {
      signal: input.signal,
      onProgress: input.onProgress,
    })
  } catch (storageErr) {
    logError('chat.attachment.blob_storage_upload_failed', storageErr, {
      threadId: input.threadId,
      bucket,
      path,
    })
    throwStorageUploadError('Datei konnte nicht hochgeladen werden. Bitte erneut versuchen.', storageErr)
  }

  let posterStoragePath: string | null = null
  const durationMs: number | null = null
  if (assetType === 'video') {
    posterStoragePath = await uploadPosterBestEffort(bucket, path, () => extractVideoPosterFrame(file), input.signal)
  }

  const dimensions = assetType === 'image' ? await readImageDimensions(file) : null

  return {
    assetType,
    mimeType: file.type,
    sizeBytes: file.size,
    storageBucket: bucket,
    storagePath: path,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    durationMs,
    posterStoragePath,
  }
}

export interface VoiceNoteBlobInput extends ChatUploadControls {
  threadId: string
  channelType: ChatChannelType
  providerId: string | null
  /** Drives the deterministic storage path so retries upsert, not leak. */
  clientMessageId: string
  blob: Blob
  /** Authoritative duration reported by the native recorder plugin. */
  durationMs: number
  /** Mime type reported by the plugin (audio/aac, audio/mp4, audio/webm). */
  mimeType: string
  /** Hint for the storage path extension, e.g. "m4a", "aac", "webm". */
  fileExtension?: string
}

/**
 * Storage-only voice-note upload — bypasses runPreUploadPipeline because the
 * blob originates from our own native recorder plugin (trusted source, no
 * HEIC/EXIF concerns). Mirrors {@link uploadChatAttachmentBlob} but accepts
 * a Blob + authoritative duration instead of a File pulled from a picker.
 */
export async function uploadVoiceNoteBlob(
  input: VoiceNoteBlobInput,
): Promise<ChatAttachmentBlob> {
  const bucket: ChatStorageBucket = bucketForChannel(input.channelType)
  // Web MediaRecorder reports e.g. `audio/webm;codecs=opus`; the bucket allowlist
  // lists BARE containers (audio/webm), so upload the mime essence to avoid a
  // parameter-match 400 — and store the essence so playback infers it cleanly.
  const contentType = input.mimeType.split(';')[0].trim()
  const path = buildPendingStoragePath({
    providerId: input.providerId,
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    mime: contentType,
    filename: undefined,
    fileExtension: input.fileExtension,
  })

  logInfo('chat.voice.blob_upload_started', {
    threadId: input.threadId,
    bucket,
    sizeBytes: input.blob.size,
    mime: contentType,
    durationMs: input.durationMs,
  })

  try {
    await uploadBlobViaXhr(bucket, path, input.blob, contentType, {
      signal: input.signal,
      onProgress: input.onProgress,
    })
  } catch (storageErr) {
    logError('chat.voice.blob_storage_upload_failed', storageErr, {
      threadId: input.threadId,
      bucket,
      path,
    })
    throwStorageUploadError('Sprachnachricht konnte nicht hochgeladen werden. Bitte erneut versuchen.', storageErr)
  }

  return {
    assetType: 'voice',
    mimeType: contentType,
    sizeBytes: input.blob.size,
    storageBucket: bucket,
    storagePath: path,
    width: null,
    height: null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    posterStoragePath: null,
  }
}

export interface VideoAttachmentBlobInput extends ChatUploadControls {
  threadId: string
  channelType: ChatChannelType
  providerId: string | null
  /** Drives the deterministic storage path so retries upsert, not leak. */
  clientMessageId: string
  /** Original video blob (MP4 / MOV / HEVC). */
  blob: Blob
  mimeType: string
  fileExtension: string
  /** Authoritative duration in ms — from probe before the workflow. */
  durationMs: number
  /** Intrinsic video dimensions from the probe — drives the bubble aspect ratio. */
  width?: number | null
  height?: number | null
  /**
   * Pre-extracted poster JPEG — produced by `extractVideoPosterAndDuration`
   * in the composer before the workflow runs. If null, best-effort extraction
   * from the blob is attempted here; if that also fails, upload proceeds
   * without a poster (non-blocking).
   */
  preExtractedPosterFile?: File | null
}

/**
 * Video-specific storage upload. Accepts a pre-extracted poster and duration
 * to avoid double-extraction (VideoComposerSheet already did it for the
 * pending-bubble preview). Routes through the shared XHR path so large files
 * get progress, timeout, stall-detection and abort like every other upload.
 */
export async function uploadVideoAttachmentBlob(
  input: VideoAttachmentBlobInput,
): Promise<ChatAttachmentBlob> {
  const bucket: ChatStorageBucket = bucketForChannel(input.channelType)
  const path = buildPendingStoragePath({
    providerId: input.providerId,
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    mime: input.mimeType,
    filename: undefined,
    fileExtension: input.fileExtension,
  })
  const ext = resolveExtension(input.mimeType, undefined, input.fileExtension)

  logInfo('chat.video.blob_upload_started', {
    threadId: input.threadId,
    bucket,
    sizeBytes: input.blob.size,
    mime: input.mimeType,
    durationMs: input.durationMs,
    hasPreExtractedPoster: !!input.preExtractedPosterFile,
  })

  try {
    await uploadBlobViaXhr(bucket, path, input.blob, input.mimeType, {
      signal: input.signal,
      onProgress: input.onProgress,
    })
  } catch (err) {
    logError('chat.video.blob_storage_upload_failed', err, {
      threadId: input.threadId,
      bucket,
      path,
    })
    throwStorageUploadError('Video konnte nicht hochgeladen werden. Bitte erneut versuchen.', err)
  }

  // Poster: use pre-extracted file if available; fall back to best-effort extraction.
  const posterStoragePath = await uploadPosterBestEffort(
    bucket,
    path,
    async () => {
      if (input.preExtractedPosterFile) return input.preExtractedPosterFile
      try {
        const file = new File([input.blob], `video.${ext}`, { type: input.mimeType })
        return await extractVideoPosterFrame(file)
      } catch {
        return null
      }
    },
    input.signal,
  )

  return {
    assetType: 'video',
    mimeType: input.mimeType,
    sizeBytes: input.blob.size,
    storageBucket: bucket,
    storagePath: path,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    posterStoragePath,
  }
}

/**
 * Uploads a poster JPEG to `{path}.poster.jpg` (deterministic, upsert-safe).
 * Best-effort: any failure logs a warning and returns null (poster is a
 * non-blocking enhancement — the main asset already uploaded).
 */
async function uploadPosterBestEffort(
  bucket: string,
  basePath: string,
  produce: () => Promise<File | null>,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  let posterFile: File | null
  try {
    posterFile = await produce()
  } catch {
    posterFile = null
  }
  if (!posterFile) return null
  const posterStoragePath = `${basePath}.poster.jpg`
  try {
    await uploadBlobViaXhr(bucket, posterStoragePath, posterFile, 'image/jpeg', { signal })
    return posterStoragePath
  } catch {
    logWarning('chat.attachment.poster_upload_failed', { path: posterStoragePath })
    return null
  }
}

/**
 * Best-effort cleanup of orphan storage blobs after a failed RPC commit.
 * Per CLAUDE.md "no silent fallbacks": on cleanup-failure, we log to Sentry
 * but never throw — the original send-error has already surfaced to UI.
 */
export async function cleanupOrphanAttachmentBlobs(blobs: ChatAttachmentBlob[]): Promise<void> {
  for (const b of blobs) {
    try {
      await supabase.storage.from(b.storageBucket).remove([b.storagePath])
      if (b.posterStoragePath) {
        await supabase.storage.from(b.storageBucket).remove([b.posterStoragePath])
      }
    } catch (err) {
      logWarning('chat.attachment.cleanup_failed', {
        bucket: b.storageBucket,
        path: b.storagePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Uploads a chat attachment file to storage + persists a `chat_attachments` row.
 * Legacy edit-attachment path (message row already exists). Throws on failure —
 * caller surfaces to UI.
 */
export async function uploadChatAttachment(
  input: ChatAttachmentUploadInput,
): Promise<ChatAttachmentUploadResult> {
  const pipeline = await runPreUploadPipeline(input.file)
  if (!pipeline.ok) {
    throw new Error(pipeline.reason)
  }
  const file = pipeline.file
  const bucket: ChatStorageBucket = bucketForChannel(input.channelType)
  const assetType = assetTypeForMime(file.type)
  const path = buildStoragePath({
    providerId: input.providerId,
    threadId: input.threadId,
    messageId: input.messageId,
    mime: file.type,
    filename: file.name,
  })

  logInfo('chat.attachment.upload_started', {
    threadId: input.threadId,
    bucket,
    assetType,
    sizeBytes: file.size,
    mime: file.type,
  })

  try {
    await uploadBlobViaXhr(bucket, path, file, file.type, {})
  } catch (storageErr) {
    logError('chat.attachment.storage_upload_failed', storageErr, {
      threadId: input.threadId,
      bucket,
      path,
    })
    throwStorageUploadError('Datei konnte nicht hochgeladen werden. Bitte erneut versuchen.', storageErr)
  }

  // Video poster (best-effort)
  let posterStoragePath: string | null = null
  const durationMs: number | null = null
  if (assetType === 'video') {
    posterStoragePath = await uploadPosterBestEffort(bucket, path, () => extractVideoPosterFrame(file), undefined)
  }

  const attachmentRow = {
    message_id: input.messageId,
    asset_type: assetType,
    mime_type: file.type,
    size_bytes: file.size,
    storage_bucket: bucket,
    storage_path: path,
    width: null as number | null,
    height: null as number | null,
    duration_ms: durationMs,
    poster_storage_path: posterStoragePath,
    transcript: null as string | null,
    transcript_language: null as string | null,
  }

  const { data: inserted, error: dbErr } = await supabase
    .from('chat_attachments')
    .insert(attachmentRow)
    .select('*')
    .single()

  if (dbErr) {
    // Cleanup orphan storage object
    void supabase.storage.from(bucket).remove([path]).catch(() => undefined)
    if (posterStoragePath) {
      void supabase.storage.from(bucket).remove([posterStoragePath]).catch(() => undefined)
    }
    logError('chat.attachment.db_insert_failed', dbErr, {
      threadId: input.threadId,
      bucket,
      path,
    })
    throw new Error(`Anhang konnte nicht gespeichert werden: ${dbErr.message}`)
  }

  logInfo('chat.attachment.upload_succeeded', {
    threadId: input.threadId,
    bucket,
    attachmentId: (inserted as { id: string } | null)?.id ?? null,
  })

  const view: ChatAttachment = {
    id: (inserted as { id: string }).id,
    messageId: input.messageId,
    assetType,
    mimeType: file.type,
    sizeBytes: file.size,
    storageBucket: bucket,
    storagePath: path,
    width: null,
    height: null,
    durationMs,
    posterStoragePath,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: Date.now(),
    deletedAt: null,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
  }
  return { attachment: view }
}
