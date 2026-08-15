/**
 * tryUploadOrEnqueue — outbox-aware wrapper around uploadMediaFile.
 *
 * Field-craftsmen typically capture media from a job site with flaky
 * connectivity. The plain `uploadMediaFile` throws on the first network
 * blip, leaving the user to manually retry every photo. This wrapper:
 *
 *   1. If the device is offline at call time, skips the network attempt
 *      entirely and enqueues the file in the IndexedDB outbox.
 *   2. Otherwise tries the upload. On a network-shaped failure (no fetch,
 *      ERR_INTERNET_DISCONNECTED, Supabase transport error), enqueues
 *      instead of rethrowing.
 *   3. Anything else (validation, RLS denial, magic-byte mismatch) is
 *      rethrown verbatim — those are real user-actionable errors and
 *      should not silently sit in the queue.
 *
 * The outbox runner (started in AppBootstrap) drains the queue whenever
 * the browser fires `online` and on a slow polling interval.
 */

import {
  uploadMediaFile,
  type MediaUploadInput,
  type PersistedMediaRecord,
} from './mediaUploadService'
import { enqueueUpload, type OutboxEntry } from './uploadOutbox'
import { logInfo } from '../observability'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadOrEnqueueOptions = {
  /** Human-readable label shown in queue UIs ("Foto: Job Steinweg 12"). */
  label?: string
}

export type UploadOrEnqueueResult =
  | { status: 'uploaded'; record: PersistedMediaRecord }
  | { status: 'queued'; entry: OutboxEntry; reason: 'offline' | 'network_error' }

// ---------------------------------------------------------------------------
// Network-error heuristic
// ---------------------------------------------------------------------------

/**
 * Best-effort network-error detection. Treated as opaque rather than
 * brittle pattern-matching on Supabase internals: any error that the user
 * cannot fix by retrying with a fresh form input qualifies for the queue.
 */
function looksLikeTransientNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  if (!err) return false
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('err_internet_disconnected') ||
    message.includes('err_network') ||
    // Supabase wraps storage errors with a German user message that ends with
    // "Internetverbindung". Keep this in sync with mediaUploadService.ts:341.
    message.includes('internetverbindung')
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function tryUploadOrEnqueue(
  input: MediaUploadInput,
  opts: UploadOrEnqueueOptions = {}
): Promise<UploadOrEnqueueResult> {
  const baseLabel = opts.label ?? input.file.name ?? 'Upload'

  // One stable idempotency key for this logical upload, shared by the inline
  // attempt and the queued retries. Guarantees the first attempt (which may
  // commit server-side then time out) and every outbox retry target the same
  // storage object + media_uploads row — no duplicate on post-commit timeout.
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()

  // Pre-flight offline shortcut — never even attempt the network so the
  // user does not wait for a fetch timeout.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const entry = await enqueueUpload({
      file: input.file,
      entityType: input.entityType,
      entityId: input.entityId,
      ownerUserId: input.ownerUserId,
      mediaRole: input.mediaRole ?? '',
      idempotencyKey,
      label: baseLabel,
    })
    logInfo('media.upload_enqueued_offline', { id: entry.id, label: baseLabel })
    return { status: 'queued', entry, reason: 'offline' }
  }

  try {
    const record = await uploadMediaFile({ ...input, idempotencyKey })
    return { status: 'uploaded', record }
  } catch (err) {
    if (!looksLikeTransientNetworkError(err)) {
      throw err
    }
    const entry = await enqueueUpload({
      file: input.file,
      entityType: input.entityType,
      entityId: input.entityId,
      ownerUserId: input.ownerUserId,
      mediaRole: input.mediaRole ?? '',
      idempotencyKey,
      label: baseLabel,
    })
    logInfo('media.upload_enqueued_after_network_error', {
      id: entry.id,
      label: baseLabel,
      reason: err instanceof Error ? err.message : String(err),
    })
    return { status: 'queued', entry, reason: 'network_error' }
  }
}
