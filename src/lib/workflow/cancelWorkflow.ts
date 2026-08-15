/**
 * Cancel / Close / Withdraw Workflow
 *
 * Provides proper cancel/close/reset paths for projects and inquiries
 * from both customer and craftsman sides.
 *
 * Rules:
 * - Customer can withdraw/cancel a project before offer acceptance
 * - Craftsman can reject/close an inquiry
 * - After acceptance, cancel sets project to 'cancelled' and job to 'cancelled'
 * - Cancelled/closed cases disappear from active surfaces but remain consistent
 * - Never hard-deletes — sets status to 'cancelled' for auditability
 * - Cancelled is NOT the same as completed — business truth must distinguish them
 */

import { getProjectById, updateProject, type Project } from '../projects'
import { getJobById, updateJobStatus, removeJob } from '../jobs'
import { getPaymentForJob } from '../payments'
import {
  isFundingConfirmedForJob,
  getFundingRequestByJobId,
  markFundingCancelled,
  type FundingRequestStatus,
} from '../payments/fundingRequest'
import { logInfo, logWarning } from '../observability'
import { recordAnalyticsEvent } from '../analytics'

const CANCEL_BLOCKING_PAYMENT_STATES = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
  'disputed',
])

/**
 * FundingRequest statuses that are SAFE to cancel as part of a job-cancel
 * cascade — i.e. pre-PaymentIntent states with NO live Stripe PaymentIntent
 * attached.
 *
 * Deliberately EXCLUDES:
 *   - 'funding_initiated' — a LIVE Stripe PaymentIntent exists. Cancelling the
 *     request without cancelling that PI would strand it (customer can still
 *     pay → money in escrow on a dead order). That narrow window is closed by
 *     the deferred confirm_funding_atomic RPC job-status check, NOT here.
 *   - 'funded' / 'cancelled' — terminal (markFundingCancelled no-ops anyway).
 *   - 'expired' — terminal; nothing left to close.
 */
const FUNDING_SAFE_TO_CANCEL_STATES = new Set<FundingRequestStatus>([
  'created',
  'sent',
  'funding_started',
  'funding_failed',
])

/**
 * Closes the FundingRequest linked to a cancelled job, but ONLY when it is in
 * a safe pre-PaymentIntent state.
 *
 * Why this exists: a job can be cancelled while a FundingRequest is still open
 * (cancel is only blocked once funds are CONFIRMED). Without closing the
 * funding path, a customer could still fund a cancelled job and park real money
 * in escrow on a dead order.
 *
 * Idempotent and defensive: a missing request, or a request in a non-safe /
 * terminal state, is a silent no-op. Never throws.
 */
async function cancelLinkedFundingRequestIfSafe(jobId: string): Promise<void> {
  const fundingRequest = getFundingRequestByJobId(jobId)
  if (!fundingRequest) return

  if (!FUNDING_SAFE_TO_CANCEL_STATES.has(fundingRequest.status)) {
    // funding_initiated (live PI) and terminal states are intentionally skipped.
    logInfo('workflow.cancel.funding_cascade_skipped', {
      jobId,
      fundingRequestId: fundingRequest.id,
      fundingStatus: fundingRequest.status,
    })
    return
  }

  try {
    await markFundingCancelled(fundingRequest.id)
    logInfo('workflow.cancel.funding_request_cancelled', {
      jobId,
      fundingRequestId: fundingRequest.id,
      previousStatus: fundingRequest.status,
    })
  } catch (err) {
    // Money-safe: the job is already cancelled and initiate-funding now refuses
    // a terminal job, so a failed funding-row cancel cannot fund a dead order.
    // Log for reconciliation rather than aborting the cancel flow.
    logWarning('workflow.cancel.funding_cascade_failed', {
      jobId,
      fundingRequestId: fundingRequest.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Terminates a linked job by either removing it (pre-acceptance) or setting
 * it to 'cancelled' (post-acceptance). Centralises the cancel-job logic
 * to avoid duplication across cancel/close workflows.
 */
async function terminateLinkedJob(jobId: string): Promise<void> {
  const job = getJobById(jobId)
  if (!job) return

  if (job.status === 'new' && !job.proposalAcceptedAt) {
    // Pre-acceptance: safe to remove
    await removeJob(job.id)
  } else {
    // Post-acceptance: set to cancelled (NOT completed — cancelled ≠ successfully finished)
    await updateJobStatus(job.id, 'cancelled')
  }
}

/**
 * Customer withdraws/cancels a project before offer acceptance.
 *
 * Applicable when:
 * - Project is in 'request' status (no offer accepted yet)
 * - Project may or may not have a sourceJobId
 *
 * Effects:
 * - Sets project.status to 'cancelled'
 * - If a linked job exists and is still 'new', removes it
 * - Linked conversation gets a status label update
 *
 * @returns The updated project, or undefined if not found / already past cancellation point
 */
export async function cancelProjectWorkflow(projectId: string): Promise<Project | undefined> {
  const project = getProjectById(projectId)
  if (!project) return undefined

  // Already cancelled — idempotent
  if (project.status === 'cancelled') return project

  // Only allow cancellation for pre-acceptance states
  if (project.status !== 'request') {
    logWarning('workflow.cancel.not_cancellable_status', {
      projectId,
      currentStatus: project.status,
    })
    return undefined
  }

  // Cancel the project
  await updateProject(projectId, {
    status: 'cancelled',
    updatedAt: Date.now(),
  })

  // Clean up linked job if it exists and is still new (pre-acceptance)
  if (project.sourceJobId) {
    const job = getJobById(project.sourceJobId)
    if (job && job.status === 'new' && !job.proposalAcceptedAt) {
      await removeJob(job.id)
    }
  }

  logInfo('workflow.cancel.project_cancelled', { projectId })

  recordAnalyticsEvent({
    eventType: 'project_cancelled',
    entityType: 'project',
    entityId: projectId,
    actorUserId: project.customerUserId,
  })

  return getProjectById(projectId)
}

/**
 * Cancel a project/case after offer acceptance.
 *
 * This is the post-acceptance cancellation path. The project has already
 * been linked to a job and may have payment state.
 *
 * Effects:
 * - Sets project.status to 'cancelled'
 * - Sets linked job to 'cancelled' (distinct from 'completed' — preserves
 *   business truth that this case was cancelled, not successfully finished)
 * - Does NOT delete the job — preserves audit trail
 *
 * @returns The updated project, or undefined if not found
 */
export async function cancelAcceptedProjectWorkflow(projectId: string): Promise<Project | undefined> {
  const project = getProjectById(projectId)
  if (!project) return undefined

  // Already cancelled — idempotent
  if (project.status === 'cancelled') return project

  // Must have a job link to be in accepted state
  if (!project.sourceJobId) {
    logWarning('workflow.cancel.no_job_link', { projectId })
    return undefined
  }

  const job = getJobById(project.sourceJobId)
  if (!job) {
    logWarning('workflow.cancel.job_not_found', {
      projectId,
      sourceJobId: project.sourceJobId,
    })
    return undefined
  }

  // Don't cancel already-terminal jobs
  if (job.status === 'completed' || job.status === 'cancelled') {
    logWarning('workflow.cancel.job_already_terminal', {
      projectId,
      jobId: job.id,
      jobStatus: job.status,
    })
    return undefined
  }

  // Block cancel when funds are already secured. Two independent checks
  // (belt-and-suspenders) cover the stale-payment case: payment.state may
  // still read deposit_required while FundingRequest/EscrowPlan already
  // confirm the money is in escrow.
  const payment = getPaymentForJob(job.id)
  const fundingConfirmed = isFundingConfirmedForJob(job.id)
  if (fundingConfirmed || (payment && CANCEL_BLOCKING_PAYMENT_STATES.has(payment.state))) {
    logWarning('workflow.cancel.blocked_by_active_payment', {
      projectId,
      jobId: job.id,
      paymentState: payment?.state,
      fundingConfirmed,
    })
    return undefined
  }

  // Set project to cancelled
  await updateProject(projectId, {
    status: 'cancelled',
    updatedAt: Date.now(),
  })

  // Set job to cancelled (NOT completed — cancelled ≠ successfully finished)
  await updateJobStatus(job.id, 'cancelled')

  // Close the funding path so the now-cancelled job can no longer be funded.
  await cancelLinkedFundingRequestIfSafe(job.id)

  logInfo('workflow.cancel.accepted_project_cancelled', {
    projectId,
    jobId: job.id,
  })

  recordAnalyticsEvent({
    eventType: 'project_cancelled',
    entityType: 'project',
    entityId: projectId,
    actorUserId: project.customerUserId,
  })

  return getProjectById(projectId)
}

/**
 * Craftsman closes/rejects an inquiry.
 *
 * This builds on the existing declineRequestWorkflow by also marking
 * the linked project as cancelled (if one exists).
 *
 * Effects:
 * - Linked project (if any) set to 'cancelled'
 * - Linked job (if any, still new) removed
 *
 * @returns true if the close was applied
 */
export async function closeCaseWorkflow(
  projectId: string,
  actorUserId?: string
): Promise<boolean> {
  const project = getProjectById(projectId)
  if (!project) return false

  // Already cancelled or completed — idempotent
  if (project.status === 'cancelled' || project.status === 'completed') {
    return true
  }

  // Block close when linked job has secured funds — same escrow-stranding risk.
  // Belt-and-suspenders: checks both payment.state and canonical funding truth.
  if (project.sourceJobId) {
    const linkedJob = getJobById(project.sourceJobId)
    if (linkedJob) {
      const payment = getPaymentForJob(linkedJob.id)
      const fundingConfirmed = isFundingConfirmedForJob(linkedJob.id)
      if (fundingConfirmed || (payment && CANCEL_BLOCKING_PAYMENT_STATES.has(payment.state))) {
        logWarning('workflow.cancel.blocked_by_active_payment', {
          projectId,
          jobId: linkedJob.id,
          paymentState: payment?.state,
          fundingConfirmed,
        })
        return false
      }
    }
  }

  // Set project to cancelled
  await updateProject(projectId, {
    status: 'cancelled',
    updatedAt: Date.now(),
  })

  // Clean up linked job
  if (project.sourceJobId) {
    await terminateLinkedJob(project.sourceJobId)
    // Close the funding path so the now-closed case can no longer be funded.
    await cancelLinkedFundingRequestIfSafe(project.sourceJobId)
  }

  logInfo('workflow.cancel.case_closed', {
    projectId,
    actorUserId,
  })

  recordAnalyticsEvent({
    eventType: 'case_closed',
    entityType: 'project',
    entityId: projectId,
    actorUserId,
  })

  return true
}
