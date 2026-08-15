/**
 * Project Status Sync Service
 *
 * Ensures project.status reflects the current job lifecycle stage after reload.
 * Projects must derive their status from persisted job state, not rely on transient UI state.
 *
 * Status derivation rules:
 * - 'request'     → job.status === 'new' && no proposal sent
 * - 'accepted'    → proposal accepted OR job.status === 'scheduled'
 * - 'scheduled'   → job.status === 'scheduled' (alternative to 'accepted')
 * - 'in_progress' → job.status === 'in_progress'
 * - 'review'      → job.status === 'waiting_payment'
 * - 'completed'   → job.status === 'completed'
 * - 'cancelled'   → job.status === 'cancelled'
 */

import type { Job } from '../jobs/types'
import type { PaymentState } from '../shared/coreTypes'
import type { Project, ProjectStatus } from './projectTypes'
import { deriveProposalLifecycle } from '../jobs/helpers'

/**
 * Derives the correct project status from job state.
 * This is the canonical mapping from job lifecycle to customer-facing project status.
 */
export function deriveProjectStatusFromJob(
  job: Pick<Job, 'status' | 'proposalSentAt' | 'proposalAcceptedAt'>
): ProjectStatus {
  const lifecycle = deriveProposalLifecycle(job.proposalSentAt, job.proposalAcceptedAt)

  // Terminal states
  if (job.status === 'completed') {
    return 'completed'
  }
  if (job.status === 'cancelled') {
    return 'cancelled'
  }

  // Active work states
  if (job.status === 'in_progress') {
    return 'in_progress'
  }

  if (job.status === 'waiting_payment') {
    return 'review'
  }

  // Scheduled/accepted state
  if (job.status === 'scheduled') {
    return 'scheduled'
  }

  // Booked jobs (created from accepted offers)
  if (job.status === 'booked') {
    return 'accepted'
  }

  // New jobs with accepted proposal
  if (job.status === 'new' && lifecycle.stage === 'accepted') {
    return 'accepted'
  }

  // Default: raw inquiry state
  return 'request'
}

/**
 * Checks if a project's status is out of sync with its source job.
 * Returns true if the project needs a status update.
 */
export function isProjectStatusStale(project: Project, job: Job): boolean {
  const correctStatus = deriveProjectStatusFromJob(job)
  return project.status !== correctStatus
}

/**
 * Creates a project update that syncs status and payment state from job.
 * Use this to generate the update payload when rehydrating after reload.
 *
 * When a canonical payment state is provided it takes precedence over the
 * job-level mirror (which may lag behind the canonical payment store after
 * a partial-success sync).
 */
export function syncProjectFromJob(job: Job, canonicalPaymentState?: PaymentState): Pick<Project, 'status' | 'paymentState'> {
  return {
    status: deriveProjectStatusFromJob(job),
    paymentState: canonicalPaymentState ?? job.paymentState,
  }
}
