import type { JobFeedback } from './types'
import { storeFeedback, getFeedbackByJobId, getFeedbackByCraftsmanId } from './feedbackStore'
import { getSession } from '../session'

// Re-export reads so callers import from the service layer, not the store directly.
export { getFeedbackByJobId, getFeedbackByCraftsmanId }

/**
 * Submits post-completion feedback for a job.
 *
 * Only allowed once per job — calling this a second time for the same jobId
 * replaces the previous entry (idempotent).
 *
 * customerUserId is captured from the active session so the Supabase
 * job_feedback INSERT policy (`customer_user_id = auth.uid()`) can verify
 * ownership without relying on auth.role()='authenticated'.
 * If the session is absent (unexpected), the write will be rejected by RLS.
 */
export function submitJobFeedback(input: {
  jobId: string
  craftsmanUserId: string
  wouldHireAgain: boolean
  note?: string
}): JobFeedback {
  const session = getSession()
  const customerUserId = session.user?.id ?? undefined
  if (!customerUserId) {
    console.warn(
      '[submitJobFeedback] No authenticated session — feedback will be created without customerUserId and the DB write will be rejected by RLS.'
    )
  }
  const feedback: JobFeedback = {
    id: `feedback-${input.jobId}`,
    jobId: input.jobId,
    craftsmanUserId: input.craftsmanUserId,
    ...(customerUserId != null && { customerUserId }),
    wouldHireAgain: input.wouldHireAgain,
    note: input.note?.trim() || undefined,
    createdAt: Date.now(),
  }
  storeFeedback(feedback)
  return feedback
}
