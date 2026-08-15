import type { JobStatus } from '../shared/coreTypes'
import {
  ensureCalendarEntryForJobId,
  getCalendarEntryByJobId,
  updateCalendarStatus,
} from '../calendar'
import {
  ensureInvoiceForJob,
  syncInvoiceWithPayment,
} from '../invoices'
import {
  addJobNote,
  canTransitionJob,
  getJobById,
  linkJobToSourceOffer,
  markProposalSent,
  markProposalAccepted,
  parseJobAmount,
  toggleAssignedMember,
  updateJobProposalFields,
  updateJobStatus,
  updateJobWorkMarkedComplete,
  updateJobWorkConfirmedComplete,
  updateJobWorkMarkedCompleteCleared,
  type Job,
} from '../jobs'
import {
  ensureTimelineEvent,
} from '../timeline'
import {
  ensurePaymentWorkflow,
  getPaymentForJobWorkflow,
  lockEscrowWorkflow,
  markDepositPaidWorkflow,
  releaseEscrowWorkflow,
  releaseTrancheWorkflow,
  requestReleaseWorkflow,
  updatePaymentWorkflow,
} from './paymentWorkflow'
import {
  markExecutionStarted,
  markExecutionCompleted,
} from './schedulingWorkflow'

import { logError, logInfo, logWarning } from '../observability'
import { resolveIssuerData } from './issuerDataHelper'
import {
  sendProposalReceivedEmail,
} from '../notifications/delivery'
import { recordAnalyticsEvent, recordAnalyticsEventOnce } from '../analytics'
import { runWorkCompletedSideEffects } from './hooks/jobHooks'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
  getEscrowTranches,
  ensureEscrowPlan,
  recordWorkStarted,
  recordWorkCompleted,
  initiateFunding,
  confirmFunding,
} from '../payments/escrow'
import {
  ensureFundingRequest,
  getFundingRequestByJobId,
  markFundingRequestSent,
  markFundingStarted as markFundingRequestStarted,
  markFundingCompleted,
} from '../payments/fundingRequest'
import { getOfferById, getAcceptedOfferByJobId } from '../offers/service'
import { getProjectByJobId } from '../projects'
import {
  addAcceptance,
  getAcceptanceByJobId,
  isAcceptanceRepositoryHydrated,
  updateAcceptance,
} from '../acceptance'
import { getPaymentForJob } from '../payments/service'
import { getThreadArtifactRepository } from '../messages/repository/threadArtifactRegistry'
import { updateFundingArtifactPhase } from '../messages/threadArtifactService'
import { generateUUID } from '../shared/generateUUID'
import { formatEuro } from '../payments/selectors'
import type { SessionState } from '../session'
import {
  RbacError,
  assertCustomerRole,
  assertJobCustomer,
  assertJobProviderOwner,
  assertJobWorkerOrOwner,
  getCallerUserId,
  resolveSession,
} from '../auth/rbacGuards'

/** 72 hours in milliseconds — acceptance auto-release deadline. */
const ACCEPTANCE_DEADLINE_MS = 72 * 60 * 60 * 1000

export async function startJobWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)
  // Idempotent: already started
  if (job.status === 'in_progress') return job
  // Guard: work can only start from a scheduled, new, or booked state.
  // Prevents restarting a finished job (waiting_payment → in_progress bypass).
  if (job.status !== 'new' && job.status !== 'scheduled' && job.status !== 'booked') {
    logWarning('workflow.job.invalid_state', { jobId, status: job.status, expectedStatus: 'new|scheduled|booked' })
    return job
  }

  // ── Step 1: Persist work-started signal (CANONICAL) ───────────────────
  // recordWorkStarted MUST succeed before job.status transitions to
  // in_progress.  This eliminates the Split-Brain where UI projection says
  // "eligible" but the server hard-gate rejects "funded" tranches.
  // If the tranche can't transition → job stays in its pre-start state.
  const escrowPlan = getEscrowPlanByJobId(jobId)
  if (escrowPlan) {
    try {
      const releaseResult = await recordWorkStarted(escrowPlan.id, 'provider')
      if ('error' in releaseResult) {
        logWarning('workflow.job.record_work_started_failed', {
          jobId,
          planId: escrowPlan.id,
          planStatus: escrowPlan.status,
          error: releaseResult.error,
        })
        return undefined // Abort: tranche not eligible → don't commit in_progress
      }
    } catch (err: unknown) {
      logError('workflow.job.record_work_started_exception', err, {
        jobId,
        planId: escrowPlan.id,
      })
      return undefined // Abort: persistence failure → don't commit in_progress
    }
  }

  // ── Step 2: Bridge legacy payment state ─────────────────────────────────
  // Stripe webhook advances EscrowPaymentPlan to funded_in_escrow but does
  // NOT advance the legacy Payment state machine.  Bridge it here.
  const _escrowPlanForBridge = getEscrowPlanByJobId(jobId)
  if (_escrowPlanForBridge?.status === 'funded_in_escrow') {
    const _currentPayment = getPaymentForJobWorkflow(jobId)
    if (_currentPayment?.state === 'deposit_required') {
      await markDepositPaidWorkflow(jobId)
      await lockEscrowWorkflow(jobId)
    } else if (_currentPayment?.state === 'deposit_paid') {
      await lockEscrowWorkflow(jobId)
    }
  }

  // ── Step 3: Commit job status (safe — tranche already eligible) ────────
  await updateJobStatus(jobId, 'in_progress')

  const calendarEntry = getCalendarEntryByJobId(jobId)
  if (calendarEntry) {
    updateCalendarStatus(calendarEntry.id, 'in_progress')
  }

  await updatePaymentWorkflow(jobId, 'work_in_progress')

  markExecutionStarted(jobId)

  // ── Step 4: Auto-release deposit tranche (25%) ─────────────────────────
  // recordWorkStarted already succeeded → tranche is eligible_for_release.
  // Trigger server-authoritative release so 25% releases automatically.
  if (escrowPlan) {
    const depositTranche = getEscrowTranches(escrowPlan.id)
      .find((t) => t.kind === 'deposit_release')
    if (depositTranche && (depositTranche.status === 'eligible_for_release' || depositTranche.status === 'release_pending')) {
      const serverResult = await releaseTrancheWorkflow(
        depositTranche.id,
        escrowPlan.id,
        jobId,
        'system',
      )
      if (!serverResult.ok) {
        logWarning('workflow.job.auto_release_deposit_failed', {
          jobId,
          trancheId: depositTranche.id,
          planId: escrowPlan.id,
          message: serverResult.message,
          statusCode: serverResult.statusCode,
        })
      } else {
        logInfo('workflow.job.auto_release_deposit_success', {
          jobId,
          trancheId: depositTranche.id,
          planId: escrowPlan.id,
          idempotent: serverResult.data.idempotent,
        })
      }
    }
    ensureTimelineEvent({
      jobId,
      type: 'tranche_25_eligible',
    })
  }

  ensureTimelineEvent({
    jobId,
    type: 'work_started',
  })

  logInfo('workflow.job.started', { jobId })

  recordAnalyticsEvent({
    eventType: 'job_started',
    entityType: 'job',
    entityId: jobId,
  })

  return getJobById(jobId)
}

export async function finishJobWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)
  // Idempotent: already waiting
  if (job.status === 'waiting_payment') return job
  // Guard: work completion handoff only valid from in_progress.
  // Prevents new/scheduled → waiting_payment bypass skipping execution phase.
  if (job.status !== 'in_progress') return job

  await updateJobStatus(jobId, 'waiting_payment')

  const calendarEntry = getCalendarEntryByJobId(jobId)
  if (calendarEntry) {
    updateCalendarStatus(calendarEntry.id, 'awaiting_payment')
  }

  markExecutionCompleted(jobId)

  const issuerData = await resolveIssuerData(job.craftsmanUserId)
  await ensureInvoiceForJob(job, issuerData)
  await ensurePaymentWorkflow(jobId)
  await syncInvoiceWithPayment(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'invoice_created',
  })

  ensureTimelineEvent({
    jobId,
    type: 'waiting_payment',
  })

  const payment = getPaymentForJobWorkflow(jobId)
  if (payment?.state === 'work_in_progress') {
    await requestReleaseWorkflow(jobId)
  }

  logInfo('workflow.job.waiting_payment', { jobId })

  return getJobById(jobId)
}

export async function setWaitingPaymentWorkflow(jobId: string): Promise<Job | undefined> {
  return finishJobWorkflow(jobId)
}

export async function createInvoiceWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined

  const issuerData = await resolveIssuerData(job.craftsmanUserId)
  await ensureInvoiceForJob(job, issuerData)
  await ensurePaymentWorkflow(jobId)
  await syncInvoiceWithPayment(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'invoice_created',
  })

  return getJobById(jobId)
}

export async function markDepositPaidForJobWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined

  const issuerData = await resolveIssuerData(job.craftsmanUserId)
  await ensureInvoiceForJob(job, issuerData)
  await ensurePaymentWorkflow(jobId)
  await markDepositPaidWorkflow(jobId)
  await syncInvoiceWithPayment(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'deposit_paid',
  })

  return getJobById(jobId)
}

export async function ensureOperationalArtifacts(jobId: string): Promise<void> {
  ensureCalendarEntryForJobId(jobId)

  const job = getJobById(jobId)
  if (job) {
    const issuerData = await resolveIssuerData(job.craftsmanUserId)
    await ensureInvoiceForJob(job, issuerData)
  }

  await ensurePaymentWorkflow(jobId)
  await syncInvoiceWithPayment(jobId)

  const calendarEntry = getCalendarEntryByJobId(jobId)

  if (job) {
    ensureTimelineEvent({
      jobId,
      type: 'job_created',
    })

    recordAnalyticsEvent({
      eventType: 'job_created',
      entityType: 'job',
      entityId: jobId,
    })
  }

  if (calendarEntry) {
    ensureTimelineEvent({
      jobId,
      type: 'scheduled',
    })
  }
}

export async function setJobStatusWorkflow(
  jobId: string,
  nextStatus: JobStatus
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)
  if (job.status === nextStatus) return job

  if (nextStatus === 'in_progress') {
    return startJobWorkflow(jobId)
  }

  if (nextStatus === 'waiting_payment') {
    return finishJobWorkflow(jobId)
  }

  // Guard: 'completed' must flow through the payment release path.
  // A job can only be directly marked completed (outside payment workflow) if
  // it is already in waiting_payment — this prevents skipping payment handoff.
  if (nextStatus === 'completed' && job.status !== 'waiting_payment') {
    logWarning('workflow.job.completed_requires_waiting_payment', {
      jobId,
      currentStatus: job.status,
    })
    return undefined
  }

  // Pre-validate so the UI caller gets a clean undefined instead of a rejected
  // promise from updateJobStatus — this is the dispatching layer, not a
  // critical money path.
  if (!canTransitionJob(job.status, nextStatus)) {
    logWarning('workflow.job.invalid_transition_requested', {
      jobId,
      from: job.status,
      to: nextStatus,
    })
    return undefined
  }

  await updateJobStatus(jobId, nextStatus)

  if (nextStatus === 'completed') {
    ensureTimelineEvent({
      jobId,
      type: 'job_completed',
    })
  }

  return getJobById(jobId)
}

/** @deprecated Owner-Notes sind in `src/lib/owner/ownerNotesWorkflow.ts`. */
export function addJobNoteWorkflow(jobId: string, note: string): void {
  void addJobNote(jobId, note)
}

export function toggleAssignedMemberWorkflow(jobId: string, memberId: string): void {
  void toggleAssignedMember(jobId, memberId)
}

/**
 * Records that the customer has accepted the proposal/offer for the given job.
 *
 * This workflow:
 * 1. Stamps `proposalAcceptedAt` on the job (idempotent — no-op if already accepted)
 * 2. Emits a `proposal_accepted` timeline event
 * 3. Ensures operational artifacts (calendar, invoice, payment) are created so
 *    the project is immediately ready for execution preparation.
 *
 * Only meaningful for jobs that have already had a proposal sent (`proposalSentAt` set).
 */
export async function acceptProposalWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  if (!job.proposalSentAt) return job
  if (job.proposalAcceptedAt) return job

  await markProposalAccepted(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'proposal_accepted',
  })

  recordAnalyticsEvent({
    eventType: 'proposal_accepted',
    entityType: 'job',
    entityId: jobId,
    actorUserId: job.customerUserId,
  })

  // Ensure calendar, invoice, and payment entities exist so the project is
  // ready for scheduling and payment tracking as soon as acceptance is recorded.
  await ensureOperationalArtifacts(jobId)

  return getJobById(jobId)
}

/**
 * Initializes the execution preparation phase for a job whose proposal has
 * been accepted.
 *
 * This workflow:
 * 1. Validates that the proposal has been accepted (`proposalAcceptedAt` is set)
 * 2. Ensures all operational artifacts exist (calendar, invoice, payment)
 * 3. Emits an `execution_ready` timeline event to formally mark the transition
 *    from commercial agreement to execution preparation
 *
 * Idempotent — calling this multiple times is safe; the timeline event and
 * artifacts are only created once.
 *
 * Returns the updated job, or undefined if the job does not exist.
 * Returns the job unchanged if the proposal has not been accepted yet.
 */
export async function initializeExecutionWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  if (!job.proposalAcceptedAt) return job

  await ensureOperationalArtifacts(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'execution_ready',
  })

  return getJobById(jobId)
}

/**
 * Saves a craftsman's proposal draft fields to the job without sending the
 * proposal.
 *
 * Allows the craftsman to iteratively fill in:
 * - `amount`            – the proposed price
 * - `description`       – the scope / work summary
 * - `proposalTimingNote`– scheduling or availability note
 *
 * Only meaningful for jobs in `'new'` status that have not yet had a proposal
 * sent. Idempotent — safe to call multiple times as the craftsman refines the
 * draft.
 */
export async function prepareProposalDraftWorkflow(
  jobId: string,
  draft: { amount?: string; description?: string; proposalTimingNote?: string }
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  if (job.proposalSentAt) return job

  await updateJobProposalFields(jobId, draft)

  return getJobById(jobId)
}

/**
 * Records that a formal proposal/offer has been sent to the customer for the
 * given job.
 *
 * This workflow:
 * 1. Stamps `proposalSentAt` on the job (idempotent — no-op if already sent)
 * 2. Emits a `proposal_sent` timeline event
 *
 * Only meaningful for jobs in `'new'` status.
 */
export async function submitProposalWorkflow(jobId: string): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  if (job.status !== 'new') return job
  // Idempotent: proposal already sent — do not re-send the notification email
  if (job.proposalSentAt) return job

  await markProposalSent(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'proposal_sent',
  })

  recordAnalyticsEvent({
    eventType: 'proposal_sent',
    entityType: 'job',
    entityId: jobId,
    actorUserId: job.craftsmanUserId ?? undefined,
  })

  const sentJob = getJobById(jobId)
  sendProposalReceivedEmail(jobId, sentJob?.customerUserId, { jobTitle: sentJob?.title })

  return sentJob
}

/**
 * Worker (or owner in solo mode) reports the job as finished.
 *
 * Block 7.2.1b — admin-confirm-gate: this workflow no longer triggers any
 * business-side side-effects. It only stamps `workMarkedCompleteAt` and
 * emits a push to the owner. Acceptance, tranche eligibility, status
 * transition and analytics now live in `confirmJobCompletionWorkflow`.
 *
 * Solo-owner shortcut: when the caller is the craftsman owner of the job,
 * the worker-mark is recorded AND immediately confirmed in one step — the
 * UX matches the pre-7.2.1b behaviour for sole proprietors.
 *
 * Idempotent: no-op when `workMarkedCompleteAt` is already set.
 */
export async function markWorkCompleteWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job, session)

  // Guard: work can only be marked complete when actively in_progress.
  // Prevents marking a scheduled or new job as complete before it starts.
  if (job.status !== 'in_progress') return job

  // Idempotent: worker has already marked.
  if (job.workMarkedCompleteAt) return job

  // ── Solo-owner shortcut ────────────────────────────────────────────────
  // When the caller is the craftsman owner of this job (no workers in the
  // loop), record the mark and immediately delegate to the admin-confirm
  // workflow so all side-effects fire as before.
  const resolved = resolveSession(session)
  const callerUserId = resolved.user?.id
  const isSoloOwner =
    resolved.craftsmanRole === 'owner' &&
    !!callerUserId &&
    job.craftsmanUserId === callerUserId

  await updateJobWorkMarkedComplete(jobId)

  if (isSoloOwner) {
    return confirmJobCompletionWorkflow(jobId, session)
  }

  // ── Worker path: notify the owner, no side-effects ─────────────────────
  ensureTimelineEvent({
    jobId,
    type: 'worker_marked_complete',
  })

  logInfo('workflow.job.worker_marked_complete', {
    jobId,
    workerUserId: callerUserId,
    ownerUserId: job.craftsmanUserId,
  })

  return getJobById(jobId)
}

/**
 * Owner confirms the worker's completion report. This is where all the
 * business-side side-effects live now — they used to be in
 * `markWorkCompleteWorkflow` (pre-Block 7.2.1b).
 *
 * Pre-conditions:
 * - Caller must be the craftsman owner of the job (`assertJobProviderOwner`).
 * - `workMarkedCompleteAt` must be set (the worker must have marked first).
 *
 * Idempotent: no-op when `workConfirmedCompleteAt` is already set.
 */
export async function confirmJobCompletionWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobProviderOwner(job, session)

  // Pre-condition: a worker (or solo-owner) must have reported finished first.
  if (!job.workMarkedCompleteAt) return job

  // Idempotent: already confirmed.
  if (job.workConfirmedCompleteAt) return job

  await updateJobWorkConfirmedComplete(jobId)

  // ── Acceptance (Abnahme) — open for customer review ────────────────────
  // Owner-confirm is the domain event that opens the Acceptance.  Payment
  // release reacts to the Acceptance decision; it does not create it.
  //
  // Fail-closed: refuse to proceed when the Acceptance repository has not
  // finished hydrating. An unhydrated cache would silently miss an existing
  // pending Acceptance and create a duplicate.
  if (!isAcceptanceRepositoryHydrated()) {
    const err = new Error(
      `Job confirmation blocked: acceptance repository is not hydrated yet for job ${jobId}. Cannot safely open Acceptance record.`
    )
    logError('workflow.job.acceptance_blocked_unhydrated', err, { jobId })
    throw err
  }
  if (!getAcceptanceByJobId(jobId)) {
    const now = Date.now()
    await addAcceptance({
      id: generateUUID(),
      jobId,
      ...(job.sourceOfferId && { sourceOfferId: job.sourceOfferId }),
      customerUserId: job.customerUserId ?? '',
      status: 'pending',
      expiresAt: now + ACCEPTANCE_DEADLINE_MS,
      createdAt: now,
      updatedAt: now,
    })
  }

  // Trigger escrow final_release tranche eligibility (75% on work completion).
  const escrowPlan = getEscrowPlanByJobId(jobId)
  if (escrowPlan) {
    await recordWorkCompleted(escrowPlan.id, 'provider')
    ensureTimelineEvent({
      jobId,
      type: 'tranche_75_eligible',
    })
  }

  logInfo('workflow.job.admin_confirmed_complete', { jobId })

  await runWorkCompletedSideEffects({ jobId, job })

  recordAnalyticsEventOnce({
    eventType: 'job_completed',
    entityType: 'job',
    entityId: jobId,
    actorUserId: getCallerUserId(session) ?? job.craftsmanUserId ?? undefined,
  })

  // Transition to waiting_payment so payment release can proceed.
  if (job.status === 'in_progress') {
    await finishJobWorkflow(jobId)
  }

  // Customer-facing push: owner confirmed, acceptance window is now open.
  ensureTimelineEvent({
    jobId,
    type: 'admin_confirmed_complete',
  })

  return getJobById(jobId)
}

/**
 * Owner rejects the worker's completion report. Clears
 * `workMarkedCompleteAt` so the worker can mark again after correction.
 *
 * Pre-conditions:
 * - Caller must be the craftsman owner (`assertJobProviderOwner`).
 * - `workMarkedCompleteAt` must be set.
 * - `workConfirmedCompleteAt` must NOT be set — once confirmed, the
 *   Acceptance window is the customer's; the owner cannot rescind.
 *
 * Job status is unchanged (stays `in_progress`).
 */
export async function rejectWorkerCompletionWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobProviderOwner(job, session)

  if (!job.workMarkedCompleteAt) return job
  if (job.workConfirmedCompleteAt) return job

  await updateJobWorkMarkedCompleteCleared(jobId)

  ensureTimelineEvent({
    jobId,
    type: 'admin_rejected_completion',
  })

  logInfo('workflow.job.admin_rejected_completion', {
    jobId,
    actorUserId: getCallerUserId(session),
  })

  return getJobById(jobId)
}

/**
 * Records that the customer has confirmed the completed work and released the
 * payment for the given job.
 *
 * This workflow:
 * 1. Records acceptance (Abnahme) if applicable
 * 2. Delegates to `releaseEscrowWorkflow` which calls the payment provider
 *    (Stripe capture or mock no-op), updates payment state, job status, and
 *    emits `payment_released` + `job_completed` timeline events
 * 3. `releaseEscrowWorkflow` stamps `paymentReleasedAt` gated on full escrow bridge
 *    success; for legacy/mock jobs (no plan) the stamp happens immediately
 *
 * Only meaningful after the owner has confirmed work completion
 * (`workConfirmedCompleteAt` is set — see Block 7.2.1b admin-confirm-gate).
 */
export async function customerReleasePaymentWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<Job | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobCustomer(job, session)
  // Idempotent: already released
  if (job.paymentReleasedAt) return job
  // Guard: work must be admin-confirmed before payment can be released.
  // Worker-only marks (workMarkedCompleteAt set, workConfirmedCompleteAt
  // unset) are intentionally rejected — Block 7.2.1b admin-confirm-gate.
  if (!job.workConfirmedCompleteAt) return job
  // Guard: job must be in waiting_payment to release funds.
  // Prevents releasing payment for a job still in active execution.
  if (job.status !== 'waiting_payment') return job

  logInfo('workflow.job.payment_released', { jobId })

  // ── Acceptance (Abnahme) — customer decision authorizes payment release ──
  // The acceptance decision is recorded BEFORE payment is released.
  // Payment release is the financial consequence of acceptance, not its source.
  //
  // Idempotent paths:
  //   1. Pending Acceptance exists (opened by markWorkCompleteWorkflow) → transition to 'accepted'
  //   2. No Acceptance yet (backward compat: work completed before this flow) → create as 'accepted'
  // Non-fatal in both cases: payment release must not be blocked by Acceptance write failure.
  {
    const existingAcceptance = getAcceptanceByJobId(jobId)
    const payment = getPaymentForJob(jobId)
    const now = Date.now()

    if (existingAcceptance && existingAcceptance.status === 'pending') {
      try {
        await updateAcceptance(existingAcceptance.id, (a) => ({
          ...a,
          ...(payment?.id && { paymentId: payment.id }),
          status: 'accepted' as const,
          acceptedAt: now,
          updatedAt: now,
        }))
      } catch (err) {
        logWarning('workflow.job.acceptance_update_failed', { jobId, error: String(err) })
      }
    } else if (!existingAcceptance) {
      try {
        await addAcceptance({
          id: generateUUID(),
          jobId,
          ...(payment?.id && { paymentId: payment.id }),
          ...(job.sourceOfferId && { sourceOfferId: job.sourceOfferId }),
          customerUserId: job.customerUserId ?? '',
          status: 'accepted',
          acceptedAt: now,
          createdAt: now,
          updatedAt: now,
        })
      } catch (err) {
        logWarning('workflow.job.acceptance_create_failed', { jobId, error: String(err) })
      }
    }
  }

  // Delegate to the escrow workflow which calls the provider (Stripe capture /
  // mock no-op), handles payment state, job status, timeline events, and stamps
  // paymentReleasedAt — gated on full bridge success for escrow-plan jobs.
  // For legacy/mock jobs (no escrow plan) the stamp happens immediately inside
  // releaseEscrowWorkflow. No caller stamp needed; callers bypass the bridge gate.
  await releaseEscrowWorkflow(jobId, undefined, undefined, 'customer')

  // Block 7.2.1e — craftsman-targeted notification distinct from the generic
  // `payment_released` event. Fires only when the customer actively releases
  // (the auto-release path emits `acceptance_auto_released` instead).
  ensureTimelineEvent({ jobId, type: 'acceptance_customer_released' })

  return getJobById(jobId)
}

// ── Funding Request Workflows ─────────────────────────────────────────────

/**
 * Provider sends a funding request / funding step card for a job.
 *
 * This workflow:
 * 1. Validates the job has an accepted quote and escrow plan
 * 2. Creates a funding request (idempotent via escrowPlanId)
 * 3. Marks the funding request as sent
 * 4. Emits a timeline event
 *
 * This operation does NOT require Stripe Connect to be complete.
 * The provider may send the funding step card at any time after the
 * quote is accepted and the escrow plan exists.
 *
 * Idempotent: repeated calls return the existing funding request.
 *
 * @returns The funding request result, or undefined if preconditions not met.
 */
export async function requestFundingWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<{
  fundingRequestId: string
  status: string
  amount: number
} | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobProviderOwner(job, session)

  // Must have an accepted quote — recover sourceOfferId if missing
  let sourceOfferId = job.sourceOfferId
  if (!sourceOfferId) {
    const canonicalOffer = getAcceptedOfferByJobId(jobId)
    if (canonicalOffer) {
      await linkJobToSourceOffer(jobId, canonicalOffer.id)
      sourceOfferId = canonicalOffer.id
    }
  }
  if (!job.proposalAcceptedAt || !sourceOfferId) {
    logWarning('workflow.funding.no_accepted_quote', { jobId })
    return undefined
  }

  // Canonical escrow plan lookup: by jobId first, then by sourceOfferId
  let escrowPlan = getEscrowPlanByJobId(jobId)
    ?? (sourceOfferId ? getEscrowPlanByOfferId(sourceOfferId) : undefined)

  // Recovery: if plan is missing but all canonical data is present, recover once
  if (!escrowPlan) {
    const offer = getOfferById(sourceOfferId)
    const providerId = job.providerId ?? offer?.craftsmanUserId ?? job.craftsmanUserId
    const parsedAmount = parseJobAmount(offer?.price) ?? parseJobAmount(job.amount)

    if (providerId && job.customerUserId && parsedAmount !== null && parsedAmount > 0) {
      escrowPlan = await ensureEscrowPlan({
        sourceOfferId,
        jobId: job.id,
        customerUserId: job.customerUserId,
        providerId,
        totalAmount: parsedAmount,
      })
      logInfo('workflow.funding.escrow_plan_recovered', { jobId, planId: escrowPlan.id })
    } else {
      logWarning('workflow.funding.no_escrow_plan', {
        jobId,
        reason: 'Plan missing and recovery data insufficient',
        hasProvider: Boolean(providerId),
        hasCustomer: Boolean(job.customerUserId),
        hasAmount: parsedAmount !== null && parsedAmount > 0,
      })
      return undefined
    }
  }

  // Get the offer for provider identity
  const offer = getOfferById(sourceOfferId)

  // Resolve the canonical provider ID — required by live schema (UUID FK).
  // Fall back to offer.craftsmanUserId when the DB-resolved providerId is
  // not yet available (e.g. in-memory test environments).
  const resolvedProviderId = job.providerId ?? offer?.craftsmanUserId ?? job.craftsmanUserId
  if (!resolvedProviderId) {
    logWarning('workflow.funding.no_provider_id', { jobId })
    return undefined
  }

  // Idempotent creation via escrowPlanId
  const fundingRequest = await ensureFundingRequest({
    sourceOfferId,
    jobId: job.id,
    escrowPlanId: escrowPlan.id,
    customerUserId: job.customerUserId ?? '',
    providerId: resolvedProviderId,
    providerUserId: offer?.craftsmanUserId ?? job.craftsmanUserId ?? '',
    amount: escrowPlan.totalAmount,
    currency: escrowPlan.currency,
    conversationId: job.sourceConversationId,
  })

  // Mark as sent (idempotent — no-op if already sent or beyond)
  await markFundingRequestSent(fundingRequest.id)

  // Persist funding step card as a thread artifact (idempotent)
  if (job.sourceConversationId) {
    const artifactRepo = getThreadArtifactRepository()
    const existingArtifact = artifactRepo.getByConversationAndType(job.sourceConversationId, 'funding_step')
    if (!existingArtifact) {
      // Resolve canonical customer-facing project ID via reverse lookup
      // (project.sourceJobId → project.id).  This matches the server-side
      // resolution in api/request-funding.ts and avoids persisting a
      // synthetic/conversation-scoped job.projectId that may differ from
      // the real customer-facing project.
      const canonicalProject = getProjectByJobId(job.id)
      if (!canonicalProject) {
        logWarning('workflow.funding.no_canonical_project', {
          jobId: job.id,
          fallbackProjectId: job.projectId,
        })
      }
      const canonicalProjectId = canonicalProject?.id ?? job.projectId
      void artifactRepo.upsert({
        id: generateUUID(),
        conversationId: job.sourceConversationId,
        artifactType: 'funding_step',
        fundingRequestId: fundingRequest.id,
        escrowPlanId: escrowPlan.id,
        jobId: job.id,
        projectId: canonicalProjectId,
        phase: 'sent',
        snapshotPrice: formatEuro(escrowPlan.totalAmount),
        snapshotPhaseLabel: 'Zahlung angefordert',
        snapshotSummary: `Vollständige Zahlung über ${formatEuro(escrowPlan.totalAmount)}`,
        customerUserId: job.customerUserId,
        craftsmanUserId: offer?.craftsmanUserId ?? job.craftsmanUserId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
  }

  ensureTimelineEvent({
    jobId,
    type: 'funding_requested',
  })

  logInfo('workflow.funding.requested', {
    jobId,
    fundingRequestId: fundingRequest.id,
    amount: escrowPlan.totalAmount,
  })

  recordAnalyticsEvent({
    eventType: 'funding_requested',
    entityType: 'funding_request',
    entityId: fundingRequest.id,
    actorUserId: offer?.craftsmanUserId ?? job.craftsmanUserId ?? undefined,
  })

  // Return the current state (re-read in case markFundingRequestSent updated it)
  const current = getFundingRequestByJobId(jobId)
  return current ? {
    fundingRequestId: current.id,
    status: current.status,
    amount: current.amount,
  } : undefined
}

/**
 * Customer enters the funding flow from the funding step card.
 *
 * This workflow:
 * 1. Identifies the funding request for the job
 * 2. Validates it is tied to the escrow plan and accepted quote
 * 3. Marks the funding request as funding_started
 * 4. Initiates escrow funding on the plan
 *
 * The customer should not be routed into a generic detached payment entry.
 * This flow is always tied to the persisted funding request + escrow plan.
 *
 * Idempotent: repeated calls return the existing state.
 *
 * @returns The funding context, or undefined if preconditions not met.
 */
export async function customerFundingEntryWorkflow(
  jobId: string,
  session?: SessionState,
): Promise<{
  fundingRequestId: string
  escrowPlanId: string
  sourceOfferId: string
  jobId: string
  amount: number
  currency: string
  status: string
  customerUserId: string
} | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined

  // Find the funding request for this job
  const fundingRequest = getFundingRequestByJobId(jobId)
  if (!fundingRequest) {
    logWarning('workflow.funding.entry.no_request', { jobId })
    return undefined
  }
  // Caller must be the customer the funding request is addressed to.
  // Compare against fundingRequest first (authoritative for funding flow);
  // fall back to the job customerUserId when the request lacks the field.
  assertCustomerRole(session)
  {
    const callerId = getCallerUserId(session)
    const expected = fundingRequest.customerUserId || job.customerUserId
    if (!expected || !callerId || expected !== callerId) {
      throw new RbacError('rbac_customer', 'Caller is not the customer of this funding request')
    }
  }

  // Validate the escrow plan exists
  const escrowPlan = getEscrowPlanByJobId(jobId)
  if (!escrowPlan) {
    logWarning('workflow.funding.entry.no_escrow_plan', { jobId })
    return undefined
  }

  // Validate linkage to the accepted quote
  if (fundingRequest.sourceOfferId !== escrowPlan.sourceOfferId) {
    logWarning('workflow.funding.entry.offer_mismatch', {
      jobId,
      fundingRequestOfferId: fundingRequest.sourceOfferId,
      escrowPlanOfferId: escrowPlan.sourceOfferId,
    })
    return undefined
  }

  // Mark funding started on the request (idempotent)
  await markFundingRequestStarted(fundingRequest.id)

  // Initiate funding on the escrow plan (idempotent)
  await initiateFunding(escrowPlan.id)

  // Persist funding_started phase on the thread artifact (idempotent)
  if (job.sourceConversationId) {
    try {
      await updateFundingArtifactPhase(job.sourceConversationId, 'funding_started', {
        snapshotPhaseLabel: 'Einzahlung gestartet',
      })
    } catch (err) {
      logError('workflow.funding.artifact_phase_failed', err, { jobId, phase: 'funding_started' })
    }
  }

  logInfo('workflow.funding.entry.started', {
    jobId,
    fundingRequestId: fundingRequest.id,
    escrowPlanId: escrowPlan.id,
    amount: escrowPlan.totalAmount,
  })

  recordAnalyticsEvent({
    eventType: 'funding_entry_started',
    entityType: 'funding_request',
    entityId: fundingRequest.id,
    actorUserId: job.customerUserId ?? undefined,
  })

  return {
    fundingRequestId: fundingRequest.id,
    escrowPlanId: escrowPlan.id,
    sourceOfferId: fundingRequest.sourceOfferId,
    jobId: job.id,
    amount: escrowPlan.totalAmount,
    currency: escrowPlan.currency,
    status: 'funding_started',
    customerUserId: job.customerUserId ?? '',
  }
}

/**
 * Server-side funding confirmation workflow.
 *
 * Called when funding is confirmed through the backend/webhook path.
 * This is the ONLY path that should set funded_in_escrow = true.
 *
 * This workflow:
 * 1. Confirms funding on the escrow plan
 * 2. Marks the funding request as funded
 * 3. Emits a timeline event
 *
 * Idempotent: safe to call multiple times.
 *
 * @returns The confirmation result, or undefined if preconditions not met.
 */
export async function confirmFundingWorkflow(
  jobId: string,
  params?: {
    externalFundingRef?: string
  },
  session?: SessionState,
): Promise<{
  fundingRequestId: string
  escrowPlanId: string
  status: string
} | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobCustomer(job, session)

  const fundingRequest = getFundingRequestByJobId(jobId)
  if (!fundingRequest) {
    logWarning('workflow.funding.confirm.no_request', { jobId })
    return undefined
  }

  const escrowPlan = getEscrowPlanByJobId(jobId)
  if (!escrowPlan) {
    logWarning('workflow.funding.confirm.no_escrow_plan', { jobId })
    return undefined
  }

  // Confirm funding on the escrow plan (idempotent)
  await confirmFunding(escrowPlan.id, {
    externalFundingRef: params?.externalFundingRef,
  })

  // Mark the funding request as funded (idempotent)
  await markFundingCompleted(fundingRequest.id)

  // ── Bridge: advance legacy Payment to match escrow plan truth ────────
  // The escrow funding path (Stripe webhook → confirm-funding API) advances
  // EscrowPlan.status to funded_in_escrow but does NOT advance the legacy
  // Payment state machine. Without this bridge, Payment.state stays at
  // deposit_required, causing PaymentPrepCard to show "ausstehend" while
  // CraftsmanJobOperationsCard correctly shows "Bereit zum Start".
  // Advance Payment through deposit_required → deposit_paid → in_escrow.
  {
    await ensurePaymentWorkflow(jobId)
    const currentPayment = getPaymentForJobWorkflow(jobId)
    if (currentPayment) {
      if (currentPayment.state === 'deposit_required') {
        await markDepositPaidWorkflow(jobId)
        await lockEscrowWorkflow(jobId)
      } else if (currentPayment.state === 'deposit_paid') {
        await lockEscrowWorkflow(jobId)
      }
      // in_escrow or beyond: already consistent — no action needed
    }
  }

  // Persist funded phase on the thread artifact (idempotent)
  if (job.sourceConversationId) {
    try {
      await updateFundingArtifactPhase(job.sourceConversationId, 'funded', {
        snapshotPhaseLabel: 'Zahlung bestätigt',
      })
    } catch (err) {
      logError('workflow.funding.artifact_phase_failed', err, { jobId, phase: 'funded' })
    }
  }

  ensureTimelineEvent({
    jobId,
    type: 'deposit_paid',
  })

  logInfo('workflow.funding.confirmed', {
    jobId,
    fundingRequestId: fundingRequest.id,
    escrowPlanId: escrowPlan.id,
    externalFundingRef: params?.externalFundingRef,
  })

  recordAnalyticsEvent({
    eventType: 'payment_created',
    entityType: 'funding_request',
    entityId: fundingRequest.id,
  })

  return {
    fundingRequestId: fundingRequest.id,
    escrowPlanId: escrowPlan.id,
    status: 'funded_in_escrow',
  }
}
