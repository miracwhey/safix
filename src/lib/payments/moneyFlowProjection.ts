/**
 * Money Flow Projection — Canonical Per-Job Money-Flow View Model
 *
 * Answers ALL money-flow questions for a single job from one place:
 *   1. Gesamtbetrag / Gebühren / Netto
 *   2. Funding-Status (hat der Kunde gezahlt?)
 *   3. Release-Status (was ist freigegeben / freigabefähig / gesperrt?)
 *   4. Payout-Status (wurde Geld zur Auszahlung übergeben?)
 *   5. Blocking-Reason (warum ist etwas gesperrt?)
 *   6. Primary Next Action (was soll als nächstes passieren?)
 *   7. Deutsche Labels für alle Zustände
 *
 * CANONICAL SOURCES (priority order):
 *   1. EscrowPaymentPlan + EscrowTranches
 *   2. FundingRequest status
 *   3. Payment entity (legacy, only where escrow not yet created)
 *   4. Job status (for work-phase context)
 *   5. Dispute status
 *   6. ProviderPayoutAccount (payout readiness)
 *
 * RULES:
 * - Pure function — no side effects, no store reads inside
 * - All inputs passed explicitly
 * - Unknown/uncertain states are marked explicitly, never faked
 * - "Ausgezahlt" only when Stripe Transfer ID exists
 * - No UI logic — returns structured data for UI consumption
 */

import type { EscrowPaymentPlan, EscrowTranche, EscrowTrancheKind } from './escrow/escrowTypes.js'
import { isEffectivelyEligible, isTriggerSatisfied } from './escrow/trancheTrigger.js'
import type { Payment } from './types.js'
import type { ProviderPayoutAccount } from '../payout/types.js'
import type { Job } from '../jobs/types.js'
import type { Dispute } from '../disputes/types.js'
import { isDisputeBlocking } from '../disputes/stateMachine.js'
import { deriveProviderPaymentReadiness } from '../payout/providerPaymentReadiness.js'
import { resolveJobFeeRate } from '../shared/feeRate.js'
import { formatEuro } from '../shared/formatters.js'

// ── Funding Status ──────────────────────────────────────────────────────────

export type FundingStatus =
  | 'no_escrow_plan'
  | 'customer_not_paid'
  | 'payment_processing'
  | 'funded_in_escrow'
  | 'funding_failed'
  // Terminal-dead funding request (raw status 'expired' or 'cancelled'). The
  // expiry cron + the synchronous expiry gate update funding_requests.status
  // only — never escrow_plans — so the plan stays at 'awaiting_customer_funding'
  // while the request can no longer be paid. Distinct from 'customer_not_paid'
  // (genuinely still pending): the customer CANNOT pay a dead request; a new
  // attempt is a separate funding_requests row created by the provider.
  | 'funding_expired'

// ── Payout Status ───────────────────────────────────────────────────────────

export type PayoutStatus =
  | 'no_transfer_yet'
  | 'transfer_triggered'
  | 'payout_in_transit'
  | 'payout_completed'
  | 'payout_failed'
  | 'transfer_reversed'
  | 'payout_blocked'
  | 'payout_unknown'

// ── Payout bank outcome ─────────────────────────────────────────────────────
// Downstream bank-arrival truth derived from Stripe `payout.paid` and
// `payout.failed` webhook-emitted timeline signals. `in_transit` is an
// optional interim state reserved for future `payout.created`/
// `payout.in_transit` handlers — not currently emitted by the webhook.
//
// The outcome is tracked per Stripe Transfer (= per released tranche),
// not per job — otherwise a 25 % payout confirmation would prematurely
// mark the whole job as "Auf deinem Konto" while the 75 % tranche is
// still on its way to the bank.
export type PayoutBankOutcome = 'completed' | 'failed' | 'in_transit' | null
export type PayoutOutcomesByTransfer = ReadonlyMap<string, 'completed' | 'failed'>

// ── Blocking Reason ─────────────────────────────────────────────────────────

export type BlockingReason =
  | 'none'
  | 'waiting_for_customer_payment'
  | 'waiting_for_work_start'
  | 'waiting_for_work_completion'
  | 'blocked_by_dispute'
  | 'blocked_by_provider_readiness'
  | 'blocked_by_unknown_state'

// ── Primary Next Action ─────────────────────────────────────────────────────

export type PrimaryNextAction =
  | 'wait_for_customer_payment'
  | 'start_work'
  | 'release_first_tranche'
  | 'complete_work'
  | 'release_final_tranche'
  | 'resolve_dispute'
  | 'fix_provider_payout_setup'
  | 'no_action'

// ── Per-Tranche Projection ──────────────────────────────────────────────────

export type TrancheProjection = {
  id: string
  kind: EscrowTrancheKind
  /** e.g. "25 % Arbeitsbeginn" */
  label: string
  percentage: number
  amount: number
  amountFormatted: string
  status: EscrowTranche['status']
  statusLabel: string
  isReleased: boolean
  isEligible: boolean
  isBlocked: boolean
  releasedAt: number | null
  releasedAtFormatted: string
  /** Stripe Transfer ID — only present when actually transferred */
  externalReleaseRef: string | null
  /**
   * Set when the recorded Transfer was subsequently reversed.
   * Presence means isReleased=false regardless of externalReleaseRef.
   */
  transferReversalRef: string | null
  /** Human-readable blocking reason, null if not blocked */
  blockingReason: string | null
}

// ── Money Flow Projection ───────────────────────────────────────────────────

export type MoneyFlowProjection = {
  // ── Job context ─────────────────────────────────────────────────────────

  jobId: string
  hasEscrowPlan: boolean

  // ── 1. Amounts ──────────────────────────────────────────────────────────

  totalAmount: number
  totalAmountFormatted: string
  platformFeeRate: number
  platformFeeAmount: number
  platformFeeFormatted: string
  providerNetAmount: number
  providerNetFormatted: string

  // ── 2. Funding Status ──────────────────────────────────────────────────

  fundingStatus: FundingStatus
  fundingStatusLabel: string

  // ── 3. Release Status ──────────────────────────────────────────────────

  releasedAmount: number
  releasedAmountFormatted: string
  unreleasedAmount: number
  unreleasedAmountFormatted: string
  releasableAmount: number
  releasableAmountFormatted: string
  releasedPercent: number
  tranches: TrancheProjection[]

  // ── 4. Payout Status ──────────────────────────────────────────────────

  payoutStatus: PayoutStatus
  payoutStatusLabel: string

  // ── 5. Blocking Reason ─────────────────────────────────────────────────

  blockingReason: BlockingReason
  blockingReasonLabel: string

  // ── 6. Primary Next Action ─────────────────────────────────────────────

  primaryAction: PrimaryNextAction
  primaryActionLabel: string

  // ── 7. Summary for quick rendering ─────────────────────────────────────

  /** One-line summary: "Kundenzahlung eingegangen · 25 % freigabefähig" */
  summaryLine: string
  /** Is the escrow fully resolved (released or refunded)? */
  isTerminal: boolean
  /** Is the escrow in a dispute state? */
  isDisputed: boolean
  /**
   * True when the escrow was released in the DB but no Stripe Transfer ID
   * has been recorded for any released tranche (payoutStatus === 'payout_unknown').
   * Indicates a state that requires automated retry or manual reconciliation.
   * Fail-closed: UI must not show final payout language when this is true.
   */
  requiresReconciliation: boolean

  // ── 8. Acceptance deadline ────────────────────────────────────────────
  /** Unix timestamp (ms) when auto-release fires, if applicable */
  acceptanceDeadline: number | null
  /** Human-readable deadline label */
  acceptanceDeadlineLabel: string
}

// ── Input type ──────────────────────────────────────────────────────────────

export type MoneyFlowProjectionInput = {
  job: Job
  escrowPlan: EscrowPaymentPlan | null | undefined
  tranches: EscrowTranche[]
  payment: Payment | null | undefined
  dispute: Dispute | null | undefined
  providerPayoutAccount: ProviderPayoutAccount | null | undefined
  /** Funding request status string, if available */
  fundingRequestStatus?: string | null
  /** Acceptance deadline (expiresAt), if applicable */
  acceptanceExpiresAt?: number | null
  /**
   * Pre-resolved canonical total amount, including ChangeOrder deltas.
   * When provided (from resolveCanonicalAmount), this is used as the
   * authoritative totalAmount instead of reading escrowPlan.totalAmount
   * directly — aligning with craftsmanPayoutSummary's amount source.
   */
  canonicalTotalAmount?: number | null
  /**
   * Optional bank-arrival outcomes derived from webhook-emitted timeline
   * signals (`payout_completed` / `payout_failed`), keyed by the Stripe
   * Transfer id that maps to `escrow_tranches.external_release_ref`.
   * Tranche-scoped — the projection only reports a job-level
   * `payout_completed` when every released tranche's transfer has a
   * completed outcome and the plan itself is fully released.
   */
  payoutOutcomesByTransfer?: PayoutOutcomesByTransfer
}

// ── Label maps ──────────────────────────────────────────────────────────────

const FUNDING_STATUS_LABELS: Record<FundingStatus, string> = {
  no_escrow_plan: 'Kein Zahlungsplan',
  customer_not_paid: 'Kundenzahlung ausstehend',
  payment_processing: 'Einzahlung wird verarbeitet',
  funded_in_escrow: 'Kundenzahlung eingegangen',
  funding_failed: 'Einzahlung fehlgeschlagen',
  funding_expired: 'Zahlungsanfrage abgelaufen',
}

const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  no_transfer_yet: 'Noch keine Auszahlung',
  // 'transfer_triggered' proves a Stripe Connect Transfer to the provider's
  // Connected Account — money has left the platform escrow and is on its
  // way to the bank, but the bank arrival is not yet confirmed.
  transfer_triggered: 'Zur Auszahlung übergeben',
  // Explicit interim state once a payout is created on Stripe but not yet
  // paid (reserved for future webhook handlers).
  payout_in_transit: 'Auszahlung läuft',
  // Stripe payout.paid received — money arrived on the craftsman's bank.
  payout_completed: 'Auf deinem Konto',
  // Stripe payout.failed received — bank rejected the payout.
  payout_failed: 'Auszahlung fehlgeschlagen',
  // Stripe reversed the transfer — funds returned to platform. Manual review needed.
  transfer_reversed: 'Überweisung storniert — Klärung läuft',
  payout_blocked: 'Auszahlung blockiert',
  payout_unknown: 'Auszahlungsstatus unbekannt',
}

const BLOCKING_REASON_LABELS: Record<BlockingReason, string> = {
  none: '',
  waiting_for_customer_payment: 'Warte auf Kundenzahlung',
  waiting_for_work_start: 'Warte auf Arbeitsbeginn',
  waiting_for_work_completion: 'Warte auf Fertigstellung',
  blocked_by_dispute: 'Freigabe wegen Streitfall blockiert',
  blocked_by_provider_readiness: 'Auszahlungskonto noch nicht freigeschaltet',
  blocked_by_unknown_state: 'Status konnte nicht ermittelt werden',
}

const PRIMARY_ACTION_LABELS: Record<PrimaryNextAction, string> = {
  wait_for_customer_payment: 'Auf Kundenzahlung warten',
  start_work: 'Arbeit starten',
  release_first_tranche: '25 % automatisch freigegeben',
  complete_work: 'Arbeit abschließen',
  release_final_tranche: 'Restbetrag bestätigen',
  resolve_dispute: 'Streitfall klären',
  fix_provider_payout_setup: 'Auszahlungskonto einrichten',
  no_action: 'Keine Aktion erforderlich',
}

const TRANCHE_LABELS: Record<EscrowTrancheKind, string> = {
  deposit_release: '25 % Arbeitsbeginn',
  final_release: '75 % Fertigstellung',
}

const TRANCHE_STATUS_LABELS: Record<EscrowTranche['status'], string> = {
  pending_funding: 'Einzahlung ausstehend',
  funded: 'Im Stripe-Absicherung',
  locked: 'Gesperrt',
  eligible_for_release: 'Freigabefähig',
  release_pending: 'Freigabe beantragt',
  released: 'Freigegeben',
  blocked: 'Blockiert',
  disputed: 'Streitfall',
  refunded: 'Erstattet',
  cancelled: 'Storniert',
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function roundEur(value: number): number {
  return Number(value.toFixed(2))
}

function formatDate(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

// ── Core Derivation ─────────────────────────────────────────────────────────

/**
 * Derives a complete money-flow projection for a single job.
 *
 * Pure function — all inputs passed explicitly, no side effects.
 *
 * This is the SINGLE SOURCE OF TRUTH for money-flow display.
 * All UI surfaces should consume this projection instead of
 * independently reading payment/escrow/tranche/payout data.
 */
export function deriveMoneyFlowProjection(input: MoneyFlowProjectionInput): MoneyFlowProjection {
  const {
    job,
    escrowPlan,
    tranches,
    payment,
    dispute,
    providerPayoutAccount,
    fundingRequestStatus,
    acceptanceExpiresAt,
    canonicalTotalAmount,
    payoutOutcomesByTransfer,
  } = input

  const hasEscrowPlan = escrowPlan != null
  const payoutAccount = providerPayoutAccount ?? null

  // ── 1. Amounts ──────────────────────────────────────────────────────────
  // canonicalTotalAmount (from resolveCanonicalAmount) is preferred when
  // provided — it includes ChangeOrder deltas on top of the escrow plan base,
  // matching craftsmanPayoutSummary's amount source hierarchy.

  const totalAmount = canonicalTotalAmount ?? escrowPlan?.totalAmount ?? payment?.amounts.totalAmount ?? 0
  const feeRate = escrowPlan?.platformFeeRate ?? resolveJobFeeRate(job.id)
  const platformFeeAmount = escrowPlan?.platformFeeAmount ?? roundEur(totalAmount * feeRate)
  const providerNetAmount = roundEur(totalAmount - platformFeeAmount)

  // ── 2. Funding Status ──────────────────────────────────────────────────

  const fundingStatus = deriveFundingStatus(escrowPlan, fundingRequestStatus)

  // ── 3. Release Status (per-tranche) ────────────────────────────────────

  const trancheProjections = tranches.map((t) =>
    deriveTrancheProjection(t, payoutAccount, dispute, job)
  )

  const releasedAmount = roundEur(
    trancheProjections
      .filter((t) => t.isReleased)
      .reduce((sum, t) => sum + t.amount, 0)
  )
  const releasableAmount = roundEur(
    trancheProjections
      .filter((t) => t.isEligible && !t.isBlocked)
      .reduce((sum, t) => sum + t.amount, 0)
  )
  const unreleasedAmount = roundEur(totalAmount - releasedAmount)
  const releasedPercent = totalAmount > 0 ? Math.round((releasedAmount / totalAmount) * 100) : 0

  // Refunded share — read straight off the tranche status so it is correct for the
  // corridor (po_*) model where a released deposit tranche has no transfer ref and
  // is therefore NOT counted in releasedAmount. After a 75/25 partial-default
  // settle the held tranches are 'refunded'; the released 25% deposit stays
  // 'released'. Used only by buildSummaryLine to show the partial refund (G6).
  const refundedAmount = roundEur(
    tranches
      .filter((t) => t.status === 'refunded')
      .reduce((sum, t) => sum + t.amount, 0)
  )
  const refundedPercent = totalAmount > 0 ? Math.round((refundedAmount / totalAmount) * 100) : 0

  // ── 4. Payout Status ──────────────────────────────────────────────────

  const payoutStatus = derivePayoutStatus(
    trancheProjections,
    payoutAccount,
    payoutOutcomesByTransfer,
    escrowPlan?.status,
  )

  // ── 5. Blocking Reason ─────────────────────────────────────────────────

  const blockingReason = deriveBlockingReason(
    fundingStatus, escrowPlan, job, dispute, payoutAccount, trancheProjections
  )

  // ── 6. Primary Next Action ─────────────────────────────────────────────

  const primaryAction = derivePrimaryAction(
    fundingStatus, job, escrowPlan, trancheProjections, dispute, payoutAccount
  )

  // ── 7. Terminal / Dispute flags ────────────────────────────────────────

  const isTerminal = escrowPlan?.status === 'fully_released'
    || escrowPlan?.status === 'refunded'
    || escrowPlan?.status === 'cancelled'
    || payment?.state === 'released'
    || payment?.state === 'refunded'

  const isDisputed = (dispute != null && isDisputeBlocking(dispute.status))
    || escrowPlan?.status === 'disputed'

  // Fail-closed attention flag: covers all states where the craftsman must NOT
  // see final-success language —
  //   payout_unknown:   DB released, no Stripe Transfer ID recorded (retry/reconcile)
  //   payout_failed:    bank rejected the payout (investigation required)
  //   transfer_reversed: Stripe reversed the transfer (investigation required)
  const requiresReconciliation = payoutStatus === 'payout_unknown'
    || payoutStatus === 'payout_failed'
    || payoutStatus === 'transfer_reversed'

  // ── 8. Acceptance deadline ──────────────────────────────────────────

  const acceptanceDeadline = acceptanceExpiresAt ?? null
  const acceptanceDeadlineLabel = deriveAcceptanceDeadlineLabel(acceptanceDeadline, isTerminal)

  // ── Summary line ──────────────────────────────────────────────────────

  const summaryLine = buildSummaryLine(
    fundingStatus, releasedPercent, releasableAmount, blockingReason, isTerminal, isDisputed, escrowPlan, payoutStatus, dispute, refundedPercent
  )

  return {
    jobId: job.id,
    hasEscrowPlan,

    totalAmount,
    totalAmountFormatted: formatEuro(totalAmount),
    platformFeeRate: feeRate,
    platformFeeAmount,
    platformFeeFormatted: formatEuro(platformFeeAmount),
    providerNetAmount,
    providerNetFormatted: formatEuro(providerNetAmount),

    fundingStatus,
    fundingStatusLabel: FUNDING_STATUS_LABELS[fundingStatus],

    releasedAmount,
    releasedAmountFormatted: formatEuro(releasedAmount),
    unreleasedAmount,
    unreleasedAmountFormatted: formatEuro(unreleasedAmount),
    releasableAmount,
    releasableAmountFormatted: formatEuro(releasableAmount),
    releasedPercent,
    tranches: trancheProjections,

    payoutStatus,
    payoutStatusLabel: PAYOUT_STATUS_LABELS[payoutStatus],

    blockingReason,
    blockingReasonLabel: BLOCKING_REASON_LABELS[blockingReason],

    primaryAction,
    primaryActionLabel: PRIMARY_ACTION_LABELS[primaryAction],

    summaryLine,
    isTerminal,
    isDisputed,
    requiresReconciliation,

    acceptanceDeadline,
    acceptanceDeadlineLabel,
  }
}

// ── Funding Status Derivation ───────────────────────────────────────────────

function deriveFundingStatus(
  plan: EscrowPaymentPlan | null | undefined,
  fundingRequestStatus?: string | null
): FundingStatus {
  if (!plan) return 'no_escrow_plan'

  switch (plan.status) {
    case 'funded_in_escrow':
    case 'partially_released':
    case 'fully_released':
      return 'funded_in_escrow'

    case 'funding_failed':
      return 'funding_failed'

    case 'funding_initiated':
      return 'payment_processing'

    case 'awaiting_customer_funding': {
      // Terminal-dead request — surface it instead of leaving the plan stuck at
      // 'customer_not_paid' (indistinguishable from a genuinely pending request).
      // 'expired' has live producers (expire-funding-requests cron + the
      // synchronous expiry gate in api/initiate-funding); the customer cannot
      // pay it (initiate-funding returns 409 FUNDING_REQUEST_EXPIRED), a new
      // request is a separate row. 'cancelled' has no live producer today but is
      // terminal-dead in exactly the same way, so it maps here too.
      if (fundingRequestStatus === 'expired' || fundingRequestStatus === 'cancelled') {
        return 'funding_expired'
      }
      // Refine with funding request status if available
      if (fundingRequestStatus === 'funding_started' || fundingRequestStatus === 'funding_initiated') {
        return 'payment_processing'
      }
      return 'customer_not_paid'
    }

    case 'disputed':
    case 'refunded':
    case 'cancelled':
      // These are handled separately; funding was completed at some point
      return 'funded_in_escrow'

    default:
      return 'customer_not_paid'
  }
}

// ── Per-Tranche Projection ──────────────────────────────────────────────────

function deriveTrancheProjection(
  tranche: EscrowTranche,
  payoutAccount: ProviderPayoutAccount | null,
  dispute: Dispute | null | undefined,
  job: Job
): TrancheProjection {
  // Proof-based: status='released' alone is insufficient — external_release_ref
  // (Stripe Transfer ID) is the authoritative proof that funds actually left the
  // platform escrow. Additionally, transfer_reversal_ref must NOT be set:
  // a reversed transfer means money returned to platform and the tranche is no
  // longer settled for the craftsman.
  const isReleased = tranche.status === 'released'
    && tranche.externalReleaseRef != null
    && !tranche.transferReversalRef

  // Canonical eligibility: DB status OR stale-trigger reconciliation
  // (both deposit_release AND final_release). Uses the single truth
  // function from trancheTrigger.ts that mirrors the server gate.
  const isEligible = isEffectivelyEligible(tranche, job.status)
  const isBlocked = deriveTrancheIsBlocked(tranche, payoutAccount, dispute, job)
  const blockingReason = deriveTrancheBlockingReason(tranche, payoutAccount, dispute, job)

  // Status label must reflect the combined truth of eligibility AND payout readiness.
  // A tranche that is eligible but payout-blocked must NOT show "Freigabefähig" —
  // it must show the blocking state to match CraftsmanJobOperationsCard's truth.
  const effectiveStatusLabel = (() => {
    if (isEligible && isBlocked) {
      return 'Auszahlung blockiert'
    }
    if (isEligible && tranche.status !== 'eligible_for_release') {
      return TRANCHE_STATUS_LABELS['eligible_for_release']
    }
    return TRANCHE_STATUS_LABELS[tranche.status]
  })()

  return {
    id: tranche.id,
    kind: tranche.kind,
    label: TRANCHE_LABELS[tranche.kind],
    percentage: tranche.percentage,
    amount: tranche.amount,
    amountFormatted: formatEuro(tranche.amount),
    status: tranche.status,
    statusLabel: effectiveStatusLabel,
    isReleased,
    isEligible,
    isBlocked,
    releasedAt: tranche.releasedAt ?? null,
    releasedAtFormatted: formatDate(tranche.releasedAt),
    externalReleaseRef: tranche.externalReleaseRef ?? null,
    transferReversalRef: tranche.transferReversalRef ?? null,
    blockingReason,
  }
}

function deriveTrancheIsBlocked(
  tranche: EscrowTranche,
  payoutAccount: ProviderPayoutAccount | null,
  dispute: Dispute | null | undefined,
  job: Job
): boolean {
  if (tranche.status === 'released') return false
  if (tranche.status === 'disputed' || tranche.status === 'blocked') return true
  if (dispute && isDisputeBlocking(dispute.status)) return true

  // Effectively eligible (DB status OR stale trigger) → check payout readiness
  if (isEffectivelyEligible(tranche, job.status)) {
    const readiness = deriveProviderPaymentReadiness(payoutAccount)
    return !readiness.isPayoutReady
  }

  return false
}

function deriveTrancheBlockingReason(
  tranche: EscrowTranche,
  payoutAccount: ProviderPayoutAccount | null,
  dispute: Dispute | null | undefined,
  job: Job
): string | null {
  if (tranche.status === 'released') return null

  if (dispute && isDisputeBlocking(dispute.status)) {
    return 'Freigabe wegen Streitfall blockiert'
  }

  if (tranche.status === 'disputed') {
    return 'Freigabe wegen Streitfall blockiert'
  }

  if (tranche.status === 'blocked' || tranche.status === 'locked') {
    return 'Tranche ist gesperrt'
  }

  if (tranche.status === 'eligible_for_release') {
    const readiness = deriveProviderPaymentReadiness(payoutAccount)
    if (!readiness.isPayoutReady) {
      return readiness.blockingReason?.message
        ?? 'Auszahlungskonto noch nicht freigeschaltet'
    }
  }

  if (tranche.status === 'pending_funding' || tranche.status === 'funded') {
    // Stale trigger reconciliation: if trigger is satisfied, the tranche
    // is effectively eligible — check payout readiness instead of blocking.
    if (isTriggerSatisfied(tranche, job.status)) {
      const readiness = deriveProviderPaymentReadiness(payoutAccount)
      if (!readiness.isPayoutReady) {
        return readiness.blockingReason?.message
          ?? 'Auszahlungskonto noch nicht freigeschaltet'
      }
      return null
    }
    // Trigger not yet satisfied — return fachliche reason
    const trigger = tranche.releaseTrigger
    if (trigger === 'work_started') {
      return 'Freigabe erst nach Arbeitsbeginn'
    }
    if (trigger === 'work_completed') {
      return 'Freigabe erst nach Fertigstellung'
    }
  }

  return null
}

// ── Payout Status ───────────────────────────────────────────────────────────

function derivePayoutStatus(
  trancheProjections: TrancheProjection[],
  payoutAccount: ProviderPayoutAccount | null,
  outcomesByTransfer: PayoutOutcomesByTransfer | undefined,
  planStatus: EscrowPaymentPlan['status'] | undefined,
): PayoutStatus {
  // Bank-arrival truth is tranche-scoped and only meaningful once the
  // corresponding Transfer exists (`externalReleaseRef` present). This
  // prevents a stray payout signal from leaking into pre-release phases
  // and prevents a single tranche's bank confirmation from overstating
  // the job as fully paid out.
  if (outcomesByTransfer && outcomesByTransfer.size > 0) {
    const releasedRefs = trancheProjections
      .filter((t) => t.isReleased && t.externalReleaseRef)
      .map((t) => t.externalReleaseRef as string)

    let completedForReleased = 0
    let failedForReleased = 0
    for (const ref of releasedRefs) {
      const outcome = outcomesByTransfer.get(ref)
      if (outcome === 'failed') failedForReleased += 1
      else if (outcome === 'completed') completedForReleased += 1
    }

    // Any failed bank payout on a released tranche dominates — the
    // craftsman must see the failure even when other tranches succeeded.
    if (failedForReleased > 0) return 'payout_failed'

    // Only claim job-level "Auf deinem Konto" when the plan is fully
    // released AND every released transfer has a completed outcome.
    const allReleasedCompleted =
      releasedRefs.length > 0 && completedForReleased === releasedRefs.length
    if (allReleasedCompleted && planStatus === 'fully_released') {
      return 'payout_completed'
    }

    // Partial evidence of bank arrival — at least one tranche confirmed,
    // but the job is not yet fully done. Surface it as in-transit.
    if (completedForReleased > 0) return 'payout_in_transit'
  }


  // isReleased: status='released' AND externalReleaseRef set AND no reversal.
  const releasedWithProof = trancheProjections.filter((t) => t.isReleased)

  // Released in DB, no transfer ref and not reversed — DB write failed after
  // Stripe Transfer. Healing via retry or transfer.created webhook.
  const releasedWithoutProof = trancheProjections.filter(
    (t) => t.status === 'released' && t.externalReleaseRef == null && !t.transferReversalRef
  )

  // Transfer was created but Stripe subsequently reversed it — money back on platform.
  const reversedTranches = trancheProjections.filter((t) => t.transferReversalRef != null)

  if (releasedWithProof.length === 0 && releasedWithoutProof.length === 0 && reversedTranches.length === 0) {
    return 'no_transfer_yet'
  }

  // All transfer evidence is reversal — no currently valid transfers.
  if (releasedWithProof.length === 0 && releasedWithoutProof.length === 0 && reversedTranches.length > 0) {
    return 'transfer_reversed'
  }

  if (releasedWithProof.length === 0) {
    // Tranche(s) released in DB but no Stripe Transfer ID recorded.
    // App and Stripe are inconsistent — do not claim transfer triggered.
    return 'payout_unknown'
  }

  if (releasedWithoutProof.length > 0 || reversedTranches.length > 0) {
    // Mixed state: some tranches proven, others healing or reversed.
    return 'payout_unknown'
  }

  // All released tranches have proof and none reversed. Check payout readiness.
  const readiness = deriveProviderPaymentReadiness(payoutAccount)
  if (!readiness.isPayoutReady) return 'payout_blocked'

  return 'transfer_triggered'
}

// ── Blocking Reason ─────────────────────────────────────────────────────────

function deriveBlockingReason(
  fundingStatus: FundingStatus,
  plan: EscrowPaymentPlan | null | undefined,
  job: Job,
  dispute: Dispute | null | undefined,
  payoutAccount: ProviderPayoutAccount | null,
  trancheProjections: TrancheProjection[]
): BlockingReason {
  // Dispute takes highest priority
  if (dispute && isDisputeBlocking(dispute.status)) {
    return 'blocked_by_dispute'
  }
  if (plan?.status === 'disputed') {
    return 'blocked_by_dispute'
  }

  // Terminal-dead funding request (expired/cancelled): nothing actionable to
  // wait for — the customer cannot pay a dead request. Must NOT report
  // 'waiting_for_customer_payment' (that would keep the craftsman waiting on a
  // payment that can never arrive on this request).
  if (fundingStatus === 'funding_expired') {
    return 'none'
  }

  // Customer hasn't paid
  if (fundingStatus === 'customer_not_paid' || fundingStatus === 'funding_failed') {
    return 'waiting_for_customer_payment'
  }

  // Payment processing — not blocked per se, but waiting
  if (fundingStatus === 'payment_processing') {
    return 'waiting_for_customer_payment'
  }

  // Funded but work not started
  if (fundingStatus === 'funded_in_escrow' && job.status !== 'in_progress' && job.status !== 'waiting_payment' && job.status !== 'completed') {
    return 'waiting_for_work_start'
  }

  // Work in progress, no tranche eligible yet (waiting for completion for final)
  if (job.status === 'in_progress') {
    const hasEligible = trancheProjections.some((t) => t.isEligible)
    if (!hasEligible) {
      // Check if deposit tranche is already released — then waiting for completion
      const depositReleased = trancheProjections.find(
        (t) => t.kind === 'deposit_release' && t.isReleased
      )
      if (depositReleased) return 'waiting_for_work_completion'
    }
  }

  // Check provider readiness blocking
  if (trancheProjections.some((t) => t.isEligible)) {
    const readiness = deriveProviderPaymentReadiness(payoutAccount)
    if (!readiness.isPayoutReady) {
      return 'blocked_by_provider_readiness'
    }
  }

  // Terminal or fully released — no blocking
  if (plan?.status === 'fully_released' || plan?.status === 'refunded' || plan?.status === 'cancelled') {
    return 'none'
  }

  return 'none'
}

// ── Primary Next Action ─────────────────────────────────────────────────────

function derivePrimaryAction(
  fundingStatus: FundingStatus,
  job: Job,
  plan: EscrowPaymentPlan | null | undefined,
  trancheProjections: TrancheProjection[],
  dispute: Dispute | null | undefined,
  payoutAccount: ProviderPayoutAccount | null
): PrimaryNextAction {
  // Terminal states
  if (plan?.status === 'fully_released' || plan?.status === 'refunded' || plan?.status === 'cancelled') {
    return 'no_action'
  }

  // Dispute active
  if (dispute && isDisputeBlocking(dispute.status)) {
    return 'resolve_dispute'
  }

  // Terminal-dead funding request (expired/cancelled): the customer cannot pay
  // it, so there is no provider action and definitely not
  // 'wait_for_customer_payment'. Explicit early return so this never falls
  // through into a stray job-status branch (e.g. an in_progress job).
  if (fundingStatus === 'funding_expired') {
    return 'no_action'
  }

  // Customer hasn't paid or funding failed
  if (fundingStatus === 'customer_not_paid' || fundingStatus === 'payment_processing' || fundingStatus === 'funding_failed' || fundingStatus === 'no_escrow_plan') {
    return 'wait_for_customer_payment'
  }

  // Provider payout not ready — this blocks everything else
  const readiness = deriveProviderPaymentReadiness(payoutAccount)
  if (!readiness.isPayoutReady && trancheProjections.some((t) => t.isEligible)) {
    return 'fix_provider_payout_setup'
  }

  // Check for eligible final tranche (customer action: confirm or wait for auto-release)
  const eligibleFinal = trancheProjections.find(
    (t) => t.kind === 'final_release' && t.isEligible
  )
  if (eligibleFinal) return 'release_final_tranche'

  // Deposit tranche is auto-released at work start. If it's still eligible
  // (system recovery pending), treat as "complete_work" — the reconciliation
  // cron or retry will handle it. No customer CTA needed.

  // Work not started yet
  if (fundingStatus === 'funded_in_escrow' && (job.status === 'booked' || job.status === 'scheduled' || job.status === 'new')) {
    return 'start_work'
  }

  // Work in progress — next action is always complete_work
  if (job.status === 'in_progress') {
    return 'complete_work'
  }

  return 'no_action'
}

// ── Acceptance Deadline Label ────────────────────────────────────────────────

export function deriveAcceptanceDeadlineLabel(
  deadlineMs: number | null,
  isTerminal: boolean,
): string {
  if (!deadlineMs || isTerminal) return ''

  const now = Date.now()
  if (deadlineMs <= now) return 'Frist abgelaufen — automatische Freigabe'

  const remainingMs = deadlineMs - now
  const hours = Math.floor(remainingMs / (1000 * 60 * 60))
  const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60))

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return `Automatische Freigabe in ${days} T ${remainingHours} Std`
  }
  if (hours > 0) {
    return `Automatische Freigabe in ${hours} Std ${minutes} Min`
  }
  return `Automatische Freigabe in ${minutes} Min`
}

// ── Summary Line ────────────────────────────────────────────────────────────

function buildSummaryLine(
  fundingStatus: FundingStatus,
  releasedPercent: number,
  releasableAmount: number,
  blockingReason: BlockingReason,
  isTerminal: boolean,
  isDisputed: boolean,
  plan: EscrowPaymentPlan | null | undefined,
  payoutStatus: PayoutStatus,
  dispute: Dispute | null | undefined,
  refundedPercent: number,
): string {
  if (isDisputed) return 'Streitfall aktiv — Gelder eingefroren'

  // Settled PARTIAL refund (T+80 default 75/25 OR an operator refund_partial):
  // the held remainder was returned to the customer and the released tranche
  // stays with the craftsman. This is NOT a full refund — never 'Vollständig
  // erstattet'. The percentages come from the actual refunded-tranche amount
  // (refundedPercent), so this is correct for any split, not just 75/25.
  // A held-zero default (refundedPercent === 0, escrow already fully released
  // before T+80) falls through to the normal terminal/payout summary below.
  if (
    dispute?.decision === 'refund' &&
    dispute.resolutionType === 'refund_partial' &&
    dispute.settlementStatus === 'settled' &&
    refundedPercent > 0
  ) {
    const retainedPercent = Math.max(0, 100 - refundedPercent)
    return `Teilrückerstattung – ${refundedPercent} % erstattet, ${retainedPercent} % einbehalten`
  }

  if (isTerminal) {
    if (plan?.status === 'refunded') return 'Vollständig erstattet'
    if (plan?.status === 'cancelled') return 'Storniert'
    if (plan?.status === 'fully_released') {
      // Payout-aware terminal summary — escrow released ≠ bank payout confirmed.
      // Every PayoutStatus value is handled explicitly; no fallback to success text.
      if (payoutStatus === 'payout_completed') return 'Ausgezahlt'
      if (payoutStatus === 'payout_in_transit') return 'Auszahlung läuft'
      if (payoutStatus === 'transfer_triggered') return 'Auszahlung in Bearbeitung'
      if (payoutStatus === 'payout_failed') return 'Auszahlung fehlgeschlagen — Klärung läuft'
      if (payoutStatus === 'transfer_reversed') return 'Überweisung storniert — Klärung nötig'
      if (payoutStatus === 'payout_unknown') return 'Klärung erforderlich'
      if (payoutStatus === 'payout_blocked') return 'Auszahlung blockiert'
      return 'Vollständig freigegeben'
    }
    return 'Abgeschlossen'
  }

  if (fundingStatus === 'funding_expired') return 'Zahlungsanfrage abgelaufen'
  if (fundingStatus === 'customer_not_paid') return 'Kundenzahlung ausstehend'
  if (fundingStatus === 'payment_processing') return 'Einzahlung wird verarbeitet'
  if (fundingStatus === 'funding_failed') return 'Einzahlung fehlgeschlagen'
  if (fundingStatus === 'no_escrow_plan') return 'Kein Zahlungsplan erstellt'

  const parts: string[] = []
  parts.push(FUNDING_STATUS_LABELS[fundingStatus])

  if (releasedPercent > 0 && releasedPercent < 100) {
    parts.push(`${releasedPercent} % freigegeben`)
  }

  if (releasableAmount > 0) {
    parts.push(`${formatEuro(releasableAmount)} freigabefähig`)
  }

  if (blockingReason !== 'none') {
    parts.push(BLOCKING_REASON_LABELS[blockingReason])
  }

  return parts.join(' · ')
}

// ── Convenience: resolve from stores ────────────────────────────────────────

import { getJobById } from '../jobs/service.js'
import { getPaymentForJob } from './service.js'
import { getEscrowPlanByJobId, getEscrowTranches } from './escrow/escrowService.js'
import { getFundingRequestByJobId } from './fundingRequest/index.js'
import { getDisputeByJobId } from '../disputes/disputesService.js'
import { getAcceptanceByJobId } from '../acceptance/service.js'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver.js'
import { getTimelineSignals } from '../timeline/index.js'
import { derivePayoutOutcomesByTransfer } from './payoutOutcomeSelectors.js'

/**
 * Convenience function that reads from all stores and derives the projection.
 *
 * Use this in UI components. For tests or pure contexts, use
 * deriveMoneyFlowProjection() directly with explicit inputs.
 *
 * @param jobId               The job ID to project
 * @param providerPayoutAccount  Optional: pass from caller if already fetched.
 *                               The payout account is async-fetched and not in
 *                               a synchronous store, so the caller should provide it.
 */
export function resolveMoneyFlowProjection(
  jobId: string,
  providerPayoutAccount?: ProviderPayoutAccount | null
): MoneyFlowProjection | null {
  const job = getJobById(jobId)
  if (!job) return null

  const escrowPlan = getEscrowPlanByJobId(jobId) ?? null
  const tranches = escrowPlan ? getEscrowTranches(escrowPlan.id) : []
  const payment = getPaymentForJob(jobId) ?? null
  const fundingRequest = getFundingRequestByJobId(jobId)
  const dispute = getDisputeByJobId(jobId) ?? null
  const acceptance = getAcceptanceByJobId(jobId)

  // Canonical amount includes ChangeOrder deltas. Passed explicitly so
  // deriveMoneyFlowProjection stays a pure function (no store reads inside).
  const canonicalAmount = resolveCanonicalAmount(jobId)

  const payoutOutcomesByTransfer = derivePayoutOutcomesByTransfer(getTimelineSignals(), jobId)

  return deriveMoneyFlowProjection({
    job,
    escrowPlan,
    tranches,
    payment,
    dispute,
    providerPayoutAccount: providerPayoutAccount ?? null,
    fundingRequestStatus: fundingRequest?.status,
    acceptanceExpiresAt: acceptance?.expiresAt,
    canonicalTotalAmount: canonicalAmount.amount,
    payoutOutcomesByTransfer,
  })
}
