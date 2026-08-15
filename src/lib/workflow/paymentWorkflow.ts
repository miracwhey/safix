import {
  ensurePaymentForJob,
  getPaymentForJob,
  updatePaymentState,
  updatePaymentAmounts,
  createEscrowPayment,
  confirmDepositPayment,
  releaseEscrowPayment,
  refundEscrowPayment,
  attemptSplitRefundRetry,
  writeSplitRefundLedgerEntry,
  writeSplitPayoutLedgerEntries,
  writeNonSplitDisputePayoutLedgerEntries,
} from '../payments/service'
import { initializeEscrowPlanRepository, getEscrowPlanByJobId, getEscrowTranches, recordWorkStarted, recordWorkCompleted, isTriggerSatisfied, isEscrowPlanRepositoryHydrated } from '../payments/escrow'
import type { ReleaseActor } from '../payments/releaseClient'
import { logWarning, logError, logInfo } from '../observability'
import type { Payment, PaymentState } from '../payments/types'
import { getJobById, updateJobStatus, updateJobPaymentState, updateJobPaymentReleased } from '../jobs'
import { getProjectByJobId, updateProject } from '../projects'
import { syncInvoiceWithPayment } from '../invoices'
import {
  ensureTimelineEvent,
} from '../timeline'
import {
  openDisputeAtomic,
  getDisputeByJobId,
} from '../disputes'
import { buildDisputeContextSnapshot } from '../disputes/disputeContextSnapshot'
import { getDisputeRepository } from '../disputes/repository'
import { isDisputeBlocking } from '../disputes/stateMachine'
import { canTransition } from '../payments/stateMachine'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import {
  sendPaymentReleaseRequestedEmail,
  sendEscrowLockedEmail,
} from '../notifications/delivery'
import { recordAnalyticsEvent } from '../analytics'
import { runPaymentReleasedSideEffects, runPaymentRefundedSideEffects } from './hooks/paymentHooks'
import { requestServerTrancheRelease } from '../payments/releaseClient'
import type { ServerReleaseResult } from '../payments/releaseClient'
import { applyLocalSideEffectsAfterServerRelease } from './releaseOperations'

/**
 * Result of a downstream payment state sync attempt.
 *
 * Captures success/failure for each downstream entity so callers can detect
 * partial-success divergence instead of silently swallowing errors.
 */
export type PaymentSyncResult = {
  jobSynced: boolean
  projectSynced: boolean
  /** True when the job exists but has no linked project (not an error). */
  projectNotFound: boolean
  /** Non-null when the job-level sync failed. */
  jobError?: unknown
  /** Non-null when the project-level sync failed. */
  projectError?: unknown
}

/**
 * Guarded downstream sync: propagates canonical payment state to the linked
 * job and project entities.
 *
 * CONTRACT
 * --------
 * 1. Both updates are attempted regardless of individual failures.
 * 2. Every failure is logged via observability — no silent half-success.
 * 3. The caller receives a structured result and can decide whether to
 *    retry, abort, or surface the issue.
 *
 * This function is the SINGLE path through which payment truth flows into
 * job/project-facing state.  All workflow functions that change canonical
 * payment state MUST call this function and inspect its result.
 */
export async function syncPaymentStateToJobAndProject(
  jobId: string,
  state: PaymentState
): Promise<PaymentSyncResult> {
  const result: PaymentSyncResult = {
    jobSynced: false,
    projectSynced: false,
    projectNotFound: false,
  }

  // --- Job sync ---
  try {
    await updateJobPaymentState(jobId, state)
    result.jobSynced = true
  } catch (err: unknown) {
    result.jobError = err
    logError('workflow.payment_sync.job_update_failed', err, {
      jobId,
      targetState: state,
    })
  }

  // --- Project sync ---
  try {
    const project = getProjectByJobId(jobId)
    if (project) {
      await updateProject(project.id, { paymentState: state })
      result.projectSynced = true
    } else {
      result.projectNotFound = true
      // Only warn when the job itself claims to have a project — that means
      // the link exists but the project entity is missing (data inconsistency).
      const job = getJobById(jobId)
      if (job?.projectId) {
        logWarning('workflow.payment_sync.project_not_found', {
          jobId,
          expectedProjectId: job.projectId,
          targetState: state,
        })
      }
    }
  } catch (err: unknown) {
    result.projectError = err
    logError('workflow.payment_sync.project_update_failed', err, {
      jobId,
      targetState: state,
    })
  }

  // --- Surface any partial-success divergence ---
  // Partial success: job sync failed, OR project sync failed when a project was expected.
  const hasPartialFailure = !result.jobSynced || (!result.projectSynced && !result.projectNotFound)
  if (hasPartialFailure) {
    logWarning('workflow.payment_sync.partial_success', {
      jobId,
      targetState: state,
      jobSynced: result.jobSynced,
      projectSynced: result.projectSynced,
      projectNotFound: result.projectNotFound,
    })
  }

  return result
}

/**
 * Deterministic downstream re-sync guard.
 *
 * Reads the canonical payment truth for a job and ensures the linked job
 * and project entities reflect that truth.  Safe to call idempotently on
 * any read path or recovery flow.
 *
 * Returns the sync result so callers know what (if anything) was corrected.
 * Returns `undefined` when no canonical payment record exists for the job.
 */
export async function reconcilePaymentStateDownstream(
  jobId: string
): Promise<PaymentSyncResult | undefined> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return undefined

  const job = getJobById(jobId)
  const project = getProjectByJobId(jobId)

  const jobStale = job != null && job.paymentState !== payment.state
  const projectStale = project != null && project.paymentState !== payment.state

  if (!jobStale && !projectStale) {
    // Already in sync — nothing to do.
    return {
      jobSynced: true,
      projectSynced: project != null,
      projectNotFound: project == null,
    }
  }

  logInfo('workflow.payment_sync.reconcile_triggered', {
    jobId,
    canonicalState: payment.state,
    jobPaymentState: job?.paymentState,
    projectPaymentState: project?.paymentState,
    jobStale,
    projectStale,
  })

  return await syncPaymentStateToJobAndProject(jobId, payment.state)
}

export function getPaymentForJobWorkflow(
  jobId: string
): Payment | undefined {
  return getPaymentForJob(jobId)
}

export function getPaymentStateForJobWorkflow(
  jobId: string
): PaymentState | undefined {
  return getPaymentForJob(jobId)?.state
}

export async function ensurePaymentWorkflow(jobId: string): Promise<Payment> {
  return ensurePaymentForJob(jobId)
}

export async function updatePaymentWorkflow(
  jobId: string,
  nextState: PaymentState,
  options?: { disputeId?: string }
): Promise<Payment | undefined> {
  await ensurePaymentForJob(jobId)

  const updated = await updatePaymentState(jobId, nextState, options)

  if (!updated) return undefined

  await syncPaymentStateToJobAndProject(jobId, updated.state)
  await syncInvoiceWithPayment(jobId)

  return getPaymentForJob(jobId)
}

export async function markDepositPaidWorkflow(jobId: string): Promise<Payment | undefined> {
  return updatePaymentWorkflow(jobId, 'deposit_paid')
}

export async function lockEscrowWorkflow(jobId: string): Promise<Payment | undefined> {
  // Idempotent guard — `updatePaymentWorkflow` returns the existing payment
  // row unchanged when the state matches, but without checking here we
  // would still fire a duplicate email on every re-entry.
  const current = getPaymentForJobWorkflow(jobId)
  const alreadyLocked = current?.state === 'in_escrow'

  const updated = await updatePaymentWorkflow(jobId, 'in_escrow')

  if (updated && !alreadyLocked) {
    ensureTimelineEvent({
      jobId,
      type: 'escrow_locked',
    })

    const job = getJobById(jobId)
    if (job) {
      if (job.customerUserId) {
        sendEscrowLockedEmail(jobId, job.customerUserId, 'customer', { jobTitle: job.title })
      }
      // `if(job.craftsmanUserId)` guards undefined auth-id hydration
      // (jobTruthContract) — no email dispatch when the provider has
      // no linked auth user yet.
      if (job.craftsmanUserId) {
        sendEscrowLockedEmail(jobId, job.craftsmanUserId, 'craftsman', { jobTitle: job.title })
      }
    }
  }

  return updated
}

export async function requestReleaseWorkflow(jobId: string): Promise<Payment | undefined> {
  // Idempotent guard: if payment is already in release_pending, return early to
  // prevent duplicate timeline events and notification emails. updatePaymentState
  // returns the existing payment unchanged when state matches, so without this
  // guard the email would be sent on every repeated call.
  const current = getPaymentForJobWorkflow(jobId)
  if (current?.state === 'release_pending') return current

  const updated = await updatePaymentWorkflow(jobId, 'release_pending')

  if (updated) {
    ensureTimelineEvent({
      jobId,
      type: 'release_requested',
    })

    const job = getJobById(jobId)
    // release_requested notification fans out to both parties:
    // - customer: „Freigabe erforderlich" — primary action
    // - craftsman: Bestätigung, dass der Freigabe-Request gestellt ist
    // Ids are passed via optional chaining so an absent user degrades
    // to a no-op inside the email helper (contract enforced by
    // jobTruthContract regex scan of this file).
    await sendPaymentReleaseRequestedEmail(
      jobId, job?.customerUserId, { jobTitle: job?.title, recipientRole: 'customer' },
    )
    await sendPaymentReleaseRequestedEmail(
      jobId, job?.craftsmanUserId, { jobTitle: job?.title, recipientRole: 'craftsman' },
    )
  }

  return updated
}

export async function disputePaymentWorkflow(jobId: string, raisedByUserId?: string): Promise<Payment | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined

  const payment = getPaymentForJob(jobId)

  // This workflow is payment-specific — a payment must exist and its current
  // state must allow the transition to 'disputed'. Payments in early states
  // (deposit_required, deposit_paid) cannot be disputed since escrow has not
  // been funded yet.
  if (!payment || !canTransition(payment.state, 'disputed')) {
    return undefined
  }

  // Build context snapshot BEFORE the payment state is transitioned to 'disputed'.
  // Must mirror the same standard as openDisputeWorkflow (Sub-block 6.1).
  const contextSnapshot = buildDisputeContextSnapshot(jobId)

  // Create the dispute atomically via RPC:
  //   INSERT dispute + UPDATE payment.status='disputed' + UPDATE job.dispute_status='open'
  // This eliminates the race window between dispute creation and payment state lock.
  const dispute = await openDisputeAtomic({
    jobId,
    reason: 'payment_conflict',
    title: 'Konflikt im Zahlungsfluss',
    description:
      'Der Zahlungsfall wurde von einer Seite in Klärung gesetzt und wartet auf Entscheidung.',
    raisedBy: raisedByUserId,
    contextSnapshot,
    paymentId: payment.id,
  })

  // Sync local in-memory caches (RPC already committed to DB; these are idempotent)
  const updated = await updatePaymentWorkflow(jobId, 'disputed', { disputeId: dispute.id })

  if (updated) {
    ensureTimelineEvent({
      jobId,
      type: 'dispute_opened',
    })
  }

  return updated
}

export async function createEscrowWorkflow(
  jobId: string,
  customerProviderRef: string,
  amount?: number
): Promise<Payment> {
  const payment = await createEscrowPayment(jobId, amount ?? 2000, customerProviderRef)

  await syncPaymentStateToJobAndProject(jobId, payment.state)
  await syncInvoiceWithPayment(jobId)

  recordAnalyticsEvent({
    eventType: 'payment_created',
    entityType: 'payment',
    entityId: jobId,
  })

  return payment
}

export async function confirmDepositWorkflow(
  jobId: string
): Promise<Payment | undefined> {
  const updated = await confirmDepositPayment(jobId)
  if (!updated) return undefined

  await syncPaymentStateToJobAndProject(jobId, updated.state)
  ensureTimelineEvent({
    jobId,
    type: 'deposit_paid',
  })

  await syncInvoiceWithPayment(jobId)

  return updated
}

/**
 * Tranche statuses that require no further money movement for a release:
 * 'released' — funds already at the provider; 'refunded'/'cancelled' — funds
 * returned/never moved. Everything else (funded, eligible_for_release,
 * release_pending, disputed, blocked, locked, pending_funding) still holds or
 * moves money and must not count as settled by the corridor bridge.
 */
const TERMINAL_TRANCHE_STATUSES: ReadonlySet<string> = new Set(['released', 'refunded', 'cancelled'])

export async function releaseEscrowWorkflow(
  jobId: string,
  disputeId?: string,
  splitRatio?: number,
  actor: ReleaseActor = 'system'
): Promise<{ payment: Payment | undefined; bridgeFullySucceeded: boolean; refundFullySucceeded: boolean }> {
  const job = getJobById(jobId)

  // Guard: payment state must allow the 'released' transition before we proceed.
  // This check happens BEFORE the dispute guard and BEFORE any Stripe call so
  // we fail-fast without touching external systems when the state is illegal.
  const paymentPreFlight = getPaymentForJob(jobId)

  // Retry path: payment already 'released' means a prior attempt completed the
  // Stripe capture but failed on bridge/completion publication (e.g. unhydrated
  // escrow cache, tranche transfer error, or sync failure).
  // canTransition('released','released') is false, so without this check the
  // early return would fire — stranding the job in waiting_payment with captured
  // funds and no side effects.  Skip the capture and continue from bridge.
  const isPaymentAlreadyReleased = paymentPreFlight?.state === 'released'

  // True second call: payment released AND stamp written → all side effects already ran.
  // Genuine retry has payment released but paymentReleasedAt not yet set (crash window).
  if (isPaymentAlreadyReleased && job?.paymentReleasedAt) {
    return { payment: undefined, bridgeFullySucceeded: true, refundFullySucceeded: true }
  }

  if (!paymentPreFlight || (!isPaymentAlreadyReleased && !canTransition(paymentPreFlight.state, 'released'))) {
    logWarning('workflow.payment.release_rejected_invalid_payment_state', {
      jobId,
      paymentState: paymentPreFlight?.state ?? 'not_found',
    })
    return { payment: undefined, bridgeFullySucceeded: true, refundFullySucceeded: true }
  }

  // Guard: block release if there is an open dispute for this job.
  // The disputeId bypass is only reached from resolveDisputeReleaseWorkflow /
  // rejectDisputeWorkflow in disputeWorkflow.ts, which validate the dispute
  // state machine (canTransitionDispute) before calling this function and pass
  // a real dispute.id sourced from getDisputeByJobId. Passing a fabricated
  // disputeId from elsewhere would bypass the guard but not forge a valid
  // dispute record — the money leg (tranche bridge / releaseEscrowPayment)
  // still requires a real payment entity.
  if (!disputeId) {
    // Safety: refuse to evaluate dispute state when the dispute repository has
    // not finished hydrating — an empty cache would incorrectly look like
    // "no dispute exists" and allow a release that should be blocked.
    if (!getDisputeRepository().isHydrated()) {
      const err = new Error(
        `Release blocked: dispute repository is not hydrated yet for job ${jobId}. Cannot safely determine dispute state.`
      )
      logError('workflow.payment.release_blocked_unhydrated_disputes', err, { jobId })
      throw err
    }
    const existingDispute = getDisputeByJobId(jobId)
    if (existingDispute && isDisputeBlocking(existingDispute.status)) {
      const err = new Error(
        `Release blocked: open dispute exists for job ${jobId} (dispute ${existingDispute.id}, status '${existingDispute.status}'). Resolve the dispute first.`
      )
      logError('workflow.payment.release_blocked_by_dispute', err, {
        jobId,
        disputeId: existingDispute.id,
        disputeStatus: existingDispute.status,
      })
      throw err
    }
  }

  // Guard: non-dispute release requires job to be in waiting_payment.
  // Skip on retry (isPaymentAlreadyReleased): a prior attempt already advanced the
  // job past waiting_payment and the retry only needs to finish the bridge/stamp.
  if (!isPaymentAlreadyReleased && !disputeId && job && job.status !== 'waiting_payment') {
    logWarning('workflow.payment.release_rejected_invalid_status', {
      jobId,
      jobStatus: job.status,
      expected: 'waiting_payment',
    })
    return { payment: undefined, bridgeFullySucceeded: true, refundFullySucceeded: true }
  }

  // refundFullySucceeded tracks whether the customer partial refund (split disputes)
  // was confirmed.  Non-split releases have no refund step, so default is true.
  let refundFullySucceeded = true

  // ── Money-leg routing: tranche corridor vs. legacy capture (C1) ────────────
  // Jobs with an escrow plan are funded via an auto-captured funding
  // PaymentIntent (initiate-funding) — there is nothing left to capture at
  // release time. Their money movement runs EXCLUSIVELY through the server
  // tranche bridge below (api/release-tranche.ts), exactly like
  // releaseTrancheWorkflow. Calling releaseEscrowPayment for them would throw
  // (corridor payments carry no providerRef) or hit the retired
  // /api/capture-escrow endpoint (410).
  // Fail-closed: when the escrow repo has not hydrated we cannot distinguish
  // corridor from legacy — skip the capture; the bridge block below defers via
  // release_stamp_deferred_unhydrated and the call stays retryable.
  const escrowRepoHydrated = isEscrowPlanRepositoryHydrated()
  const escrowPlanForJob = escrowRepoHydrated ? getEscrowPlanByJobId(jobId) : undefined
  const usesTrancheCorridor = !escrowRepoHydrated || escrowPlanForJob != null

  // On bridge-retry the payment is already 'released'; skip the Stripe capture.
  // For split disputes, the original refund may not have completed — retry it so
  // the outcome is known before settlement is attempted.
  let updated: Payment | undefined
  if (isPaymentAlreadyReleased) {
    // Skip Stripe capture — funds already captured on a prior attempt.
    updated = paymentPreFlight
    if (splitRatio !== undefined && disputeId) {
      // Dispute split retry: idempotent refund via server key `refund_{pi}_{cents}`.
      // Stripe returns the cached outcome instead of issuing a second refund.
      refundFullySucceeded = await attemptSplitRefundRetry(jobId, {
        splitRatio,
        disputeId,
        fundingRef: escrowPlanForJob?.externalFundingRef,
      })
      if (!refundFullySucceeded) {
        return { payment: updated, bridgeFullySucceeded: false, refundFullySucceeded: false }
      }
      // Refund confirmed (either newly or via idempotency) — write ledger entry.
      // Idempotency guard in createLedgerEntry suppresses a duplicate if the
      // initial attempt already wrote it.
      writeSplitRefundLedgerEntry(updated, jobId, disputeId, splitRatio)
    }
  } else if (usesTrancheCorridor) {
    // Corridor: skip the legacy capture — the funding PI is already captured.
    // The canonical payment stays in its pre-release state until the bridge
    // confirms every tranche synchronously; under PAYOUT_MODE (async payout)
    // the payout.paid webhook performs the authoritative settlement
    // server-side instead.
    updated = paymentPreFlight
    if (splitRatio !== undefined && disputeId) {
      // Split refund leg (customer share) still runs FIRST — fail-closed
      // ordering: no payout signal fires unless the refund is confirmed
      // (gate below). Idempotent via the server refund key; corridor payments
      // carry no providerRef, so the plan's funding PI is passed explicitly.
      refundFullySucceeded = await attemptSplitRefundRetry(jobId, {
        splitRatio,
        disputeId,
        fundingRef: escrowPlanForJob?.externalFundingRef,
      })
      if (refundFullySucceeded) {
        writeSplitRefundLedgerEntry(updated, jobId, disputeId, splitRatio)
      }
    }
  } else {
    // Legacy/mock (no escrow plan): the provider capture IS the complete
    // release.
    const releaseResult = await releaseEscrowPayment(jobId, { disputeId, splitRatio })
    updated = releaseResult?.payment
    if (splitRatio !== undefined && releaseResult) {
      refundFullySucceeded = releaseResult.splitRefundSucceeded
      // Write refund ledger immediately after confirmed refund (before bridge).
      // Payout entries are deferred until bridge succeeds.
      if (refundFullySucceeded && updated && disputeId) {
        writeSplitRefundLedgerEntry(updated, jobId, disputeId, splitRatio)
      }
    }
  }

  // Declared before sync so the retry-path sync failure can set it immediately.
  // Stays true when payment not found (bridge never ran) or no escrow plan (legacy).
  let bridgeFullySucceeded = true

  // Non-dispute: mirror sync runs immediately after the terminal money event —
  // legacy capture (updated.state already 'released') or corridor retry.
  // Corridor first-pass payments are still in their pre-release state here; their
  // sync runs after the bridge-confirmed finalize below.
  // Dispute: sync is deferred until bridgeFullySucceeded — prevents publishing 'released'
  // onto job/project while settlement is still pending.
  if (updated && !disputeId && updated.state === 'released') {
    const syncResult = await syncPaymentStateToJobAndProject(jobId, updated.state)
    if (!syncResult.jobSynced || (!syncResult.projectSynced && !syncResult.projectNotFound)) {
      logError('workflow.payment_sync.terminal_divergence', undefined, {
        jobId,
        paymentState: updated.state,
        operation: 'release',
        jobSynced: syncResult.jobSynced,
        projectSynced: syncResult.projectSynced,
        projectNotFound: syncResult.projectNotFound,
      })
    }
  }

  if (updated && job) {
    // Re-read fresh state to eliminate TOCTOU between the snapshot captured
    // above (before the irreversible releaseEscrowPayment call) and the actual
    // store state at transition time.
    const freshJob = getJobById(jobId) ?? job
    // paymentReleasedAt is stamped only after bridge fully succeeds and is the
    // authoritative idempotency marker for release side effects. Using job.status
    // is unreliable: a prior attempt may have advanced job to 'completed' before
    // failing on bridge/stamp/hook, leaving side effects undelivered.
    const paymentWasAlreadyReleased = !!freshJob.paymentReleasedAt

    // Intermediate state-machine step for dispute paths: in_progress → waiting_payment
    // → completed. (in_progress → completed is not a valid direct transition.)
    if (disputeId && freshJob.status !== 'waiting_payment' && freshJob.status !== 'completed') {
      await updateJobStatus(jobId, 'waiting_payment')
    }

    // ── Bridge: release eligible escrow tranches via server ─────────────────
    // Fail-closed: customer refund must be confirmed before any payout signals fire.
    // For non-split releases refundFullySucceeded is always true (no-op guard).
    if (!refundFullySucceeded) {
      bridgeFullySucceeded = false
    } else {
      // Bridge trigger evaluation uses 'completed' as the target status directly —
      // the job is not advanced before the bridge confirms, so selectors and the
      // craftsman release CTA never see a completed job while settlement is pending.
      {
        if (!isEscrowPlanRepositoryHydrated()) {
          // Cannot safely distinguish "no plan" from "cache empty": fail closed.
          // Reconciliation cron will stamp when the Transfer confirms.
          logWarning('workflow.payment.release_stamp_deferred_unhydrated', { jobId, actor })
          bridgeFullySucceeded = false
        } else {
          const escrowPlan = getEscrowPlanByJobId(jobId)
          if (escrowPlan) {
            const tranches = getEscrowTranches(escrowPlan.id)
            const eligibleTranches = tranches.filter((t) =>
              t.status === 'eligible_for_release' || isTriggerSatisfied(t, 'completed')
            )

            // Corridor completeness guard: money for this release moves ONLY via
            // the bridge (no prior capture). Any tranche that is neither
            // terminally settled ('released'/'refunded'/'cancelled') nor
            // bridgeable in this pass — e.g. 'release_pending' with a payout
            // still in flight from a prior attempt, or 'disputed'/'blocked' —
            // means the release is NOT complete. Fail closed so settlement and
            // the paymentReleasedAt stamp stay deferred; the payout.paid webhook
            // or a retry finishes the job. Without this, an empty eligible set
            // would count as vacuous bridge success and settle a dispute with
            // zero money movement.
            if (usesTrancheCorridor) {
              const eligibleIds = new Set(eligibleTranches.map((t) => t.id))
              const unbridgeable = tranches.filter(
                (t) => !TERMINAL_TRANCHE_STATUSES.has(t.status) && !eligibleIds.has(t.id)
              )
              if (unbridgeable.length > 0) {
                logWarning('workflow.payment.release_corridor_tranches_unsettled', {
                  jobId,
                  planId: escrowPlan.id,
                  actor,
                  unsettled: unbridgeable.map((t) => ({ trancheId: t.id, status: t.status })),
                  ...(disputeId !== undefined ? { disputeId } : {}),
                })
                bridgeFullySucceeded = false
              }
            }

            for (const tranche of eligibleTranches) {
              const result = await requestServerTrancheRelease(
                tranche.id, escrowPlan.id, actor, undefined, splitRatio,
              )
              // SPLIT_PROVIDER_QUOTA_EXHAUSTED: a later split resolution awards the
              // provider LESS than prior releases already paid out. The server
              // (release-tranche.ts) refused further movement with a 409. Unlike a
              // transient bridge failure this is NOT retryable — the provider has been
              // over-paid and needs a MANUAL Stripe transfer reversal
              // (transfer_reversal_ref model). Escalate to Sentry with
              // operator_action_required so it cannot be missed; the dispute stays
              // settlementStatus='pending' (bridgeFullySucceeded=false) until the
              // reversal is reconciled.
              if (!result.ok && result.code === 'SPLIT_PROVIDER_QUOTA_EXHAUSTED') {
                logError('workflow.dispute.split_provider_overpay_reversal_required', undefined, {
                  jobId,
                  trancheId: tranche.id,
                  planId: escrowPlan.id,
                  trancheKind: tranche.kind,
                  actor,
                  disputeId,
                  ...(splitRatio !== undefined ? { splitRatio } : {}),
                  errorCode: 'SPLIT_PROVIDER_QUOTA_EXHAUSTED',
                  severity: 'operator_action_required',
                  remediation: 'manual_stripe_transfer_reversal',
                })
                bridgeFullySucceeded = false
                continue
              }
              // A tranche is only SETTLED when the server confirms a synchronous
              // 'released'. Not settled when: server error; Stripe moved but the
              // Supabase write failed (requiresReconciliation); OR the corridor
              // payout is still async-pending (release_pending/release_deferred —
              // the money lands later via the payout.paid webhook, which performs
              // the authoritative settlement on fully_released). In all three the
              // local 'released' side effects (job completion, paymentReleasedAt,
              // "freigegeben"-notifications) must NOT run yet, so the dispute
              // mirror sync + completion below are deferred.
              const trancheSettled =
                result.ok &&
                result.data.status === 'released' &&
                !result.data.requiresReconciliation
              if (!trancheSettled) {
                logWarning('workflow.payment.escrow_bridge_tranche_not_settled', {
                  jobId,
                  trancheId: tranche.id,
                  planId: escrowPlan.id,
                  trancheKind: tranche.kind,
                  actor,
                  reason: !result.ok
                    ? result.message
                    : result.data.requiresReconciliation
                      ? 'requiresReconciliation: Stripe move pending Supabase write'
                      : `corridor payout pending (${result.data.status})`,
                  ...(splitRatio !== undefined ? { splitRatio } : {}),
                })
                bridgeFullySucceeded = false
              }
            }

            if (eligibleTranches.length > 0) {
              await initializeEscrowPlanRepository()
            }
          }
          // No escrow plan (legacy/mock): releaseEscrowPayment is the complete release →
          // bridgeFullySucceeded stays true → stamp immediately.
        }
      }

      // ── Corridor: finalize canonical payment state after confirmed bridge ──
      // Legacy jobs flip payments → 'released' inside releaseEscrowPayment (the
      // capture IS the money movement). Corridor jobs skip the capture, so the
      // canonical flip happens here — only once EVERY tranche settled
      // synchronously ('released', flag-OFF transfer corridor). Under
      // PAYOUT_MODE the bridge reports release_pending → bridgeFullySucceeded
      // is false → no flip: the payout.paid webhook performs the authoritative
      // settlement (payments → released, job completion, dispute settle)
      // server-side. Mirrors releaseTrancheWorkflow →
      // applyLocalSideEffectsAfterServerRelease (updatePaymentState on
      // planFullyReleased); the ledger writes inside updatePaymentState are
      // idempotent (createLedgerEntry non-repeating guard).
      if (usesTrancheCorridor && bridgeFullySucceeded && updated.state !== 'released') {
        try {
          const finalized = await updatePaymentState(jobId, 'released', { disputeId, splitRatio })
          if (finalized) {
            updated = finalized
            if (!disputeId) {
              const syncResult = await syncPaymentStateToJobAndProject(jobId, updated.state)
              if (!syncResult.jobSynced || (!syncResult.projectSynced && !syncResult.projectNotFound)) {
                logError('workflow.payment_sync.terminal_divergence', undefined, {
                  jobId,
                  paymentState: updated.state,
                  operation: 'release',
                  jobSynced: syncResult.jobSynced,
                  projectSynced: syncResult.projectSynced,
                  projectNotFound: syncResult.projectNotFound,
                })
              }
            }
          }
        } catch (finalizeErr: unknown) {
          // Tranche transfers succeeded but the canonical DB flip failed.
          // Fail-closed: settlement + stamp stay deferred. On retry every
          // tranche reads terminal ('released'), the bridge is a no-op and
          // ONLY this flip is re-attempted.
          logError(
            'workflow.payment.release_corridor_finalize_failed',
            finalizeErr instanceof Error ? finalizeErr : undefined,
            {
              jobId,
              actor,
              ...(disputeId !== undefined ? { disputeId } : {}),
              action: 'RETRY_OR_MANUAL_STATE_UPDATE_REQUIRED',
            }
          )
          bridgeFullySucceeded = false
        }
      }

      // Dispute mirror sync: all money movements confirmed, safe to publish 'released'.
      // Runs here (after bridge) rather than at the top so selectors never see a
      // completed job while dispute settlement is still in-flight.
      if (bridgeFullySucceeded && disputeId) {
        const syncResult = await syncPaymentStateToJobAndProject(jobId, updated.state)
        if (!syncResult.jobSynced || (!syncResult.projectSynced && !syncResult.projectNotFound)) {
          logError('workflow.payment_sync.terminal_divergence', undefined, {
            jobId,
            paymentState: updated.state,
            operation: 'release',
            jobSynced: syncResult.jobSynced,
            projectSynced: syncResult.projectSynced,
            projectNotFound: syncResult.projectNotFound,
          })
          bridgeFullySucceeded = false
        }
      }

      // Split payout ledger: write only after bridge confirms actual tranche transfer.
      // Completion signals fire only after all money movements are confirmed.
      // — Idempotent: updateJobStatus no-ops when already 'completed'.
      // — paymentReleasedAt semantics: this stamp is set AFTER runPaymentReleasedSideEffects
      //   completes. Its presence therefore means: job is completed AND all release side
      //   effects (timeline, invoice, analytics, counter, email) have run. On retry,
      //   paymentWasAlreadyReleased=true (stamp already set) → side effects are safely
      //   skipped. paymentWasAlreadyReleased=false (stamp missing) → effects run, then
      //   stamp is set. Residual risk: crash between effect completion and stamp write
      //   causes a double-run on the next retry (safe — ensureTimelineEvent is idempotent,
      //   analytics/email may fire twice in this rare window).
      if (bridgeFullySucceeded) {
        await updateJobStatus(jobId, 'completed')
        if (!paymentWasAlreadyReleased) {
          await runPaymentReleasedSideEffects({ jobId, job: freshJob })
          await updateJobPaymentReleased(jobId, actor)
        }
      } else {
        logError('workflow.payment.release_stamp_deferred', undefined, {
          jobId,
          actor,
          reason: 'escrow_bridge_partial_failure — paymentReleasedAt deferred to reconciliation',
        })
      }
    }
  }

  // Corridor jobs move money exclusively via the tranche bridge, which requires
  // the job entity. If the job is missing from the cache the bridge never ran —
  // never report success, otherwise a dispute resolution would settle and write
  // payout ledger entries without any money movement.
  if (usesTrancheCorridor && updated && !job) {
    logError('workflow.payment.release_corridor_bridge_unreachable', undefined, {
      jobId,
      ...(disputeId !== undefined ? { disputeId } : {}),
    })
    bridgeFullySucceeded = false
  }

  // Dispute payout ledger: outside the `if (updated && job)` guard so dispute-only
  // scenarios (payment + dispute seeded, no job in cache) still write entries —
  // legacy only; corridor without a job is forced to bridge-failure above.
  // bridgeFullySucceeded=true when no job exists (bridge block never ran).
  if (updated && bridgeFullySucceeded && disputeId) {
    if (splitRatio !== undefined) {
      writeSplitPayoutLedgerEntries(updated, jobId, disputeId, splitRatio)
    } else {
      writeNonSplitDisputePayoutLedgerEntries(updated, jobId, disputeId)
    }
  }

  return { payment: updated, bridgeFullySucceeded, refundFullySucceeded }
}

export async function refundEscrowWorkflow(
  jobId: string,
  disputeId?: string
): Promise<Payment | undefined> {
  const job = getJobById(jobId)

  // Guard: payment state must allow the 'refunded' transition before we proceed.
  const paymentPreFlight = getPaymentForJob(jobId)
  // Idempotent retry: if the payment is already 'refunded', Stripe and the DB
  // commit both succeeded on a prior attempt. Skip the provider call but still
  // re-run downstream side effects (job status, timeline, invoices) in case
  // they failed before completing the first time.
  const isAlreadyRefunded = paymentPreFlight?.state === 'refunded'

  // True second call: payment refunded AND job completed → all done.
  // Genuine retry has payment refunded but job not yet completed.
  if (isAlreadyRefunded && job?.status === 'completed') {
    return undefined
  }

  if (!paymentPreFlight || (!isAlreadyRefunded && !canTransition(paymentPreFlight.state, 'refunded'))) {
    logWarning('workflow.payment.refund_rejected_invalid_payment_state', {
      jobId,
      paymentState: paymentPreFlight?.state ?? 'not_found',
    })
    return undefined
  }

  // Guard: non-dispute refund requires job to be in waiting_payment.
  // The disputeId bypass is only reached from resolveDisputeRefundWorkflow in
  // disputeWorkflow.ts, which validates the dispute state machine before calling
  // this function and passes a real dispute.id sourced from getDisputeByJobId.
  // Downstream refundEscrowPayment still requires a real payment entity, so a
  // fabricated disputeId cannot forge a successful refund.
  if (!disputeId) {
    // Safety: refuse to evaluate dispute state when the dispute repository has
    // not finished hydrating — an empty cache would incorrectly look like
    // "no dispute exists" and allow a refund that should be blocked.
    if (!getDisputeRepository().isHydrated()) {
      const err = new Error(
        `Refund blocked: dispute repository is not hydrated yet for job ${jobId}. Cannot safely determine dispute state.`
      )
      logError('workflow.payment.refund_blocked_unhydrated_disputes', err, { jobId })
      throw err
    }
  }
  // Skip on retry (isAlreadyRefunded): a prior attempt already advanced the job
  // and the retry only needs to repair downstream mirrors/side effects.
  if (!isAlreadyRefunded && !disputeId && job && job.status !== 'waiting_payment') {
    logWarning('workflow.payment.refund_rejected_invalid_status', {
      jobId,
      jobStatus: job.status,
      expected: 'waiting_payment',
    })
    return undefined
  }

  const updated = isAlreadyRefunded
    ? paymentPreFlight
    : await refundEscrowPayment(jobId, undefined, { disputeId })

  if (updated) {
    const syncResult = await syncPaymentStateToJobAndProject(jobId, updated.state)
    // Refund is a terminal money-movement event: Stripe has either cancelled the
    // authorisation hold or issued a refund. A sync failure here leaves job/project
    // showing stale payment state. Alert at error level — do NOT throw, the Stripe
    // operation already succeeded and cannot be rolled back.
    if (!syncResult.jobSynced || (!syncResult.projectSynced && !syncResult.projectNotFound)) {
      logError('workflow.payment_sync.terminal_divergence', undefined, {
        jobId,
        paymentState: updated.state,
        operation: 'refund',
        jobSynced: syncResult.jobSynced,
        projectSynced: syncResult.projectSynced,
        projectNotFound: syncResult.projectNotFound,
      })
    }
  }

  if (updated && job) {
    // Re-read fresh state to eliminate TOCTOU (same pattern as releaseEscrowWorkflow).
    // The stale snapshot was captured before refundEscrowPayment ran; any concurrent
    // job mutation between the read and the transition writes would produce illegal
    // transitions.  Fresh read collapses the window to effectively zero.
    const freshJob = getJobById(jobId) ?? job

    // JobStatus has no 'cancelled' or 'refunded' terminal state — 'completed'
    // is the single terminal status for all closed jobs. The payment state
    // ('refunded' vs 'released') carries the outcome semantics. UI surfaces
    // (e.g. JobCompletionSummaryCard) read payment.state to distinguish the
    // refund path from the full-payment path.
    //
    // Dispute-resolved paths may reach here while job is still in_progress.
    // Step through waiting_payment to satisfy the job state machine.
    if (disputeId && freshJob.status !== 'waiting_payment' && freshJob.status !== 'completed') {
      await updateJobStatus(jobId, 'waiting_payment')
    }
    await updateJobStatus(jobId, 'completed')
    // Side effects guarded against already-refunded retries: a retry that reaches
    // here only needs to repair job/project mirrors (done above). Analytics and
    // timeline have already been written on the first completed attempt.
    if (!isAlreadyRefunded) {
      await runPaymentRefundedSideEffects({ jobId, job: freshJob })
    }
  }

  return updated
}

/**
 * Initializes the deposit/payment card for a job whose proposal has been
 * accepted.
 *
 * This workflow:
 * 1. Validates that the proposal has been accepted.
 * 2. Resolves the agreed amount using the canonical hierarchy
 *    (escrow plan → accepted offer → job.amount fallback).
 * 3. Creates or updates the payment record so that its total matches the
 *    agreed amount (deposit = 25 %, final = 75 %).
 * 4. Syncs the invoice with the updated payment amounts.
 *
 * Idempotent — calling this multiple times is safe. If the payment amounts
 * already match the agreed amount, no mutation occurs.
 *
 * Returns the payment, or undefined if the job does not exist, has no accepted
 * proposal, or has no parseable amount.
 */
export async function prepareDepositCardWorkflow(jobId: string): Promise<Payment | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined
  if (!job.proposalAcceptedAt) return undefined

  // Use the canonical amount resolver (escrow → offer → job.amount) so this
  // workflow works correctly after reload when job.amount is empty but the
  // offer entity (with the persisted price) is available.
  const canonical = resolveCanonicalAmount(jobId)
  const agreedAmount = canonical.amount
  if (!agreedAmount) return undefined

  const payment = await updatePaymentAmounts(jobId, agreedAmount)

  await syncPaymentStateToJobAndProject(jobId, payment.state)
  await syncInvoiceWithPayment(jobId)

  return payment
}

/**
 * UI-orchestrated tranche release workflow.
 *
 * This is the canonical entry point for UI-triggered tranche releases.
 * It ensures that Path A (server-authoritative release) produces the same
 * domain truth as Path B (orchestration via releaseEligibleTranche):
 *
 *  1. Client-side guard: dispute repository must be hydrated (fail-closed).
 *  2. Client-side guard: no active blocking dispute for the job.
 *  3. Server call: requestServerTrancheRelease → /api/release-tranche (writes Supabase).
 *  4. Local repo reload: initializeEscrowPlanRepository (refreshes in-memory state).
 *  5. Local side effects: same timeline, analytics, notifications, job completion,
 *     and payment state sync as Path B (via applyLocalSideEffectsAfterServerRelease).
 *
 * Returns the ServerReleaseResult so the caller can surface errors to the user.
 *
 * @param trancheId  — ID of the tranche to release
 * @param planId     — ID of the escrow plan containing the tranche
 * @param jobId      — Job ID linked to the plan
 */
export async function releaseTrancheWorkflow(
  trancheId: string,
  planId: string,
  jobId: string,
  actor: ReleaseActor = 'provider'
): Promise<ServerReleaseResult> {
  // ── Guard: dispute repository hydration (fail-closed) ─────────────────────
  if (!getDisputeRepository().isHydrated()) {
    const err = new Error(
      `Release blocked: dispute repository is not hydrated yet for job ${jobId}. Cannot safely determine dispute state.`
    )
    logError('workflow.release_tranche.release_blocked_unhydrated_disputes', err, { trancheId, planId, jobId })
    throw err
  }

  // ── Guard: no active blocking dispute ────────────────────────────────────
  const existingDispute = getDisputeByJobId(jobId)
  if (existingDispute && isDisputeBlocking(existingDispute.status)) {
    logError('workflow.release_tranche.release_blocked_by_dispute', undefined, {
      trancheId,
      planId,
      jobId,
      disputeId: existingDispute.id,
      disputeStatus: existingDispute.status,
    })
    return {
      ok: false,
      message: `Freigabe blockiert: Ein offener Streitfall verhindert die Freigabe (Streitfall ${existingDispute.id}, Status '${existingDispute.status}').`,
      statusCode: 409,
    }
  }

  // ── Stale tranche reconciliation before server call ──────────────────────
  // Uses the canonical isTriggerSatisfied (trancheTrigger.ts) — same truth
  // as projection, CTA, finance aggregation, and server gate.
  // Guard: skip local reconciliation when escrow repo is not hydrated yet.
  // Unlike the dispute guard above (fail-closed for safety), this is a
  // best-effort optimization — the server call below is authoritative.
  const escrowHydrated = isEscrowPlanRepositoryHydrated()
  if (!escrowHydrated) {
    logWarning('workflow.release_tranche.stale_reconcile_skipped_unhydrated_escrow', {
      trancheId, planId, jobId,
    })
  }
  const trancheForReconcile = escrowHydrated
    ? getEscrowTranches(planId).find((t) => t.id === trancheId)
    : undefined
  if (trancheForReconcile?.status === 'funded') {
    const job = getJobById(jobId)
    if (isTriggerSatisfied(trancheForReconcile, job?.status)) {
      const reconcileFn = trancheForReconcile.kind === 'deposit_release'
        ? recordWorkStarted
        : recordWorkCompleted
      const reconcileResult = await reconcileFn(planId, 'provider')
      if ('error' in reconcileResult) {
        logWarning('workflow.release_tranche.stale_reconcile_failed', {
          trancheId, planId, jobId, kind: trancheForReconcile.kind, error: reconcileResult.error,
        })
        return { ok: false, message: reconcileResult.error, statusCode: 409 }
      }
      logInfo('workflow.release_tranche.stale_reconciled', {
        trancheId, planId, jobId, kind: trancheForReconcile.kind,
      })
    }
  }

  // ── Server-authoritative release (writes to Supabase) ────────────────────
  const result = await requestServerTrancheRelease(trancheId, planId, actor)

  if (!result.ok) {
    logWarning('workflow.release_tranche.server_release_failed', {
      trancheId,
      planId,
      jobId,
      message: result.message,
      statusCode: result.statusCode,
    })
    return result
  }

  // ── Reconciliation case: Stripe Transfer succeeded, DB write did not ─────
  // The Connect Transfer has already executed (money has moved at the
  // provider level), but the canonical Supabase row is not yet `released`.
  // The reconciliation cron and the stable Stripe idempotency key will heal
  // the state. We must NOT run local side effects here: timeline events,
  // notifications, payment-state sync, and job completion all assume the
  // tranche row is canonical. Surface the case so the UI shows a fachliche
  // reconciliation hint instead of a normal "freigegeben"-toast.
  if (result.data.requiresReconciliation === true) {
    logWarning('workflow.release_tranche.requires_reconciliation', {
      trancheId,
      planId,
      jobId,
      externalReleaseRef: result.data.externalReleaseRef,
    })
    return result
  }

  // ── Corridor async case: payout initiated but money not yet landed ────────
  // PAYOUT_MODE returns release_pending (payout created, pays ~7d later via the
  // payout.paid webhook) or release_deferred (balance still pending, no payout
  // yet). The authoritative settlement — job completion, payment_released_at,
  // "Zahlung freigegeben"-side effects — is performed SERVER-side by the
  // payout.paid webhook when the plan reaches fully_released. Running the local
  // 'released' side effects now would complete the job and notify before the
  // money actually arrives (the A1 premature-settlement bug). Surface the
  // pending state so the caller shows an "in wenigen Werktagen"-hint, not a
  // success toast.
  if (result.data.status !== 'released') {
    logInfo('workflow.release_tranche.payout_pending_deferred', {
      trancheId,
      planId,
      jobId,
      status: result.data.status,
      externalReleaseRef: result.data.externalReleaseRef,
    })
    return result
  }

  // ── Reload local escrow repo from Supabase ────────────────────────────────
  await initializeEscrowPlanRepository()

  // ── Apply local side effects (parity with Path B) ─────────────────────────
  await applyLocalSideEffectsAfterServerRelease(
    trancheId,
    planId,
    result.data.planStatus,
    jobId
  )

  logInfo('workflow.release_tranche.complete', {
    trancheId,
    planId,
    jobId,
    planStatus: result.data.planStatus,
    idempotent: result.data.idempotent,
  })

  return result
}
