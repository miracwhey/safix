/**
 * Avatar Upload Service — provider profile avatars.
 *
 * End-to-end flow:
 *   1. Upload file via {@link uploadMediaFile}
 *      (writes Storage object + media_uploads row).
 *   2. Best-effort delete of any previous avatar records.
 *   3. Persist a row in `provider_media` (kind='avatar').
 *   4. Update `providers.avatar_url` so discovery + search reflect it.
 *
 * Failure handling
 *   Once step 1 has produced a Storage object + media_uploads row, any
 *   subsequent failure (provider_media select/update/insert, providers
 *   update) leaves that file orphaned: storage quota burns and the row
 *   sits unreferenced. We treat the just-uploaded record as a tombstone
 *   we own until the chain succeeds: on error, the storage object + the
 *   media_uploads row are deleted via {@link deleteMediaFile}, the
 *   cleanup error (if any) is logged, and the original error is thrown
 *   with its server-side detail intact so the UI can show it.
 */

import { supabase } from '../supabase'
import { uploadMediaFile, fetchMediaForEntity, deleteMediaFile } from '../media/mediaUploadService'
import { logError, logInfo, logWarning } from '../observability'
import { describePostgrestError, rollbackOrphanedUpload } from './uploadRollback'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AvatarUploadInput = {
  file: File
  /** providers.profile_id = auth.users.id */
  ownerUserId: string
  /** providers.id (DB-generated, needed to update provider_media) */
  providerId: string
}

export type AvatarUploadResult = {
  publicUrl: string
  mediaUploadId: string
}

// ---------------------------------------------------------------------------
// Avatar upload pipeline
// ---------------------------------------------------------------------------

/**
 * Uploads a provider avatar image, persists references in `media_uploads`
 * and `provider_media`, then updates `providers.avatar_url`.
 *
 * On any post-upload failure the freshly uploaded storage object and
 * media_uploads row are removed before the original error is rethrown,
 * so retries do not collide with a half-written previous attempt and no
 * orphaned bytes are left in the bucket.
 *
 * Throws on failure with a descriptive message that includes the
 * underlying PostgREST detail (code/hint/details) when available.
 */
export async function uploadProviderAvatar(
  input: AvatarUploadInput
): Promise<AvatarUploadResult> {
  const { file, ownerUserId, providerId } = input

  // 0. Pre-fetch existing avatar refs so we can clean them up after the
  //    new upload lands. Failure here is non-blocking — we still proceed.
  let previousAvatars: { id: string; filePath: string }[] = []
  try {
    const existing = await fetchMediaForEntity('profile', ownerUserId)
    previousAvatars = existing
      .filter((r) => r.mediaRole === 'avatar')
      .map((r) => ({ id: r.id, filePath: r.filePath }))
  } catch (err) {
    logWarning('media.avatar.fetch_previous_failed', {
      ownerUserId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  // 1. Upload + media_uploads insert. Any failure here surfaces directly,
  //    no orphan to clean (uploadMediaFile already cleans its own storage
  //    object on db-insert failure).
  const record = await uploadMediaFile({
    file,
    entityType: 'profile',
    entityId: ownerUserId,
    ownerUserId,
    mediaRole: 'avatar',
  })
  const { publicUrl } = record

  // From here on, any thrown error must roll back `record` to avoid an
  // orphaned storage object + media_uploads row. The chain runs inside
  // a try/catch that performs cleanup once on the first thrown error and
  // rethrows the original.
  try {
    // 2. Clean up previous avatar refs — best-effort. Cleanup failures
    //    are logged but do not abort the new upload, since the new row
    //    already replaces them logically.
    for (const prev of previousAvatars) {
      try {
        await deleteMediaFile(prev)
        logInfo('media.avatar.previous_cleaned', { previousId: prev.id })
      } catch (cleanupErr) {
        logWarning('media.avatar.previous_cleanup_failed', {
          previousId: prev.id,
          reason: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        })
      }
    }

    // 3. Persist the avatar row in provider_media.
    //    Why select-then-write instead of upsert: the (provider_id, kind)
    //    uniqueness for kind <> 'portfolio' is enforced via a *partial*
    //    unique index (idx_provider_media_provider_kind_singular), and
    //    PostgREST cannot target a partial index from `.upsert(...,
    //    { onConflict })`. Sequencing read-then-update/insert keeps the
    //    RLS-checks clean (caller is the owner via the existing policies)
    //    without needing a SECURITY DEFINER RPC.
    //
    //    The owner-scoped SELECT policy added in migration
    //    20260504000001_provider_media_owner_access.sql is what makes
    //    this select see the owner's own row even when is_public=false;
    //    without it the SELECT silently returned 0 rows and the INSERT
    //    branch hit the partial unique index with PG 23505.
    const now = new Date().toISOString()

    const { data: existingAvatar, error: selectError } = await supabase
      .from('provider_media')
      .select('id')
      .eq('provider_id', providerId)
      .eq('kind', 'avatar')
      .maybeSingle()

    if (selectError) {
      const detail = describePostgrestError(selectError)
      logError('media.avatar.provider_media_select_failed', selectError, {
        providerId,
        ownerUserId,
        detail,
      })
      throw new Error(`Profilbild konnte nicht gespeichert werden: ${detail}`)
    }

    const pmPayload = {
      provider_id: providerId,
      kind: 'avatar' as const,
      storage_path: record.filePath,
      public_url: publicUrl,
      media_type: record.mediaType,
      caption: null,
      sort_order: 0,
      updated_at: now,
    }

    if (existingAvatar?.id) {
      const { error: pmUpdateError } = await supabase
        .from('provider_media')
        .update(pmPayload)
        .eq('id', existingAvatar.id)
      if (pmUpdateError) {
        const detail = describePostgrestError(pmUpdateError)
        logError('media.avatar.provider_media_update_failed', pmUpdateError, {
          providerId,
          ownerUserId,
          publicUrl,
          detail,
        })
        throw new Error(`Profilbild konnte nicht gespeichert werden: ${detail}`)
      }
    } else {
      const { error: pmInsertError } = await supabase
        .from('provider_media')
        .insert({ ...pmPayload, created_at: now })
      if (pmInsertError) {
        const detail = describePostgrestError(pmInsertError)
        logError('media.avatar.provider_media_insert_failed', pmInsertError, {
          providerId,
          ownerUserId,
          publicUrl,
          detail,
        })
        throw new Error(`Profilbild konnte nicht gespeichert werden: ${detail}`)
      }
    }

    // 4. Reflect the new avatar on `providers.avatar_url` for discovery
    //    and search-result rendering.
    const { error: providerError } = await supabase
      .from('providers')
      .update({ avatar_url: publicUrl, updated_at: now })
      .eq('profile_id', ownerUserId)

    if (providerError) {
      const detail = describePostgrestError(providerError)
      logError('media.avatar.providers_update_failed', providerError, {
        ownerUserId,
        publicUrl,
        detail,
      })
      throw new Error(`Profilbild konnte nicht gespeichert werden: ${detail}`)
    }

    logInfo('media.avatar.upload_complete', { ownerUserId, providerId, publicUrl })

    return { publicUrl, mediaUploadId: record.id }
  } catch (err) {
    // Roll back the just-uploaded record so retries start clean and
    // storage quota is not leaked. The cleanup itself never replaces
    // the original error.
    await rollbackOrphanedUpload(
      { id: record.id, filePath: record.filePath },
      { stage: 'avatar_pipeline', ownerUserId },
    )
    throw err
  }
}
