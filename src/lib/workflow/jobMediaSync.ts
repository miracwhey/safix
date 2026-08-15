/**
 * jobMediaSync — Block 3.2 (Customer-Discovery → Worker-Doku photoCount)
 *
 * Cross-domain sync: re-derives `jobs.photoCount` from the actual rows
 * persisted in `media_uploads` (entity_type='job'). The legacy in-memory
 * counter (`jobs/service.ts → addJobPhoto`) was incremented by stub
 * buttons but never reflected real uploads from `JobMediaSection`. The
 * Worker-Doku-Projection (`workerDokuProjection.ts`) reads
 * `job.photoCount`, so without this sync the Worker-Doku status drifts
 * away from reality.
 *
 * Contract:
 *  - Idempotent: running it twice in a row is a no-op when nothing has
 *    changed.
 *  - Source of truth: `media_uploads` row count for the job.
 *  - Side effects: writes `jobs.photo_count` via the canonical
 *    JobRepository (Supabase or in-memory). When the count is unchanged
 *    no write is issued.
 *
 * The function is intentionally a thin façade that lives in the workflow
 * layer (cross-domain coordination) — neither the jobs domain nor the
 * media domain alone should import from the other. Callers (UI uploaders
 * + workflow hooks) reach into this module instead.
 */

import { supabase } from '../supabase'
import { logError } from '../observability'
import { getJobById } from '../jobs/jobsStore'
import { getJobRepository } from '../jobs/repository'

export type SyncJobPhotoCountResult =
  | { status: 'updated'; jobId: string; previous: number; next: number }
  | { status: 'unchanged'; jobId: string; count: number }
  | { status: 'job_missing'; jobId: string }
  | { status: 'count_failed'; jobId: string; error: unknown }

/**
 * Re-counts `media_uploads` rows for the given job and writes the result
 * into `jobs.photo_count`. Returns a result object that callers can use
 * for telemetry / log-only paths.
 *
 * Errors are swallowed (returned as result objects) so UI callers can
 * keep their happy-path; persistence failures are logged + telemetry'd
 * via the standard logError path.
 */
export async function syncJobPhotoCount(jobId: string): Promise<SyncJobPhotoCountResult> {
  if (!jobId) return { status: 'job_missing', jobId }

  const { count, error } = await supabase
    .from('media_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('entity_type', 'job')
    .eq('entity_id', jobId)

  if (error) {
    logError('job_media_sync.count_failed', error, { jobId })
    return { status: 'count_failed', jobId, error }
  }

  const next = count ?? 0
  const job = getJobById(jobId)
  if (!job) {
    // Job not in the local cache — typical when the count is requested
    // for a job the worker is not (yet) attached to. The DB row is
    // authoritative; without a local job we cannot update via the
    // domain repository, so we report missing and let the caller
    // decide.
    return { status: 'job_missing', jobId }
  }

  if (job.photoCount === next) {
    return { status: 'unchanged', jobId, count: next }
  }

  try {
    await getJobRepository().update(jobId, (current) => ({
      ...current,
      photoCount: next,
    }))
    return { status: 'updated', jobId, previous: job.photoCount, next }
  } catch (err) {
    logError('job_media_sync.update_failed', err, { jobId, previous: job.photoCount, next })
    return { status: 'count_failed', jobId, error: err }
  }
}
