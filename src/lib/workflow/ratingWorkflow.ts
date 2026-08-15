import { getJobById } from '../jobs'
import { addRatingAsync, getRatingByJobId } from '../ratings/service'
import { canSubmitRating } from '../ratings/selectors'
import { logWarning } from '../observability'
import type { Rating, RatingSubmission } from '../ratings/types'
import { createInAppNotification } from '../inAppNotifications'
import { recordAnalyticsEvent } from '../analytics'
import { maybeRequestStoreReview } from '../native/appReview'

/**
 * Validates and persists a customer rating for a completed job.
 *
 * Guards:
 * - Job must exist and be in 'completed' status.
 * - The calling customer must be the job owner (customerUserId match).
 * - Only one rating per job is allowed.
 *
 * Returns the created Rating on success, or undefined when blocked by a guard.
 */
export async function submitRatingWorkflow(
  submission: RatingSubmission
): Promise<Rating | undefined> {
  const job = getJobById(submission.jobId)
  if (!job) {
    logWarning('workflow.ratings.job_not_found', { jobId: submission.jobId })
    return undefined
  }

  const existingRating = getRatingByJobId(submission.jobId)

  if (!canSubmitRating(job, existingRating, submission.customerUserId)) {
    logWarning('workflow.ratings.submission_blocked', {
      jobId: submission.jobId,
      jobStatus: job.status,
      hasExistingRating: existingRating !== undefined,
      callerUserId: submission.customerUserId,
    })
    return undefined
  }

  const rating: Rating = {
    id: crypto.randomUUID(),
    jobId: submission.jobId,
    providerUserId: submission.providerUserId,
    customerUserId: submission.customerUserId,
    ratingScore: submission.ratingScore,
    createdAt: Date.now(),
    ...(submission.ratingComment !== undefined && {
      ratingComment: submission.ratingComment,
    }),
  }

  const persist = await addRatingAsync(rating)
  if (!persist.ok) {
    // The repository already rolled back the optimistic cache row and recorded
    // the persistence failure. Do NOT emit analytics / notification side
    // effects for a rating that never persisted — surface failure to the UI.
    logWarning('workflow.ratings.persist_failed', {
      jobId: submission.jobId,
      ratingId: rating.id,
    })
    return undefined
  }

  recordAnalyticsEvent({
    eventType: 'rating_submitted',
    entityType: 'rating',
    entityId: rating.id,
    actorUserId: submission.customerUserId,
    metadata: { ratingScore: submission.ratingScore },
  })

  createInAppNotification({
    id: `notif-rating-${rating.id}`,
    userId: submission.providerUserId,
    type: 'rating_received',
    entityType: 'rating',
    entityId: rating.id,
    title: 'Neue Bewertung erhalten',
    message: `Sie haben eine ${submission.ratingScore}-Sterne-Bewertung für Ihren Auftrag erhalten.`,
    isRead: false,
    createdAt: Date.now(),
  })

  // Store-review prompt: a customer who just rated a completed job 4★+ is
  // the strongest satisfied-user signal we have. Fire-and-forget — the
  // adapter gates on native platform + cooldown and never throws.
  if (submission.ratingScore >= 4) {
    void maybeRequestStoreReview()
  }

  return rating
}
