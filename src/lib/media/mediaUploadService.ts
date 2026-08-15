/**
 * Media Upload Service — BLOCK 58: Media Upload & Storage Foundation
 *
 * Provides a reusable, validated upload pipeline:
 *   1. Validate file type + size.
 *   2. Upload file to Supabase Storage bucket `media`.
 *   3. Persist a reference row in `media_uploads` DB table.
 *   4. Return the persisted {@link PersistedMediaRecord}.
 *
 * Analytics events emitted:
 *   media.upload_started    – before storage upload begins
 *   media.upload_succeeded  – after both storage upload + DB insert succeed
 *   media.upload_failed     – when any step fails
 *
 * Storage path layout:
 *   {entity_type}/{entity_id}/{uuid}.{ext}
 *   e.g.  profile/user-abc/9f3d1c2e.jpg
 *         dispute/dispute-xyz/evidence-a4b8c.png
 */

import { supabase } from '../supabase'
import { recordAnalyticsEvent } from '../analytics/analyticsService'
import { logInfo, logError, logWarning } from '../observability'
import { runPreUploadPipeline } from './preUploadPipeline'
import { extractVideoPosterFrame } from './videoPoster'
import { MEDIA_PRIVATE_BUCKET } from './resolveMediaUrl'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaEntityType =
  | 'profile'
  | 'project'
  | 'message'
  | 'dispute'
  | 'job'
  | 'showcase'
  | 'portfolio'

export type MediaUploadInput = {
  file: File
  entityType: MediaEntityType
  entityId: string
  ownerUserId: string
  /**
   * Optional role/purpose label stored in the `media_role` column.
   * Examples: 'avatar', 'evidence', 'showcase', 'progress', 'completion', 'project_photo'.
   * Defaults to empty string when not provided.
   */
  mediaRole?: string
  /**
   * Stable idempotency key (a UUID) that survives across retries of the SAME
   * logical upload. When present, the storage object path and the
   * `media_uploads.id` are derived deterministically from it and the DB write
   * upserts on the primary key — so a retry after a post-commit timeout (or an
   * app kill between the storage+DB commit and the outbox cleanup) re-targets
   * the same row/object instead of minting a duplicate. Set by the
   * outbox-aware wrapper; omitted for one-shot direct uploads.
   */
  idempotencyKey?: string
}

export type PersistedMediaRecord = {
  id: string
  ownerUserId: string
  entityType: MediaEntityType
  entityId: string
  filePath: string
  publicUrl: string
  mimeType: string
  mediaType: 'image' | 'video'
  /**
   * Role/purpose within the entity.  See migration 000009 for allowed values.
   * Empty string for records created before the media_role column was added.
   */
  mediaRole: string
  createdAt: number
  /**
   * Sibling poster-frame path inside the same Storage bucket. Set only for
   * `mediaType: 'video'` uploads where {@link extractVideoPosterFrame}
   * succeeded. Omitted/null when the video has no extractable poster
   * (HEVC on a desktop browser, codec error, Node test environment) and
   * for image uploads.
   */
  posterPath?: string | null
  /**
   * Public URL of the poster frame when {@link posterPath} is set;
   * omitted/null otherwise. Renderers should pass this to
   * `<video poster=...>` and gracefully fall back to native first-frame
   * behaviour when not present.
   */
  posterUrl?: string | null
}

export type MediaValidationError = {
  valid: false
  reason: string
}

export type MediaValidationSuccess = {
  valid: true
}

export type MediaValidationResult = MediaValidationSuccess | MediaValidationError

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  // iOS native photo formats. Modern iOS captures HEIC by default. The native
  // file picker only auto-converts HEIC → JPEG when the input's `accept`
  // attribute uses the wildcard `image/*`. With an explicit MIME list, iOS
  // hands back the raw HEIC, which would fail validation. Accepting it here
  // keeps craftsmen on iPhones from being blocked at the picker.
  'image/heic',
  'image/heif',
] as const

const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const

const ALLOWED_MIME_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
]

/**
 * Pre-built `accept` attribute value for `<input type="file">` elements that
 * accept all supported image types.
 *
 * Uses the `image/*` wildcard so iOS WebView lets the system photo picker
 * auto-convert HEIC → JPEG before handing the file back. With an explicit
 * MIME list, iOS skips that conversion.
 */
export const IMAGE_ACCEPT = 'image/*'

/**
 * Pre-built `accept` attribute value for `<input type="file">` elements that
 * accept all supported image AND video types. Uses wildcards for the same
 * iOS auto-conversion reason as IMAGE_ACCEPT.
 */
export const IMAGE_VIDEO_ACCEPT = 'image/*,video/*'

/**
 * Pre-built `accept` attribute value for `<input type="file">` elements that
 * accept videos only.
 *
 * Uses the `video/*` wildcard for the same reason as IMAGE_ACCEPT: the iOS
 * native picker filters its grid by `accept` and an explicit MIME list like
 * `video/mp4,video/quicktime` excludes HEVC-encoded `.mov` clips that
 * iPhones produce by default. The wildcard exposes every video the user has
 * in their library; the magic-byte sniff downstream still rejects anything
 * we cannot store.
 */
export const VIDEO_ACCEPT = 'video/*'

/** Maximum file size for images: 10 MB */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Maximum file size for videos: 200 MB.
 *
 * Real-world iPhone clips at 4K-30 fps run roughly 6–8 MB/s, so a 50 MB cap
 * blocked any clip longer than ~7 seconds — the typical job-progress or
 * showcase video is 15–45 s. 200 MB covers the realistic upper bound while
 * still keeping a hard ceiling. A streaming/chunked pipeline is the proper
 * answer for hours-long material; this limit is the pragmatic interim.
 */
export const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024

/** Supabase Storage bucket name for public discovery content */
export const MEDIA_STORAGE_BUCKET = 'media'

/**
 * Entity types whose uploads must go to the private `media-private` bucket
 * and must be accessed via signed URLs instead of public CDN links.
 *
 * Rationale: project/dispute/job/message media is participant-only content.
 * Profile/showcase/portfolio/builder/reels/catalog media is discovery content
 * that remains in the public `media` bucket.
 */
const PRIVATE_MEDIA_ENTITY_TYPES = new Set<MediaEntityType>([
  'project',
  'dispute',
  'job',
  'message',
])

export function isPrivateMediaEntityType(entityType: MediaEntityType): boolean {
  return PRIVATE_MEDIA_ENTITY_TYPES.has(entityType)
}

// ---------------------------------------------------------------------------
// Path helpers (pure — no side effects, easily testable)
// ---------------------------------------------------------------------------

/**
 * Sanitises a single segment of a storage path so it cannot escape the
 * intended directory.  Removes path separators, traversal sequences,
 * control characters and trims whitespace.  Returns `'_'` for empty or
 * whitespace-only input so callers never produce a blank segment.
 */
export function sanitizePathSegment(segment: string): string {
  // Decode any percent-encoded characters first so that %2e%2e (%2F etc.)
  // are caught by the literal checks below.
  let s: string
  try {
    s = decodeURIComponent(segment)
  } catch {
    // If decoding fails (malformed percent encoding), use the raw input.
    s = segment
  }
  s = s
    .replace(/\.\./g, '')          // remove traversal
    .replace(/[/\\]/g, '')         // remove path separators
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '') // remove control chars
    .trim()
  if (s.length === 0) s = '_'
  return s
}

// ---------------------------------------------------------------------------
// Validation (pure — no side effects, easily testable)
// ---------------------------------------------------------------------------

/**
 * Validates a {@link File} against allowed MIME types and maximum size.
 *
 * Images are limited to {@link MAX_FILE_SIZE_BYTES} (10 MB).
 * Videos are limited to {@link MAX_VIDEO_SIZE_BYTES} (50 MB) to support
 * short showcase/reel clips at the foundation level.
 *
 * This function is intentionally pure so it can be tested without any
 * mocking of external services.
 */
export function validateMediaFile(file: File): MediaValidationResult {
  if (!file.size || file.size === 0) {
    return {
      valid: false,
      reason: 'Die Datei ist leer. Bitte wähle eine gültige Datei aus.',
    }
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return {
      valid: false,
      reason: `Ungültiger Dateityp "${file.type}". Erlaubt: JPEG, PNG, WebP, GIF, MP4, WebM, MOV.`,
    }
  }

  const isVideo = (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(file.type)
  const sizeLimit = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_FILE_SIZE_BYTES

  if (file.size > sizeLimit) {
    const maxMb = sizeLimit / (1024 * 1024)
    return {
      valid: false,
      reason: `Datei zu groß (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum: ${maxMb} MB.`,
    }
  }

  return { valid: true }
}

/**
 * Returns `'image'` or `'video'` for a given MIME type.
 * Defaults to `'image'` for unknown types (should never be reached after
 * validation).
 */
export function resolveMediaType(mimeType: string): 'image' | 'video' {
  if ((ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'video'
  }
  return 'image'
}

/**
 * Derives the file extension from a MIME type.
 * Returns `'bin'` for unknown types.
 */
export function mimeTypeToExtension(mimeType: string): string {
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
  }
  return map[mimeType] ?? 'bin'
}

/**
 * Builds the Supabase Storage object path for a media upload.
 *
 * Pattern: {entity_type}/{entity_id}/{uuid}.{ext}
 *
 * Segments are sanitised via {@link sanitizePathSegment} to prevent path
 * traversal and invalid characters.
 */
export function buildStoragePath(
  entityType: string,
  entityId: string,
  mimeType: string,
  seed?: string
): string {
  const uuid = seed ?? crypto.randomUUID()
  const ext = mimeTypeToExtension(mimeType)
  return `${sanitizePathSegment(entityType)}/${sanitizePathSegment(entityId)}/${uuid}.${ext}`
}

// ---------------------------------------------------------------------------
// Upload pipeline
// ---------------------------------------------------------------------------

/**
 * Uploads a media file to Supabase Storage and persists a reference record
 * in the `media_uploads` DB table.
 *
 * Throws a descriptive {@link Error} on failure so callers can surface the
 * problem to the user.  No silent failures.
 *
 * Analytics events emitted:
 * - `media_upload_started`  before upload begins
 * - `media_upload_succeeded` on full success
 * - `media_upload_failed`    on any failure
 */
export async function uploadMediaFile(
  input: MediaUploadInput
): Promise<PersistedMediaRecord> {
  const { entityType, entityId, ownerUserId } = input

  // 1a. Cheap MIME + size validation. Rejects before reading bytes.
  const validation = validateMediaFile(input.file)
  if (!validation.valid) {
    throw new Error(validation.reason)
  }

  // 1b. Pre-upload pipeline — magic-byte sniff + EXIF-strip + image
  // compression. The pipeline replaces the input file with a re-encoded
  // JPEG when the source is a bitmap image, so all later steps work
  // against the post-pipeline file.
  const pipeline = await runPreUploadPipeline(input.file)
  if (!pipeline.ok) {
    throw new Error(pipeline.reason)
  }
  const file = pipeline.file

  // 1c. Re-validate the post-pipeline file. Compression should always
  // shrink, but a corrupt input could grow past the cap.
  const postValidation = validateMediaFile(file)
  if (!postValidation.valid) {
    throw new Error(postValidation.reason)
  }

  // 1b. Resolve authenticated user for RLS compliance.
  //     The RLS policy on media_uploads requires:
  //       owner_user_id = auth.uid()::text
  //     We must use the actual auth user ID — not whatever the caller passed —
  //     to guarantee the insert satisfies the row-level security check.
  const { data: sessionData } = await supabase.auth.getSession()
  const authUserId = sessionData?.session?.user?.id

  if (!authUserId) {
    throw new Error(
      'Nicht angemeldet — Medien-Upload erfordert eine aktive Sitzung. Bitte melde dich erneut an.'
    )
  }

  // If the caller provided a different ownerUserId, log a warning and use
  // the auth user ID so the RLS check passes.  This prevents silent insert
  // failures when callers accidentally pass a profile/provider/customer ID
  // instead of the Supabase auth user ID.
  const effectiveOwnerUserId = authUserId
  if (ownerUserId && ownerUserId !== authUserId) {
    logWarning('media.owner_id_mismatch', {
      provided: ownerUserId,
      authUserId,
      entityType,
      entityId,
    })
  }

  // Stable across retries when the caller supplied an idempotency key: the
  // storage path and the media_uploads PK are both seeded from it, so a retried
  // upload re-targets the same object/row instead of duplicating.
  const idempotencyKey = input.idempotencyKey
  const mediaType = resolveMediaType(file.type)
  const filePath = buildStoragePath(entityType, entityId, file.type, idempotencyKey)
  const recordId = idempotencyKey ?? crypto.randomUUID()
  const createdAt = Date.now()
  const mediaRole = input.mediaRole ?? ''

  // Route private entity types to the participant-scoped `media-private` bucket.
  // Discovery content (profile, showcase, portfolio, builder, reels) stays in `media`.
  const storageBucket = isPrivateMediaEntityType(entityType)
    ? MEDIA_PRIVATE_BUCKET
    : MEDIA_STORAGE_BUCKET

  // 2. Emit start event
  logInfo('media.upload_started', { entityType, entityId, mimeType: file.type, size: file.size })
  recordAnalyticsEvent({
    eventType: 'media_upload_started',
    entityType: 'media',
    entityId: recordId,
    actorUserId: effectiveOwnerUserId,
    metadata: { entityType, entityId, mimeType: file.type },
  })

  try {
    // 3. Upload to Supabase Storage
    const { error: storageError } = await supabase.storage
      .from(storageBucket)
      .upload(filePath, file, {
        contentType: file.type,
        // Idempotent retries reuse the same deterministic path; allow overwrite
        // so a re-run after a post-commit timeout does not 409 on the object the
        // prior attempt already wrote.
        upsert: Boolean(idempotencyKey),
      })

    if (storageError) {
      throw new Error('Datei konnte nicht hochgeladen werden. Bitte prüfe deine Internetverbindung und versuche es erneut.')
    }

    // 4. Retrieve public URL — only for public-bucket entity types.
    // Private entity types (project/dispute/job/message) do NOT have a public
    // CDN URL. Callers must resolve a signed URL via resolveMediaPrivateUrl /
    // useMediaPrivateUrl. We store '' (the column is NOT NULL DEFAULT '') so
    // the DB constraint is satisfied; file_path is the canonical reference.
    const publicUrl = isPrivateMediaEntityType(entityType)
      ? ''
      : (() => {
          const { data: urlData } = supabase.storage
            .from(storageBucket)
            .getPublicUrl(filePath)
          return urlData.publicUrl
        })()

    // 4b. Video poster — extract a JPEG cover frame and upload it next to
    //     the video so renderers (`<video poster=...>`) can show a static
    //     preview even when the codec (e.g. iPhone HEVC) cannot be decoded
    //     by the customer's browser. Failure here is non-blocking: the
    //     video upload is already committed and we keep posterPath/Url
    //     null on any error.
    //
    //     Private poster frames go to the same private bucket as the video.
    //     Public entity types get a public poster URL; private types keep null.
    let posterPath: string | null = null
    let posterUrl: string | null = null
    if (mediaType === 'video') {
      try {
        const posterFile = await extractVideoPosterFrame(file)
        if (posterFile) {
          posterPath = `${filePath}.poster.jpg`
          const { error: posterUploadErr } = await supabase.storage
            .from(storageBucket)
            .upload(posterPath, posterFile, {
              contentType: 'image/jpeg',
              upsert: Boolean(idempotencyKey),
            })
          if (posterUploadErr) {
            logWarning('media.poster_storage_upload_failed', {
              filePath,
              posterPath,
              error: posterUploadErr.message,
            })
            posterPath = null
          } else if (!isPrivateMediaEntityType(entityType)) {
            const { data: posterUrlData } = supabase.storage
              .from(storageBucket)
              .getPublicUrl(posterPath)
            posterUrl = posterUrlData.publicUrl
          }
          // Private entity types: posterUrl stays null; readers use signed URLs.
        }
      } catch (posterErr) {
        logWarning('media.poster_pipeline_failed', {
          filePath,
          error: posterErr instanceof Error ? posterErr.message : String(posterErr),
        })
        posterPath = null
        posterUrl = null
      }
    }

    // 5. Persist reference row in media_uploads
    const row = {
      id: recordId,
      owner_user_id: effectiveOwnerUserId,
      entity_type: entityType,
      entity_id: entityId,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: file.type,
      media_type: mediaType,
      media_role: mediaRole,
      created_at: createdAt,
    }

    // Insert-if-absent on the primary key when idempotent: a retry that finds
    // the row already committed (post-commit timeout / kill-after-commit) is a
    // no-op (ON CONFLICT DO NOTHING) instead of a 23505 duplicate or a second
    // row — and it needs no UPDATE on an already-correct row. Plain insert
    // otherwise to keep the one-shot path's behavior unchanged.
    const { error: dbError } = idempotencyKey
      ? await supabase.from('media_uploads').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      : await supabase.from('media_uploads').insert(row)

    if (dbError) {
      // Storage upload succeeded but DB insert failed — remove the orphaned
      // storage object so quota is not wasted and the file cannot linger
      // unreferenced.  The cleanup is best-effort: if it also fails we log it
      // but still throw the original DB error to the caller.
      await supabase.storage
        .from(storageBucket)
        .remove([filePath])
        .catch((cleanupErr: unknown) => {
          logError('media.storage_cleanup_failed', cleanupErr, { filePath })
        })

      // Build a diagnostic string from ALL available Supabase error fields
      // so the real cause (RLS violation, missing column, constraint, etc.)
      // is visible in logs AND in the thrown error.
      const dbErrorDetail = [
        dbError.message,
        dbError.details ? `details=${dbError.details}` : '',
        dbError.hint ? `hint=${dbError.hint}` : '',
        dbError.code ? `code=${dbError.code}` : '',
      ]
        .filter(Boolean)
        .join(' | ')

      logError('media.db_insert_failed', dbError, {
        recordId,
        filePath,
        dbErrorDetail,
        ownerUserId: effectiveOwnerUserId,
      })
      throw new Error(
        `Datei wurde hochgeladen, konnte aber nicht gespeichert werden: ${dbErrorDetail}`
      )
    }

    // 6. Emit success
    logInfo('media.upload_succeeded', { recordId, entityType, entityId, publicUrl })
    recordAnalyticsEvent({
      eventType: 'media_upload_succeeded',
      entityType: 'media',
      entityId: recordId,
      actorUserId: effectiveOwnerUserId,
      metadata: { entityType, entityId, filePath, publicUrl },
    })

    return {
      id: recordId,
      ownerUserId: effectiveOwnerUserId,
      entityType,
      entityId,
      filePath,
      publicUrl,
      mimeType: file.type,
      mediaType,
      mediaRole,
      createdAt,
      posterPath,
      posterUrl,
    }
  } catch (err) {
    logError('media.upload_failed', err, { entityType, entityId, mimeType: file.type })
    recordAnalyticsEvent({
      eventType: 'media_upload_failed',
      entityType: 'media',
      entityId: recordId,
      actorUserId: effectiveOwnerUserId,
      metadata: { entityType, entityId, reason: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }
}

/**
 * Network-direct alias of {@link uploadMediaFile}. Used by the upload-outbox
 * runner so a queued retry never re-enters the queue-aware wrapper and
 * forms an infinite loop. Identical contract: throws on failure.
 */
export const uploadMediaFileDirect = uploadMediaFile

/**
 * Fetches persisted media records for a given entity from the `media_uploads`
 * table.  Returns an empty array on error so callers remain stable.
 */
export async function fetchMediaForEntity(
  entityType: MediaEntityType,
  entityId: string,
  options?: { throwOnError?: boolean }
): Promise<PersistedMediaRecord[]> {
  const { data, error } = await supabase
    .from('media_uploads')
    .select('id, owner_user_id, entity_type, entity_id, file_path, public_url, mime_type, media_type, media_role, created_at')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })

  if (error) {
    logError('media.fetch_failed', error, { entityType, entityId })
    if (options?.throwOnError) throw new Error('Beweismittel konnten nicht geladen werden.')
    return []
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    entityType: row.entity_type as MediaEntityType,
    entityId: row.entity_id as string,
    filePath: row.file_path as string,
    publicUrl: row.public_url as string,
    mimeType: row.mime_type as string,
    mediaType: row.media_type as 'image' | 'video',
    mediaRole: (row.media_role as string) ?? '',
    createdAt: row.created_at as number,
    // The media_uploads bookkeeping table does not track posters — they
    // live alongside the video in Storage and are written into the owning
    // domain table (provider_media.poster_url) only.
    posterPath: null,
    posterUrl: null,
  }))
}

// ---------------------------------------------------------------------------
// Delete pipeline
// ---------------------------------------------------------------------------

/**
 * Deletes a media file from Supabase Storage and its reference row
 * from the `media_uploads` table.
 *
 * If the storage file is already gone (e.g. previously deleted or bucket
 * cleanup), the DB row is still removed to prevent orphaned metadata.
 *
 * Throws on failure so callers can surface the problem to the user.
 */
export async function deleteMediaFile(
  record: Pick<PersistedMediaRecord, 'id' | 'filePath'>
): Promise<void> {
  const { id, filePath } = record

  // Determine the bucket from the entity type encoded in the path's first segment.
  // Path format: {entityType}/{entityId}/{uuid}.{ext}
  const entityTypeSegment = filePath.split('/')[0] as MediaEntityType
  const deleteBucket = isPrivateMediaEntityType(entityTypeSegment)
    ? MEDIA_PRIVATE_BUCKET
    : MEDIA_STORAGE_BUCKET

  // 1. Remove file from Supabase Storage (best-effort: treat "not found" as success)
  const { error: storageError } = await supabase.storage
    .from(deleteBucket)
    .remove([filePath])

  if (storageError) {
    const msg = storageError.message ?? ''
    const isNotFound = /not.?found|404|does not exist/i.test(msg)
    if (isNotFound) {
      logInfo('media.delete_storage_already_gone', { id, filePath })
    } else {
      logError('media.delete_storage_failed', storageError, { id, filePath })
      throw new Error('Datei konnte nicht gelöscht werden. Bitte versuche es erneut.')
    }
  }

  // 2. Remove reference row from DB
  const { error: dbError } = await supabase
    .from('media_uploads')
    .delete()
    .eq('id', id)

  if (dbError) {
    logError('media.delete_db_failed', dbError, { id, filePath })
    throw new Error('Dateieintrag konnte nicht entfernt werden. Bitte versuche es erneut.')
  }

  logInfo('media.delete_succeeded', { id, filePath })
}
