/**
 * Upload rollback helpers — shared between avatar + portfolio pipelines.
 *
 * Both pipelines do the same dance: upload via {@link uploadMediaFile}
 * (writes Storage object + media_uploads row), then write into
 * `provider_media`. If anything between the upload and the final
 * `provider_media` write fails, the just-uploaded record is orphaned
 * unless it gets rolled back. These helpers centralise the cleanup +
 * error-detail surface so the two services behave identically and a
 * future third caller can reuse them without copy-paste.
 */

import type { PostgrestError } from '@supabase/supabase-js'
import { deleteMediaFile } from '../media/mediaUploadService'
import type { PersistedMediaRecord } from '../media/mediaUploadService'
import { logError, logInfo } from '../observability'

/**
 * Builds a single-line diagnostic string from a PostgREST error.
 * Includes message + details + hint + code so the actual cause
 * (RLS violation, partial-index conflict, missing column, …) is
 * visible to logs AND propagated to the UI via Error.message.
 */
export function describePostgrestError(
  err: PostgrestError | null | undefined,
): string {
  if (!err) return 'Unbekannter Fehler'
  return [
    err.message,
    err.details ? `details=${err.details}` : '',
    err.hint ? `hint=${err.hint}` : '',
    err.code ? `code=${err.code}` : '',
  ]
    .filter(Boolean)
    .join(' | ')
}

/**
 * Removes a just-uploaded media record (Storage object + media_uploads
 * row) when a later step in the upload pipeline fails. Best-effort —
 * a cleanup failure is logged but never replaces the original error
 * thrown to the caller.
 */
export async function rollbackOrphanedUpload(
  record: Pick<PersistedMediaRecord, 'id' | 'filePath'>,
  context: { stage: string; ownerUserId: string },
): Promise<void> {
  try {
    await deleteMediaFile(record)
    logInfo('media.upload.orphan_cleaned', {
      stage: context.stage,
      ownerUserId: context.ownerUserId,
      mediaUploadId: record.id,
      filePath: record.filePath,
    })
  } catch (cleanupErr) {
    logError('media.upload.orphan_cleanup_failed', cleanupErr, {
      stage: context.stage,
      ownerUserId: context.ownerUserId,
      mediaUploadId: record.id,
      filePath: record.filePath,
    })
  }
}
