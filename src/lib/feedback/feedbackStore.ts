import { getFeedbackRepository } from './repository'
import type { JobFeedback } from './types'

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export function subscribeFeedback(listener: () => void): () => void {
  return getFeedbackRepository().subscribe(listener)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getFeedbackByJobId(jobId: string): JobFeedback | undefined {
  return getFeedbackRepository().getByJobId(jobId)
}

export function getFeedbackByCraftsmanId(craftsmanUserId: string): JobFeedback[] {
  return getFeedbackRepository().getByCraftsmanId(craftsmanUserId)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Persists a feedback record. Idempotent by jobId — a second call for the
 * same job replaces the previous entry.
 */
export function storeFeedback(feedback: JobFeedback): void {
  getFeedbackRepository().save(feedback)
}

// ---------------------------------------------------------------------------
// Test / Reset
// ---------------------------------------------------------------------------

export function isFeedbackHydrated(): boolean {
  return getFeedbackRepository().isHydrated()
}

export function clearFeedbackStore(): void {
  getFeedbackRepository().reset?.()
}
