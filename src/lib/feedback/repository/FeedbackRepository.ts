import type { JobFeedback } from '../types'

/**
 * Repository interface for the feedback domain.
 *
 * Follows the same contract used by all other persisted domains in the
 * codebase: `initialize()` loads the initial dataset, `subscribe()` allows
 * reactive listeners, and `save()` persists a feedback record.
 */
export interface FeedbackRepository {
  /** Loads initial data from the underlying store. Must be awaited at bootstrap. */
  initialize(): Promise<void>
  /** True once the initial load has completed. */
  isHydrated(): boolean
  /** Registers a change listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Returns the feedback for a specific job, or undefined if not found. */
  getByJobId(jobId: string): JobFeedback | undefined
  /** Returns all feedbacks submitted for a specific craftsman. */
  getByCraftsmanId(craftsmanUserId: string): JobFeedback[]
  /** Persists a feedback record. Idempotent by jobId. */
  save(feedback: JobFeedback): void
  /**
   * Clears all stored feedbacks. Only meaningful for in-memory / test
   * implementations — Supabase-backed repositories may implement this as a no-op.
   */
  reset?(): void
}
