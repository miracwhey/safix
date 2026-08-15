import type { Job } from '../../jobs/types'
import { ensureTimelineEvent } from '../../timeline'
import { recordAnalyticsEvent } from '../../analytics'
import { sendWorkCompletedEmail } from '../../notifications/delivery'
import { logError } from '../../observability'

export type WorkCompletedContext = {
  jobId: string
  /**
   * Fully resolved Job snapshot from the caller — captured after
   * updateJobWorkCompleted() so workCompletedAt is set.
   * customerUserId and title do not change on that mutation;
   * the hook never reads from the store.
   */
  job: Job
}

/**
 * Side effects to run after a successful job:work_completed transition.
 *
 * Triggered by markWorkCompleteWorkflow immediately after
 * updateJobWorkCompleted() commits. Escrow tranche eligibility
 * (tranche_75_eligible + recordWorkCompleted) stays in the workflow
 * because it is conditional on escrow plan existence and is domain logic,
 * not a notification/analytics side effect.
 *
 * CONTRACT
 * --------
 * - Must only be called AFTER updateJobWorkCompleted() has committed.
 * - Never throws. All errors are caught and logged internally.
 * - Context must be fully resolved by the caller — no store reads inside.
 *
 * Analytics note:
 *   Uses 'work_completed_recorded' — the correct semantic type for the
 *   craftsman recording work completion. 'job_completed' was the previous
 *   (incorrect) value; it belongs to the payment:released terminal transition,
 *   not to this earlier lifecycle point.
 *
 * Error handling:
 *   Timeline events          — try/catch, logError, execution continues.
 *   recordAnalyticsEvent     — direct call (non-throwing by convention).
 *   sendWorkCompletedEmail   — fire-and-forget by delivery service contract;
 *                              never throws or blocks the workflow.
 */
export async function runWorkCompletedSideEffects(
  ctx: WorkCompletedContext
): Promise<void> {
  const { jobId, job } = ctx

  // ── Timeline (idempotent) ─────────────────────────────────────────────────
  try {
    ensureTimelineEvent({ jobId, type: 'work_completed' })
  } catch (err) {
    logError('hook.work_completed.timeline_failed', err, { jobId })
  }

  // ── Analytics (correct type: 'work_completed_recorded', not 'job_completed')
  recordAnalyticsEvent({
    eventType: 'work_completed_recorded',
    entityType: 'job',
    entityId: jobId,
    actorUserId: job.craftsmanUserId ?? undefined,
  })

  // ── Email (fire-and-forget by delivery service contract) ─────────────────
  sendWorkCompletedEmail(jobId, job.customerUserId, { jobTitle: job.title })
}
