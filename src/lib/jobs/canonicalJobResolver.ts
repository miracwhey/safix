/**
 * Canonical Accepted Job Resolver
 *
 * When duplicate jobs exist for the same customer ↔ craftsman conversation/project
 * (e.g. an old inquiry-converted job AND a newer accepted-offer job), this module
 * determines which job is the canonical one for accepted-order operations.
 *
 * CANONICAL RULE:
 *   For accepted-offer operational flows, the canonical job is the one actually
 *   linked to the accepted offer:
 *     - offer.createdJobId = job.id
 *     - and/or job.sourceOfferId = accepted offer id
 *
 *   A stale pre-acceptance/inquiry-conversion duplicate without that canonical
 *   linkage must not win the operational routing.
 *
 * This module is intentionally stateless and purely selector-based — it reads
 * from the existing job/offer repositories and does not mutate anything.
 */

import type { Job } from './types'

/**
 * Given a set of candidate jobs that all relate to the same conversation or
 * project, returns the canonical accepted job — the one that should be used
 * for downstream operations (funding, escrow, project detail, etc.).
 *
 * Priority order:
 *   1. Job with `sourceOfferId` set (canonical accepted offer linkage)
 *   2. Job with `proposalAcceptedAt` set and `status === 'booked'` or beyond
 *   3. First job (fallback — preserves existing behaviour for non-duplicate cases)
 *
 * Returns `undefined` only when the input array is empty.
 */
export function resolveCanonicalJob(candidates: Job[]): Job | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  // Priority 1: job linked to accepted offer via sourceOfferId
  const withSourceOffer = candidates.find((j) => j.sourceOfferId)
  if (withSourceOffer) return withSourceOffer

  // Priority 2: accepted & booked job
  const bookedAccepted = candidates.find(
    (j) => j.proposalAcceptedAt && (j.status === 'booked' || j.status === 'in_progress' || j.status === 'waiting_payment')
  )
  if (bookedAccepted) return bookedAccepted

  // Fallback: first candidate (preserves existing behaviour)
  return candidates[0]
}

/**
 * Two jobs are considered "related" (potentially duplicates) when they share
 * any of these identifying links:
 *   - Same sourceConversationId
 *   - Same projectId
 *   - Same customerUserId + craftsmanUserId pair (same customer ↔ craftsman
 *     relationship, potentially across different conversations)
 */
function areJobsRelated(a: Job, b: Job): boolean {
  if (
    a.sourceConversationId &&
    b.sourceConversationId &&
    a.sourceConversationId === b.sourceConversationId
  ) {
    return true
  }

  if (a.projectId && b.projectId && a.projectId === b.projectId) {
    return true
  }

  if (
    a.customerUserId &&
    b.customerUserId &&
    a.craftsmanUserId &&
    b.craftsmanUserId &&
    a.customerUserId === b.customerUserId &&
    a.craftsmanUserId === b.craftsmanUserId
  ) {
    return true
  }

  return false
}

/**
 * Returns `true` when this job is a stale duplicate superseded by a canonical
 * accepted job.
 *
 * A job is superseded when ALL of these hold:
 *   - Another job in `allJobs` is related (same conversation, project, or
 *     customer ↔ craftsman pair)
 *   - That other job has `sourceOfferId` set (canonical accepted-offer linkage)
 *   - This job does NOT have `sourceOfferId` set
 *   - This job is in an active/operational status (not completed/cancelled)
 *
 * This helper is designed for filtering job lists — operational surfaces
 * should call this to suppress stale duplicates.
 */
export function isSupersededByCanonicalJob(job: Job, allJobs: Job[]): boolean {
  // A job with sourceOfferId is by definition not superseded
  if (job.sourceOfferId) return false

  // A job that is completed/cancelled is not considered for suppression
  if (job.status === 'completed' || job.status === 'cancelled') return false

  // Find if any other related job is the canonical one
  for (const candidate of allJobs) {
    if (candidate.id === job.id) continue
    if (!candidate.sourceOfferId) continue
    if (areJobsRelated(job, candidate)) return true
  }

  return false
}

/**
 * Filters a job list to exclude stale duplicate jobs that are superseded
 * by canonical accepted jobs.
 *
 * Used by dashboard and list selectors to prevent duplicate entries.
 */
export function filterSupersededJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => !isSupersededByCanonicalJob(job, jobs))
}

/**
 * Given a specific job ID, attempts to find the canonical accepted job
 * for the same conversation/project/pair — i.e. the one the user *should*
 * be operating on.
 *
 * Returns `undefined` if the given job is already canonical or no
 * canonical override exists.
 */
export function findCanonicalOverride(jobId: string, allJobs: Job[]): Job | undefined {
  const job = allJobs.find((j) => j.id === jobId)
  if (!job) return undefined

  // Already canonical
  if (job.sourceOfferId) return undefined

  // Look for the canonical accepted job
  for (const candidate of allJobs) {
    if (candidate.id === job.id) continue
    if (!candidate.sourceOfferId) continue
    if (areJobsRelated(job, candidate)) return candidate
  }

  return undefined
}
