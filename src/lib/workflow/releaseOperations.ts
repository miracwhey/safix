/**
 * Release Operations — Tranche release execution commands.
 *
 * Provides two release paths:
 *
 *   releaseEligibleTranche  (Path B — local-orchestrated, used by mock provider
 *                            or legacy in-memory escrow service).
 *                            @deprecated In Stripe production builds this path
 *                            is not reached from UI components.  All UI-triggered
 *                            tranche releases go through releaseTrancheWorkflow()
 *                            in paymentWorkflow.ts (Path A — server-authoritative).
 *                            Do NOT add new call sites to this function in
 *                            production code.
 *
 *   applyLocalSideEffectsAfterServerRelease  (Path A post-server helper — called
 *                            by releaseTrancheWorkflow after the server RPC
 *                            succeeds.  Emits the same side effects as Path B so
 *                            both paths produce equivalent domain truth.)
 *
 * Path unification note: the two paths converge through
 * applyLocalSideEffectsAfterServerRelease.  releaseEligibleTranche should be
 * routed to call requestServerTrancheRelease in a future cleanup pass to
 * eliminate the divergence entirely.
 */

import {
  getEscrowPlanById,
  getEscrowTranches,
  getEscrowPlanRepository,
  releaseTranche,
  isTriggerSatisfied,
} from '../payments/escrow'
import type {
  EscrowPaymentPlan,
  EscrowTranche,
  EscrowTrancheStatus,
} from '../payments/escrow/escrowTypes'
import type { ProviderPayoutAccount } from '../payout/types'
import type { JobStatus } from '../shared/coreTypes'
import {
  deriveProviderPaymentReadiness,
  type ProviderBlockingReason,
} from '../payout/providerPaymentReadiness'
import { getJobById, updateJobStatus, updateJobPaymentReleased } from '../jobs'
import { updatePaymentState } from '../payments/service'
import { syncPaymentStateToJobAndProject } from './paymentWorkflow'
import { ensureTimelineEvent } from '../timeline'
import { recordAnalyticsEvent } from '../analytics'
import { createInAppNotification } from '../inAppNotifications'
import { logInfo, logWarning, logError } from '../observability'
import { runPaymentReleasedSideEffects } from './hooks/paymentHooks'
import { sendPayoutHandoffInitiatedEmail } from '../notifications/delivery'
import { incrementCompletedJobsCount } from '../craftsman/craftsmanProfileService'
import { getDisputeRepository } from '../disputes/repository'
import { isDisputeBlocking } from '../disputes/stateMachine'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ReleaseSuccess = {
  ok: true
  data: {
    tranche: EscrowTranche
    plan: EscrowPaymentPlan
    /** True when all tranches are now released and the plan is fully_released */
    planFullyReleased: boolean
  }
}

export type ReleaseError = {
  ok: false
  code: ReleaseErrorCode
  message: string
  /** Structured blocking reason from payout readiness, if applicable */
  blockingReason?: ProviderBlockingReason | null
}

export type ReleaseResult = ReleaseSuccess | ReleaseError

export type ReleaseErrorCode =
  | 'TRANCHE_NOT_FOUND'
  | 'TRANCHE_NOT_ELIGIBLE'
  | 'TRANCHE_ALREADY_RELEASED'
  | 'PAYOUT_NOT_READY'
  | 'PLAN_NOT_FOUND'
  | 'DISPUTE_BLOCKING'
  | 'RELEASE_FAILED'

// ---------------------------------------------------------------------------
// Blocked reason derivation
// ---------------------------------------------------------------------------

/** Valid tranche statuses that indicate the tranche cannot yet be released. */
const NON_RELEASABLE_STATUSES: ReadonlySet<EscrowTrancheStatus> = new Set([
  'pending_funding',
  'funded',
  'locked',
  'blocked',
  'disputed',
  'refunded',
  'cancelled',
])

/**
 * Derives a human-readable blocked reason for a tranche that cannot be released.
 *
 * Returns null if the tranche is in a releasable state and payout is ready.
 */
export function deriveTrancheBlockedReason(
  tranche: EscrowTranche,
  providerPayoutAccount: ProviderPayoutAccount | null,
  jobStatus?: JobStatus
): string | null {
  if (tranche.status === 'released') {
    return null // Already released
  }

  if (tranche.status === 'disputed') {
    return 'Ein offener Streitfall blockiert die Freigabe dieser Tranche.'
  }

  if (tranche.status === 'cancelled' || tranche.status === 'refunded') {
    return 'Diese Tranche wurde bereits storniert oder erstattet.'
  }

  if (NON_RELEASABLE_STATUSES.has(tranche.status)) {
    // Canonical stale-trigger reconciliation (deposit AND final).
    if (isTriggerSatisfied(tranche, jobStatus)) {
      const readiness = deriveProviderPaymentReadiness(providerPayoutAccount)
      if (!readiness.isPayoutReady) {
        return readiness.blockingReason?.message
          ?? 'Die Auszahlungsbereitschaft des Betriebs ist nicht abgeschlossen.'
      }
      return null
    }
    return 'Diese Tranche ist noch nicht freigabefähig.'
  }

  // Tranche is eligible_for_release or release_pending — check payout readiness
  const readiness = deriveProviderPaymentReadiness(providerPayoutAccount)
  if (!readiness.isPayoutReady) {
    return readiness.blockingReason?.message
      ?? 'Die Auszahlungsbereitschaft des Betriebs ist nicht abgeschlossen.'
  }

  return null
}

// ---------------------------------------------------------------------------
// Release view model
// ---------------------------------------------------------------------------

export type TrancheReleaseState =
  | 'not_eligible'
  | 'eligible'
  | 'payout_blocked'
  | 'release_pending'
  | 'released'
  | 'disputed'

/**
 * Derives the current release state for a tranche, incorporating payout readiness.
 */
export function deriveTrancheReleaseState(
  tranche: EscrowTranche,
  providerPayoutAccount: ProviderPayoutAccount | null,
  jobStatus?: JobStatus
): TrancheReleaseState {
  if (tranche.status === 'released') return 'released'
  if (tranche.status === 'disputed') return 'disputed'
  if (tranche.status === 'release_pending') return 'release_pending'

  if (tranche.status === 'eligible_for_release') {
    const readiness = deriveProviderPaymentReadiness(providerPayoutAccount)
    return readiness.isPayoutReady ? 'eligible' : 'payout_blocked'
  }

  // Canonical stale-trigger reconciliation (deposit AND final).
  // Uses the single truth function from trancheTrigger.ts.
  if (isTriggerSatisfied(tranche, jobStatus)) {
    const readiness = deriveProviderPaymentReadiness(providerPayoutAccount)
    return readiness.isPayoutReady ? 'eligible' : 'payout_blocked'
  }

  return 'not_eligible'
}

// ---------------------------------------------------------------------------
// Core release command
// ---------------------------------------------------------------------------

/**
 * Release an eligible escrow tranche.
 *
 * This is the canonical orchestration command for tranche release.
 * It validates all preconditions, delegates to the escrow service,
 * and emits all required side effects.
 *
 * Guards:
 * - Tranche must exist
 * - Tranche must be eligible_for_release or release_pending
 * - Provider payout account must be fully ready
 * - No blocking dispute or terminal state
 * - Already-released tranche returns idempotent success
 *
 * Side effects on success:
 * - Tranche status → released
 * - Plan status → partially_released or fully_released
 * - Timeline events: tranche_released, payout_handoff_initiated
 * - Analytics event: tranche_released
 * - In-app notification to provider
 * - If plan fully released: job → completed, payment_released synced
 *
 * @param trancheId              — ID of the tranche to release
 * @param providerPayoutAccount  — Provider's payout account (for readiness check)
 * @param externalReleaseRef     — Optional Stripe Transfer ID or equivalent
 */
export async function releaseEligibleTranche(
  trancheId: string,
  providerPayoutAccount: ProviderPayoutAccount | null,
  externalReleaseRef?: string
): Promise<ReleaseResult> {
  // ── Find the tranche and its plan ──────────────────────────────────
  const repo = _findTrancheAndPlan(trancheId)
  if (!repo) {
    return {
      ok: false,
      code: 'TRANCHE_NOT_FOUND',
      message: 'Tranche nicht gefunden.',
    }
  }
  const { plan } = repo

  // ── Idempotent: already released ───────────────────────────────────
  // Check BEFORE payout readiness to avoid re-checking readiness on
  // already-released tranches (safe for retries/reload).
  const currentTranche = _getCurrentTranche(trancheId, plan.id)
  if (!currentTranche) {
    return {
      ok: false,
      code: 'TRANCHE_NOT_FOUND',
      message: 'Tranche nicht gefunden.',
    }
  }

  if (currentTranche.status === 'released') {
    logInfo('release.idempotent_skip', {
      trancheId,
      planId: plan.id,
    })
    const updatedPlan = getEscrowPlanById(plan.id)!
    return {
      ok: true,
      data: {
        tranche: currentTranche,
        plan: updatedPlan,
        planFullyReleased: updatedPlan.status === 'fully_released',
      },
    }
  }

  // ── Guard: canonical dispute blocking ─────────────────────────────
  // Check the dispute repository directly — do NOT rely on tranche.status
  // being set to 'disputed', because openDisputeWorkflow does not transition
  // tranche status. The canonical blocking truth lives in the dispute repo.
  // Fail-closed when unhydrated: an empty cache cannot be trusted as "no dispute".
  const disputeRepo = getDisputeRepository()
  if (!disputeRepo.isHydrated()) {
    const err = new Error(
      `Release blocked: dispute repository is not hydrated yet for tranche ${trancheId}. Cannot safely determine dispute state.`
    )
    logError('release.tranche.unhydrated_dispute_repo', err, { trancheId, planId: plan.id })
    throw err
  }
  const jobForDispute = _getJobForPlan(plan)
  if (jobForDispute) {
    const existingDispute = disputeRepo.getByJobId(jobForDispute.id)
    if (existingDispute && isDisputeBlocking(existingDispute.status)) {
      logWarning('release.tranche.dispute_blocking', {
        trancheId,
        planId: plan.id,
        jobId: jobForDispute.id,
        disputeId: existingDispute.id,
        disputeStatus: existingDispute.status,
      })
      return {
        ok: false,
        code: 'DISPUTE_BLOCKING',
        message: `Ein offener Streitfall blockiert die Freigabe dieser Tranche (Streitfall ${existingDispute.id}, Status '${existingDispute.status}').`,
      }
    }
  }

  // ── Guard: tranche must be eligible for release ────────────────────
  if (currentTranche.status !== 'eligible_for_release' && currentTranche.status !== 'release_pending') {
    if (currentTranche.status === 'disputed') {
      return {
        ok: false,
        code: 'DISPUTE_BLOCKING',
        message: 'Ein offener Streitfall blockiert die Freigabe dieser Tranche.',
      }
    }
    return {
      ok: false,
      code: 'TRANCHE_NOT_ELIGIBLE',
      message: `Tranche kann nicht freigegeben werden: Status ist '${currentTranche.status}'.`,
    }
  }

  // ── Guard: payout readiness ────────────────────────────────────────
  const readiness = deriveProviderPaymentReadiness(providerPayoutAccount)
  if (!readiness.isPayoutReady) {
    // Emit release_blocked timeline event
    const job = _getJobForPlan(plan)
    if (job) {
      ensureTimelineEvent({
        jobId: job.id,
        type: 'release_blocked',
      })

      recordAnalyticsEvent({
        eventType: 'release_blocked',
        entityType: 'payment',
        entityId: plan.id,
        metadata: {
          trancheId,
          trancheKind: currentTranche.kind,
          blockingCode: readiness.blockingReason?.code,
        },
      })
    }

    logWarning('release.payout_not_ready', {
      trancheId,
      planId: plan.id,
      blockingCode: readiness.blockingReason?.code,
    })

    return {
      ok: false,
      code: 'PAYOUT_NOT_READY',
      message: readiness.blockingReason?.message
        ?? 'Die Auszahlungsbereitschaft des Betriebs ist nicht abgeschlossen. Stripe Connect muss vollständig eingerichtet sein.',
      blockingReason: readiness.blockingReason,
    }
  }

  // ── Execute release via escrow service ─────────────────────────────
  const result = await releaseTranche(trancheId, 'system', {
    externalReleaseRef,
    providerPayoutAccount,
  })

  if ('error' in result) {
    logWarning('release.escrow_service_error', {
      trancheId,
      planId: plan.id,
      error: result.error,
    })
    return {
      ok: false,
      code: 'RELEASE_FAILED',
      message: result.error,
    }
  }

  // ── Side effects on successful release ─────────────────────────────
  const { plan: updatedPlan, tranche: releasedTranche } = result
  const planFullyReleased = updatedPlan.status === 'fully_released'
  const job = _getJobForPlan(updatedPlan)

  if (job) {
    // Timeline: tranche released
    ensureTimelineEvent({
      jobId: job.id,
      type: 'tranche_released',
    })

    // Timeline: payout handoff initiated
    ensureTimelineEvent({
      jobId: job.id,
      type: 'payout_handoff_initiated',
    })

    // Analytics
    recordAnalyticsEvent({
      eventType: 'tranche_released',
      entityType: 'payment',
      entityId: plan.id,
      metadata: {
        trancheId,
        trancheKind: releasedTranche.kind,
        trancheAmount: releasedTranche.amount,
        planStatus: updatedPlan.status,
        externalReleaseRef,
      },
    })

    // In-app notification to provider
    if (job.craftsmanUserId) {
      const label = releasedTranche.kind === 'deposit_release'
        ? '25%-Tranche'
        : '75%-Tranche'
      createInAppNotification({
        id: `notif-tranche-released-${trancheId}`,
        userId: job.craftsmanUserId,
        type: 'tranche_released',
        entityType: 'payment',
        entityId: plan.id,
        title: `${label} freigegeben`,
        message: `Die ${label} (${releasedTranche.amount.toFixed(2)} €) wurde freigegeben.`,
        isRead: false,
        createdAt: Date.now(),
      })
    }

    // Sync Payment.state only when the plan is fully released.
    // Partial releases (e.g. 25 % auto-release at work start) must NOT flip
    // Payment.state to 'release_pending' — that state is reserved for the
    // customer-facing 75 % approval phase triggered by work completion.
    // The 25 % phase lives in 'work_in_progress', set by startJobWorkflow.
    if (planFullyReleased) {
      await updatePaymentState(job.id, 'released')
      await updateJobPaymentReleased(job.id, 'system')

      // Route through the canonical sync path so both job.paymentState and
      // project.paymentState are updated with failure logging.
      await syncPaymentStateToJobAndProject(job.id, 'released')

      // Job status is set separately — updateJobStatus is awaited because
      // it is a canonical job mutation (Block 1 contract).
      await updateJobStatus(job.id, 'completed')

      if (job.craftsmanUserId) {
        incrementCompletedJobsCount(job.craftsmanUserId).catch((err: unknown) => {
          logWarning('release.increment_completed_jobs_failed', {
            jobId: job.id,
            craftsmanUserId: job.craftsmanUserId,
            error: err,
          })
        })
      }

      // All released side effects (timeline, invoice sync, analytics,
      // in-app notification) are handled by the shared hook.
      await runPaymentReleasedSideEffects({ jobId: job.id, job })
    }
    // Partial release: leave Payment.state untouched. workCompletedWorkflow
    // is the canonical driver for the release_pending transition.
  }

  logInfo('release.tranche_released', {
    trancheId,
    planId: updatedPlan.id,
    trancheKind: releasedTranche.kind,
    planStatus: updatedPlan.status,
    planFullyReleased,
  })

  return {
    ok: true,
    data: {
      tranche: releasedTranche,
      plan: updatedPlan,
      planFullyReleased,
    },
  }
}

// ---------------------------------------------------------------------------
// Post-server-release local side effects
// ---------------------------------------------------------------------------

/**
 * Apply local side effects after a server-authoritative tranche release.
 *
 * Called AFTER:
 *  1. requestServerTrancheRelease() succeeded (server persisted to Supabase)
 *  2. initializeEscrowPlanRepository() reloaded the local repo from Supabase
 *
 * Emits the same side effects that releaseEligibleTranche() emits after a
 * successful in-memory release, so both release paths produce equivalent
 * domain truth:
 *   - timeline: tranche_released, payout_handoff_initiated
 *   - analytics: tranche_released
 *   - in-app notification to provider
 *   - if fully released: job completed, payment state synced, invoice synced,
 *     craftsman count incremented, canonical payment-released side effects
 *   - if partially released: job payment state synced to release_pending
 *
 * @param trancheId  — ID of the tranche that was released
 * @param planId     — ID of the escrow plan
 * @param planStatus — Plan status string from the server response
 *                     ('fully_released' | 'partially_released' | ...)
 * @param jobId      — Job ID linked to the plan (from escrow plan or caller)
 */
export async function applyLocalSideEffectsAfterServerRelease(
  trancheId: string,
  planId: string,
  planStatus: string,
  jobId: string
): Promise<void> {
  const planFullyReleased = planStatus === 'fully_released'

  const plan = getEscrowPlanById(planId)
  const tranches = getEscrowTranches(planId)
  const releasedTranche = tranches.find((t) => t.id === trancheId)
  const job = getJobById(jobId)

  if (!job) {
    logWarning('release.post_server.job_not_found', { trancheId, planId, jobId })
    // Job missing: skip all job-dependent side effects but do not throw.
    return
  }

  // ── Tranche-level side effects ────────────────────────────────────────────

  ensureTimelineEvent({
    jobId: job.id,
    type: 'tranche_released',
  })

  ensureTimelineEvent({
    jobId: job.id,
    type: 'payout_handoff_initiated',
  })

  recordAnalyticsEvent({
    eventType: 'tranche_released',
    entityType: 'payment',
    entityId: planId,
    metadata: {
      trancheId,
      trancheKind: releasedTranche?.kind,
      trancheAmount: releasedTranche?.amount,
      planStatus,
    },
  })

  if (job.craftsmanUserId && releasedTranche) {
    const label = releasedTranche.kind === 'deposit_release'
      ? '25%-Tranche'
      : '75%-Tranche'
    createInAppNotification({
      id: `notif-tranche-released-${trancheId}`,
      userId: job.craftsmanUserId,
      type: 'tranche_released',
      entityType: 'payment',
      entityId: planId,
      title: `${label} freigegeben`,
      message: `Die ${label} (${releasedTranche.amount.toFixed(2)} €) wurde freigegeben.`,
      isRead: false,
      createdAt: Date.now(),
    })

    // Email the craftsman that the Stripe Transfer has been handed off —
    // the same signal as `payout_handoff_initiated` on the timeline so
    // the three channels (in-app, timeline, email) stay aligned.
    sendPayoutHandoffInitiatedEmail(job.id, job.craftsmanUserId, {
      jobTitle: job.title,
      trancheLabel: label,
    })
  }

  // ── Plan-completion or partial-release side effects ───────────────────────

  // Sync Payment.state only when the plan is fully released. A partial
  // release (e.g. 25 % deposit_release during work start) must NOT flip
  // Payment.state to 'release_pending' — that state is reserved for the
  // customer-facing 75 % approval phase triggered by work completion.
  // The 25 % phase lives in 'work_in_progress', set by startJobWorkflow
  // BEFORE the tranche release runs. Without this guard, the auto-release
  // would emit a premature "Freigabe erforderlich" attention for the
  // customer during the in-progress phase.
  if (planFullyReleased) {
    await updatePaymentState(job.id, 'released')
    await updateJobPaymentReleased(job.id, 'system')

    await syncPaymentStateToJobAndProject(job.id, 'released')

    await updateJobStatus(job.id, 'completed')

    if (job.craftsmanUserId) {
      incrementCompletedJobsCount(job.craftsmanUserId).catch((err: unknown) => {
        logWarning('release.post_server.increment_completed_jobs_failed', {
          jobId: job.id,
          craftsmanUserId: job.craftsmanUserId,
          error: err,
        })
      })
    }

    await runPaymentReleasedSideEffects({ jobId: job.id, job })
  }
  // Partial release: leave Payment.state untouched. workCompletedWorkflow
  // is the canonical driver for the release_pending transition.

  logInfo('release.post_server.side_effects_applied', {
    trancheId,
    planId: plan?.id ?? planId,
    planStatus,
    planFullyReleased,
    jobId: job.id,
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _findTrancheAndPlan(trancheId: string): {
  tranche: EscrowTranche
  plan: EscrowPaymentPlan
} | null {
  const repo = getEscrowPlanRepository()
  for (const plan of repo.getAllPlans()) {
    const tranches = repo.getTranchesForPlan(plan.id)
    const found = tranches.find((t: EscrowTranche) => t.id === trancheId)
    if (found) return { tranche: found, plan }
  }
  return null
}

function _getCurrentTranche(trancheId: string, planId: string): EscrowTranche | undefined {
  return getEscrowTranches(planId).find((t) => t.id === trancheId)
}

function _getJobForPlan(plan: EscrowPaymentPlan): ReturnType<typeof getJobById> {
  return getJobById(plan.jobId)
}
