/**
 * A piece of post-completion feedback submitted by a customer after a job
 * has been successfully completed and payment has been released.
 *
 * Kept intentionally minimal for the MVP — one binary signal plus an optional
 * short note. No star ratings, no multi-dimension scoring.
 */
export type JobFeedback = {
  id: string
  /** The job this feedback relates to. One feedback per job maximum. */
  jobId: string
  /** Supabase user_id of the craftsman who performed the work. */
  craftsmanUserId: string
  /**
   * Supabase user_id of the customer who submitted this feedback.
   * Used as the direct ownership anchor for RLS policies on job_feedback.
   * Ensures only the originating customer can upsert their own feedback row.
   */
  customerUserId?: string
  /** The single trust signal: would this customer hire the craftsman again? */
  wouldHireAgain: boolean
  /** Optional short note from the customer (max 140 characters). */
  note?: string
  /** Unix timestamp (ms) when the feedback was submitted. */
  createdAt: number
}
