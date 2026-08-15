import type { Job } from './types'
import type { PaymentState } from '../shared/coreTypes'
import type { Payment } from '../payments'

/**
 * Describes the current execution and release phase of a job that has
 * progressed past proposal acceptance and deposit.
 *
 * - `execution_active`  – Work has started (deposit paid, job in_progress),
 *                         craftsman has not yet marked it complete.
 * - `work_completed`    – Craftsman marked work complete; customer has not yet
 *                         released payment.
 * - `payment_released`  – Customer confirmed and released the payment.
 * - `not_applicable`    – Job is not yet in a phase where execution progress
 *                         tracking applies (e.g. still in proposal/scheduling).
 */
export type ReleaseReadinessPhase =
  | 'execution_active'
  | 'work_completed'
  | 'payment_released'
  | 'not_applicable'

export interface ReleaseReadinessViewModel {
  phase: ReleaseReadinessPhase
  /** Human-readable German label for the current phase */
  phaseLabel: string
  /** Supporting description shown below the label */
  phaseDescription: string
  jobId: string
  /** True when craftsman can mark the work as complete */
  canMarkComplete: boolean
  /** True when customer can release the payment */
  canReleasePayment: boolean
  workCompletedAt?: number
  paymentReleasedAt?: number
}

const EXECUTION_ACTIVE_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
])

/**
 * Derives the release-readiness view model for a job.
 *
 * Returns `null` when:
 * - The job is not yet in a phase where execution progress tracking is meaningful, OR
 * - `payment` is absent AND `paymentHydrated` is false — the repository has not
 *   finished loading, so we cannot distinguish "no payment exists" from "not loaded
 *   yet".  Fail-closed: do not derive active execution CTAs from a stale job mirror.
 *
 * @param paymentHydrated  Pass `isPaymentRepositoryHydrated()` from the call site.
 *   Defaults to `true` so pure-function / in-memory-repo call sites are unaffected.
 */
export function deriveReleaseReadiness(
  job: Job,
  payment?: Payment,
  paymentHydrated = true
): ReleaseReadinessViewModel | null {
  // Payment released — final state.
  // Canonical payment.state is checked first to close the gap between
  // finalizeStateAtomic (which sets payment.state='released' atomically) and
  // updateJobPaymentReleased (which sets job.paymentReleasedAt only after the
  // bridge succeeds). In that window canReleasePayment must already be false.
  if (payment?.state === 'released' || job.paymentReleasedAt) {
    return {
      phase: 'payment_released',
      phaseLabel: 'Zahlung freigegeben',
      phaseDescription: 'Der Auftrag ist vollständig abgeschlossen. Die Zahlung wurde freigegeben.',
      jobId: job.id,
      canMarkComplete: false,
      canReleasePayment: false,
      workCompletedAt: job.workCompletedAt,
      paymentReleasedAt: job.paymentReleasedAt,
    }
  }

  // Work completed by craftsman — check for open disputes first
  if (job.workCompletedAt) {
    // All four active dispute states block payment release.
    const hasOpenDispute =
      job.disputeStatus === 'open' ||
      job.disputeStatus === 'under_review' ||
      job.disputeStatus === 'customer_waiting' ||
      job.disputeStatus === 'provider_waiting'

    // Fail-closed for payment release CTA: a payment entity must either be present
    // or the repository must be hydrated (confirming absence is real, not transient).
    // Phase and description are derived from job facts alone and remain correct.
    const paymentTrustReady = !!payment || paymentHydrated

    // Belt-and-suspenders: never allow release if payment is already in a terminal
    // state. 'released' is already narrowed out by the early return above;
    // this guard closes the refunded path and any other terminal residual.
    const paymentTerminal = payment?.state === 'refunded'

    return {
      phase: 'work_completed',
      phaseLabel: 'Arbeit abgeschlossen',
      phaseDescription: hasOpenDispute
        ? 'Es liegt ein offener Streitfall vor. Die Zahlung kann erst nach Klärung freigegeben werden.'
        : 'Der Handwerker hat die Arbeit als fertig markiert. Bitte überprüfe das Ergebnis und gib die Zahlung frei.',
      jobId: job.id,
      canMarkComplete: false,
      canReleasePayment: !hasOpenDispute && paymentTrustReady && !paymentTerminal,
      workCompletedAt: job.workCompletedAt,
      paymentReleasedAt: undefined,
    }
  }

  // Fail-closed: if payment repo is not hydrated and no payment entity is available,
  // we cannot distinguish "payment not yet created" from "payment not yet loaded".
  // Do not derive execution-active CTAs from a potentially stale job.paymentState mirror.
  if (!payment && !paymentHydrated) return null

  // Execution is actively in progress — craftsman can mark complete
  const paymentState = payment?.state ?? job.paymentState
  const isExecutionActive =
    (job.status === 'in_progress' || job.status === 'waiting_payment') &&
    EXECUTION_ACTIVE_PAYMENT_STATES.has(paymentState as PaymentState)

  if (isExecutionActive) {
    return {
      phase: 'execution_active',
      phaseLabel: 'Arbeit läuft',
      phaseDescription: 'Die Ausführung ist im Gange. Der Handwerker kann die Arbeit als abgeschlossen markieren, wenn alles fertig ist.',
      jobId: job.id,
      canMarkComplete: true,
      canReleasePayment: false,
      workCompletedAt: undefined,
      paymentReleasedAt: undefined,
    }
  }

  // Not yet in a relevant phase
  return null
}
