/**
 * Showcase Upload Service — BLOCK 58C: Media Foundation Aligned to SaFix Product Logic
 *
 * Provides the provider showcase upload flow.
 *
 * Showcase media models the SaFix reel/portfolio capability:
 * - providers can upload work photos and short video clips
 * - uploads are stored at `showcase/{providerId}/{uuid}.{ext}`
 * - DB reference stored in `media_uploads` with entity_type='showcase'
 *   and media_role='showcase'
 *
 * This is the video foundation layer.  Full video streaming / transcoding
 * / thumbnail generation is intentionally out of scope.  What we deliver:
 * - validated MIME type (image or short video)
 * - persisted `PersistedMediaRecord` with mediaType='video'
 * - reload-safe: the public URL survives page reload
 * - `videoUrl` / `thumbnailUrl` can be populated from the public URL
 *
 * Storage path layout:
 *   showcase/{providerId}/{uuid}.{ext}
 *   e.g.  showcase/prov-abc/9f3d1c2e.jpg     (showcase photo)
 *         showcase/prov-abc/clip-8a2b4c.mp4   (showcase video)
 */

import { uploadMediaFile, fetchMediaForEntity, deleteMediaFile } from '../media/mediaUploadService'
import type { PersistedMediaRecord } from '../media/mediaUploadService'
import { logInfo } from '../observability'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShowcaseUploadInput = {
  file: File
  /** providers.id (DB-generated UUID, used as entityId) */
  providerId: string
  /** providers.profile_id = auth.users.id */
  ownerUserId: string
  /** Optional human-readable caption for the showcase item */
  caption?: string
}

export type ShowcaseUploadResult = {
  record: PersistedMediaRecord
  /** Caption passed through for UI display */
  caption: string
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Uploads a provider showcase photo or short video clip.
 *
 * Accepts both images (JPEG, PNG, WebP, GIF ≤10 MB) and short videos
 * (MP4, WebM, MOV ≤50 MB).  The caller is responsible for rendering the result
 * appropriately based on `result.record.mediaType`.
 *
 * Throws on failure; callers should surface the error via InlineFeedback
 * or similar user-facing feedback.
 */
export async function uploadShowcaseMedia(
  input: ShowcaseUploadInput
): Promise<ShowcaseUploadResult> {
  const { file, providerId, ownerUserId, caption = '' } = input

  const record = await uploadMediaFile({
    file,
    entityType: 'showcase',
    entityId: providerId,
    ownerUserId,
    mediaRole: 'showcase',
  })

  logInfo('media.showcase.upload_complete', {
    providerId,
    publicUrl: record.publicUrl,
    mediaType: record.mediaType,
  })

  return { record, caption }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetches all showcase media records for a provider, ordered newest-first.
 *
 * Returns an empty array on error so callers remain stable.
 * The returned records include both images and videos; callers can filter
 * by `record.mediaType` to separate them.
 */
export async function fetchProviderShowcase(
  providerId: string
): Promise<PersistedMediaRecord[]> {
  return fetchMediaForEntity('showcase', providerId)
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a showcase media item from storage and the DB.
 *
 * Throws on failure; callers should surface the error via InlineFeedback.
 */
export async function deleteShowcaseMedia(
  record: Pick<PersistedMediaRecord, 'id' | 'filePath'>
): Promise<void> {
  await deleteMediaFile(record)

  logInfo('media.showcase.delete_complete', {
    recordId: record.id,
    filePath: record.filePath,
  })
}
