import type { Payment, PaymentState } from '../payments/types'
import type { LedgerEntry } from '../payments/ledger/ledgerTypes'
import type { SupplementaryPaymentRequest } from '../payments/supplementary/types'
import type { PayoutStatus } from '../payments/moneyFlowProjection'
import { isPaymentPayoutEligible } from './payoutEligibility'
import { canProviderReceivePayout } from './paymentGatingRules'
import { derivePayoutReadinessStatus } from './selectors'
import type { ProviderPayoutAccount, PayoutReadinessStatus } from './types'
import { resolveJobFeeRate } from '../shared/feeRate'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import { resolveCanonicalProjectFacts } from '../shared/canonicalProjectFacts'
import { getEscrowPlanByJobId, getEscrowTranches } from '../payments/escrow/escrowService'
import { isEffectivelyEligible } from '../payments/escrow/trancheTrigger'
import { getJobById } from '../jobs/jobsStore'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-job breakdown of a craftsman's payout position.
 *
 * `isExact: true` means `netAmount` and `platformFee` come from matching
 * ledger entries (released payments). `false` means they are estimates
 * derived from `totalAmount × rate` and must be displayed as approximate.
 *
 * Note: `released` means the payment was released in the SaFix system and
 * the net amount was earmarked for the craftsman's Stripe Connect account.
 * It does NOT mean the funds have reached the craftsman's bank account —
 * that depends on Stripe's automatic payout schedule.
 */
export type CraftsmanPayoutJobEntry = {
  jobId: string
  paymentId: string
  /** Resolved job title for display (from project → offer → job fallback). */
  jobTitle: string
  state: PaymentState
  grossAmount: number
  /** Net amount after platform fee. Exact when `isExact`, estimated otherwise. */
  netAmount: number
  /** Platform fee portion. Exact when `isExact`, estimated otherwise. */
  platformFee: number
  /**
   * True when `netAmount` and `platformFee` come from ledger entries.
   * False when derived as estimates for unreleased payments.
   */
  isExact: boolean
  /** True when state is released AND payout account is payout-ready. */
  payoutEligible: boolean
  /**
   * German explanation when state is released but account cannot receive payout.
   * Null for non-released payments or when payout is unblocked.
   */
  blockingReason: string | null
}

/**
 * Craftsman-scoped payout transparency summary.
 *
 * Aggregates payment state into five mutually exclusive buckets.
 * All amounts are in EUR as plain numbers (not formatted strings).
 *
 * IMPORTANT: `releasedPayoutEligible` and `releasedPayoutBlocked` mean the
 * payment was released in SaFix and the net amount was earmarked for the
 * craftsman's Stripe Connect account. Actual bank transfer timing is
 * controlled by Stripe's payout schedule — not surfaced here.
 */
export type CraftsmanPayoutSummary = {
  // ── Bucket sums ────────────────────────────────────────────────────────────

  /**
   * Gross amounts in active escrow (states: in_escrow, work_in_progress).
   * Customer has funded but work is in progress — payout not yet triggered.
   */
  inEscrowGross: number
  /** Estimated craftsman net for inEscrow bucket (not from ledger). */
  inEscrowNetEstimated: number

  /**
   * Estimated net for escrow-tranche-eligible amounts (tranche status:
   * eligible_for_release). Derived from escrow tranche data, not the legacy
   * Payment entity. This amount is subtracted from inEscrowNetEstimated to
   * prevent "releasable" funds from being hidden under "gesichert".
   */
  releasableNetEstimated: number

  /**
   * Gross amounts awaiting customer release (state: release_pending).
   * Work is done; customer has not yet confirmed release.
   */
  releasePendingGross: number
  /** Estimated craftsman net for releasePending bucket (not from ledger). */
  releasePendingNetEstimated: number

  /**
   * Exact net amounts for released payments where the payout account is ready.
   * Source: ledger `payout` or `dispute_resolved_release` entries.
   */
  releasedPayoutEligible: number

  /**
   * Exact net amounts for released payments where the payout account is NOT
   * ready. Source: ledger `payout` or `dispute_resolved_release` entries.
   * These amounts are earmarked in Stripe Connect but cannot be paid out until
   * the account setup is complete.
   */
  releasedPayoutBlocked: number

  /**
   * Exact net amounts for released money whose Stripe payout subsequently
   * FAILED or whose transfer was REVERSED — i.e. the job's MoneyFlowProjection
   * `payoutStatus` is `payout_failed` or `transfer_reversed`. MoneyFlowProjection
   * is the single source of truth for the payout OUTCOME; this bucket exists so
   * those amounts are EXCLUDED from `releasedPayoutEligible` and never surfaced
   * as "In Auszahlung" / "Auf deinem Konto". The money is not on its way to the
   * craftsman — it needs clarification.
   */
  releasedPayoutReversedFailed: number

  /**
   * Gross amounts frozen under active dispute (state: disputed).
   * Source: ledger `dispute_hold` entry if present, otherwise payment gross.
   */
  disputedGross: number

  // ── Platform-fee transparency ───────────────────────────────────────────────

  /** Sum of exact `platform_fee` ledger entries for released payments. */
  platformFeeCollected: number
  /**
   * Estimated platform fee for unreleased payments (inEscrow + releasePending
   * + disputed). Computed as `grossAmount × resolveJobFeeRate(jobId)` (5 % or 9 %).
   */
  platformFeeEstimated: number

  // ── Supplementary payment buckets ────────────────────────────────────────────

  /**
   * Net amount from released supplementary payments (transferred to Connect account).
   * Source: ledger `supplementary_payout` entries when available, else estimated.
   */
  supplementaryReleased: number

  /**
   * Estimated net amount from funded-but-not-released supplementary payments.
   * Money collected from customer but not yet transferred to craftsman.
   */
  supplementaryAwaitingRelease: number

  /**
   * Gross amount of supplementary payments still pending customer payment
   * (pending, acknowledged, funding_initiated).
   */
  supplementaryPending: number

  // ── Payout account gate ─────────────────────────────────────────────────────

  /** Readiness status of the craftsman's payout account. */
  payoutReadiness: PayoutReadinessStatus
  /**
   * German explanation why payout is blocked, when applicable.
   * Null when account is payout-ready or no payments are blocked.
   */
  payoutBlockingReason: string | null

  // ── Per-job detail ──────────────────────────────────────────────────────────

  /** One entry per craftsman-owned payment, covering all non-refunded states. */
  perJob: CraftsmanPayoutJobEntry[]
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Payment states that count as "active escrow" (not yet release_pending). */
const ESCROW_ACTIVE_STATES: ReadonlySet<PaymentState> = new Set([
  'in_escrow',
  'work_in_progress',
])

function roundEur(value: number): number {
  return Number(value.toFixed(2))
}

/**
 * Returns the ledger entry that represents the net craftsman release amount
 * for a given payment. For standard releases this is `payout`; for
 * dispute-resolved releases this is `dispute_resolved_release`.
 *
 * The two types are mutually exclusive per payment (both are NON_REPEATING_TYPES
 * in the linear payment lifecycle), so the first match is the correct answer.
 */
function findReleaseEntry(entries: LedgerEntry[]): LedgerEntry | undefined {
  return entries.find(
    (e) => e.type === 'payout' || e.type === 'dispute_resolved_release'
  )
}

function findFeeEntry(entries: LedgerEntry[]): LedgerEntry | undefined {
  return entries.find((e) => e.type === 'platform_fee')
}

function findDisputeHoldEntry(entries: LedgerEntry[]): LedgerEntry | undefined {
  return entries.find((e) => e.type === 'dispute_hold')
}

function resolveJobTitle(jobId: string): string {
  return resolveCanonicalProjectFacts(jobId)?.title ?? jobId
}

/**
 * Reads the escrow plan + tranches for a job and returns the gross sum of
 * already-released tranches that have a persisted external_release_ref
 * (Stripe Transfer ID). This is the proof that funds have left the platform
 * escrow and arrived at the provider's Connected Account, so this portion
 * must NOT be aggregated as "gesichert" anymore.
 *
 * Returns zero gross (and undefined plan) when no plan exists — callers can
 * then fall back to the legacy whole-payment treatment.
 */
function splitTrancheGrossByReleaseProof(jobId: string): {
  plan: ReturnType<typeof getEscrowPlanByJobId> | undefined
  tranches: ReturnType<typeof getEscrowTranches>
  releasedGross: number
} {
  const plan = getEscrowPlanByJobId(jobId)
  if (!plan) {
    return { plan: undefined, tranches: [], releasedGross: 0 }
  }
  const tranches = getEscrowTranches(plan.id)
  let releasedGross = 0
  for (const t of tranches) {
    if (t.status === 'released' && t.externalReleaseRef != null && t.transferReversalRef == null) {
      releasedGross += t.amount
    }
  }
  return { plan, tranches, releasedGross }
}

// ── Main selector ─────────────────────────────────────────────────────────────

/**
 * Derives a craftsman-scoped payout transparency summary from canonical
 * payment and ledger data.
 *
 * CONTRACT
 * --------
 * - No side effects. Reads from stores for canonical amounts (resolveCanonicalAmount)
 *   and fee rates (resolveJobFeeRate) — same hierarchy as MoneyFlowProjection.
 * - Filters strictly by `payment.craftsmanUserId === craftsmanUserId`.
 * - `released` payments use exact ledger amounts; all others use estimates.
 * - Five buckets are mutually exclusive: a payment lands in exactly one.
 * - Refunded payments are excluded from all positive buckets.
 *
 * @param craftsmanUserId         Supabase auth user ID of the craftsman.
 * @param payments                Full payment list (will be filtered internally).
 * @param ledger                  Full ledger entry list (will be filtered per payment).
 * @param payoutAccount           Live payout account snapshot from Stripe Connect API,
 *                                or null when not yet fetched / account does not exist.
 * @param supplementaryPayments   All supplementary payment requests (will be filtered internally).
 * @param payoutStatusByPaymentId Per-payment payout OUTCOME from MoneyFlowProjection
 *                                (`payoutStatus`), keyed by `payment.id`. This is the
 *                                single source of truth for the payout outcome: a value
 *                                of `payout_failed` / `transfer_reversed` diverts released
 *                                net out of the eligible/blocked buckets into
 *                                `releasedPayoutReversedFailed`, so a reversed/failed
 *                                payout is never shown as "In Auszahlung". When a payment
 *                                is absent from the map (e.g. pure-data test context with
 *                                no stores), the legacy account-gated bucketing applies.
 */
export function deriveCraftsmanPayoutSummary(
  craftsmanUserId: string,
  payments: Payment[],
  ledger: LedgerEntry[],
  payoutAccount: ProviderPayoutAccount | null,
  supplementaryPayments: SupplementaryPaymentRequest[] = [],
  payoutStatusByPaymentId: ReadonlyMap<string, PayoutStatus> = new Map(),
): CraftsmanPayoutSummary {
  // Build a per-payment ledger index for O(1) lookup.
  const ledgerByPaymentId = new Map<string, LedgerEntry[]>()
  for (const entry of ledger) {
    const list = ledgerByPaymentId.get(entry.paymentId)
    if (list) {
      list.push(entry)
    } else {
      ledgerByPaymentId.set(entry.paymentId, [entry])
    }
  }

  // Derive payout account gate once — applies uniformly to all released payments.
  const payoutReadiness = derivePayoutReadinessStatus(payoutAccount)
  const gatingSummary = canProviderReceivePayout(payoutAccount)
  const accountBlockingReason = gatingSummary.allowed ? null : gatingSummary.explanation

  // Accumulate bucket totals.
  let inEscrowGross = 0
  let inEscrowNetEstimated = 0
  let releasableNetEstimated = 0
  let releasePendingGross = 0
  let releasePendingNetEstimated = 0
  let releasedPayoutEligible = 0
  let releasedPayoutBlocked = 0
  let releasedPayoutReversedFailed = 0
  let disputedGross = 0
  let platformFeeCollected = 0
  let platformFeeEstimated = 0

  const perJob: CraftsmanPayoutJobEntry[] = []

  // Filter to this craftsman's payments only.
  const craftsmanPayments = payments.filter(
    (p) => p.craftsmanUserId === craftsmanUserId
  )

  for (const payment of craftsmanPayments) {
    const { state } = payment
    // Canonical amount: EscrowPlan → Offer → Job → payment.amounts fallback.
    // Aligns with MoneyFlowProjection's amount source hierarchy so Finance
    // surfaces and Job Detail never show different totals for the same job.
    const gross = resolveCanonicalAmount(payment.jobId).amount ?? payment.amounts.totalAmount
    const paymentLedger = ledgerByPaymentId.get(payment.id) ?? []

    const jobTitle = resolveJobTitle(payment.jobId)

    // Outcome truth from MoneyFlowProjection.payoutStatus (single source of
    // truth for the payout OUTCOME). A failed bank payout or a reversed transfer
    // must NOT be bucketed as eligible/received — it is diverted to
    // releasedPayoutReversedFailed below. Absent (no map / no stores) → legacy
    // account-gated bucketing is preserved.
    const outcomeStatus = payoutStatusByPaymentId.get(payment.id) ?? null
    const outcomeReversedOrFailed =
      outcomeStatus === 'payout_failed' || outcomeStatus === 'transfer_reversed'

    // ── Refunded: excluded from positive buckets ────────────────────────────
    if (state === 'refunded') {
      perJob.push({
        jobId: payment.jobId,
        paymentId: payment.id,
        jobTitle,
        state,
        grossAmount: gross,
        netAmount: 0,
        platformFee: 0,
        isExact: true,
        payoutEligible: false,
        blockingReason: null,
      })
      continue
    }

    // ── Released: exact amounts from ledger ─────────────────────────────────
    if (state === 'released') {
      const releaseEntry = findReleaseEntry(paymentLedger)
      const feeEntry = findFeeEntry(paymentLedger)
      const isExact = releaseEntry !== undefined

      const jobFeeRate = resolveJobFeeRate(payment.jobId)
      const netAmount = isExact
        ? releaseEntry!.amount
        : roundEur(gross * (1 - jobFeeRate))
      const platformFee = feeEntry !== undefined
        ? feeEntry.amount
        : roundEur(gross * jobFeeRate)

      const eligible = isPaymentPayoutEligible(payment, payoutAccount)
      const blockingReason = eligible ? null : accountBlockingReason

      if (outcomeReversedOrFailed) {
        // Stripe payout failed or transfer reversed — never "In Auszahlung".
        releasedPayoutReversedFailed += netAmount
      } else if (eligible) {
        releasedPayoutEligible += netAmount
      } else {
        releasedPayoutBlocked += netAmount
      }

      // Fee is already collected at release regardless of payout readiness.
      platformFeeCollected += platformFee

      perJob.push({
        jobId: payment.jobId,
        paymentId: payment.id,
        jobTitle,
        state,
        grossAmount: gross,
        netAmount,
        platformFee,
        isExact,
        payoutEligible: eligible && !outcomeReversedOrFailed,
        blockingReason,
      })
      continue
    }

    // ── Disputed: frozen, own bucket ────────────────────────────────────────
    if (state === 'disputed') {
      const holdEntry = findDisputeHoldEntry(paymentLedger)
      const disputedAmount = holdEntry !== undefined ? holdEntry.amount : gross
      const isExact = holdEntry !== undefined

      const jobFeeRate = resolveJobFeeRate(payment.jobId)
      disputedGross += disputedAmount
      platformFeeEstimated += roundEur(disputedAmount * jobFeeRate)

      perJob.push({
        jobId: payment.jobId,
        paymentId: payment.id,
        jobTitle,
        state,
        grossAmount: disputedAmount,
        netAmount: roundEur(disputedAmount * (1 - jobFeeRate)),
        platformFee: roundEur(disputedAmount * jobFeeRate),
        isExact,
        payoutEligible: false,
        blockingReason: null,
      })
      continue
    }

    // ── Active escrow (in_escrow, work_in_progress): estimated ──────────────
    // Check escrow tranches for:
    //   1. Already-released tranches with proven Stripe Transfer ID
    //      (externalReleaseRef) — these belong in the released bucket, not
    //      "gesichert", because the money is no longer in escrow.
    //   2. Eligible-for-release tranches — broken out so they don't get hidden
    //      under the generic "gesichert" bucket.
    if (ESCROW_ACTIVE_STATES.has(state)) {
      const jobFeeRate = resolveJobFeeRate(payment.jobId)

      const split = splitTrancheGrossByReleaseProof(payment.jobId)

      const releasedNet = roundEur(split.releasedGross * (1 - jobFeeRate))
      const releasedFee = roundEur(split.releasedGross * jobFeeRate)

      const remainingGross = Math.max(0, gross - split.releasedGross)
      const remainingNet = roundEur(remainingGross * (1 - jobFeeRate))
      const remainingFee = roundEur(remainingGross * jobFeeRate)

      // Releasable subset: only count from the still-unreleased portion.
      // Payout-blocked tranches must NOT appear as "releasable".
      let releasableGrossForJob = 0
      if (split.plan && gatingSummary.allowed) {
        const jobForTrigger = getJobById(payment.jobId)
        const jobStatusForTrigger = jobForTrigger?.status
        for (const t of split.tranches) {
          if (t.status === 'released') continue
          if (
            t.status === 'release_pending' ||
            isEffectivelyEligible(t, jobStatusForTrigger)
          ) {
            releasableGrossForJob += t.amount
          }
        }
      }
      const releasableNetForJob = roundEur(releasableGrossForJob * (1 - jobFeeRate))
      const nonReleasableNet = roundEur(remainingNet - releasableNetForJob)

      // Released-with-proof portion: lift out of escrow into released bucket.
      if (split.releasedGross > 0) {
        if (outcomeReversedOrFailed) {
          // A proven transfer whose bank payout failed (webhook outcome) —
          // keep it out of the eligible bucket.
          releasedPayoutReversedFailed += releasedNet
        } else if (gatingSummary.allowed) {
          releasedPayoutEligible += releasedNet
        } else {
          releasedPayoutBlocked += releasedNet
        }
        // The fee for transferred tranches is already collected by the platform
        // (Stripe netted it from the source charge). No ledger row exists yet,
        // but the money movement is proven by externalReleaseRef.
        platformFeeCollected += releasedFee
      }

      // Remaining portion stays in escrow / releasable.
      inEscrowGross += remainingGross
      inEscrowNetEstimated += nonReleasableNet
      releasableNetEstimated += releasableNetForJob
      platformFeeEstimated += remainingFee

      perJob.push({
        jobId: payment.jobId,
        paymentId: payment.id,
        jobTitle,
        state,
        grossAmount: gross,
        netAmount: roundEur(gross * (1 - jobFeeRate)),
        platformFee: roundEur(gross * jobFeeRate),
        isExact: false,
        payoutEligible: false,
        blockingReason: null,
      })
      continue
    }

    // ── Release pending: estimated ───────────────────────────────────────────
    // After a partial tranche release the plan is partially_released and the
    // workflow advances payment.state to 'release_pending'. Released tranches
    // with a persisted Stripe Transfer reference must be lifted into the
    // released bucket so the Finance hero never claims the transferred portion
    // is still "gesichert".
    if (state === 'release_pending') {
      const jobFeeRate = resolveJobFeeRate(payment.jobId)

      const split = splitTrancheGrossByReleaseProof(payment.jobId)

      const releasedNet = roundEur(split.releasedGross * (1 - jobFeeRate))
      const releasedFee = roundEur(split.releasedGross * jobFeeRate)

      const pendingGross = Math.max(0, gross - split.releasedGross)
      const pendingNet = roundEur(pendingGross * (1 - jobFeeRate))
      const pendingFee = roundEur(pendingGross * jobFeeRate)

      if (split.releasedGross > 0) {
        if (outcomeReversedOrFailed) {
          releasedPayoutReversedFailed += releasedNet
        } else if (gatingSummary.allowed) {
          releasedPayoutEligible += releasedNet
        } else {
          releasedPayoutBlocked += releasedNet
        }
        platformFeeCollected += releasedFee
      }

      releasePendingGross += pendingGross
      releasePendingNetEstimated += pendingNet
      platformFeeEstimated += pendingFee

      perJob.push({
        jobId: payment.jobId,
        paymentId: payment.id,
        jobTitle,
        state,
        grossAmount: gross,
        netAmount: roundEur(gross * (1 - jobFeeRate)),
        platformFee: roundEur(gross * jobFeeRate),
        isExact: false,
        payoutEligible: false,
        blockingReason: null,
      })
      continue
    }

    // ── deposit_required / deposit_paid / none: pre-escrow, no payout relevance
    // Include for completeness but contribute 0 to buckets.
    perJob.push({
      jobId: payment.jobId,
      paymentId: payment.id,
      jobTitle,
      state,
      grossAmount: gross,
      netAmount: 0,
      platformFee: 0,
      isExact: false,
      payoutEligible: false,
      blockingReason: null,
    })
  }

  // ── Supplementary payments ────────────────────────────────────────────────
  // Filter to this craftsman's supplementary payments.
  const craftsmanSupplementary = supplementaryPayments.filter(
    (s) => s.craftsmanUserId === craftsmanUserId
  )

  let supplementaryReleased = 0
  let supplementaryAwaitingRelease = 0
  let supplementaryPending = 0

  for (const spr of craftsmanSupplementary) {
    const grossEur = spr.amountCents / 100
    const jobFeeRate = resolveJobFeeRate(spr.jobId)

    if (spr.status === 'released') {
      // Check for exact ledger entry
      const sprLedger = ledgerByPaymentId.get(spr.originalPaymentId) ?? []
      const payoutEntry = sprLedger.find(
        (e) => e.type === 'supplementary_payout' && e.note?.includes(spr.id)
      )
      const netAmount = payoutEntry
        ? payoutEntry.amount
        : roundEur(grossEur * (1 - jobFeeRate))
      supplementaryReleased += netAmount

      // Fee from released supplementary
      const feeEntry = sprLedger.find(
        (e) => e.type === 'supplementary_platform_fee' && e.note?.includes(spr.id)
      )
      platformFeeCollected += feeEntry ? feeEntry.amount : roundEur(grossEur * jobFeeRate)
    } else if (spr.status === 'funded') {
      supplementaryAwaitingRelease += roundEur(grossEur * (1 - jobFeeRate))
      platformFeeEstimated += roundEur(grossEur * jobFeeRate)
    } else if (spr.status === 'pending' || spr.status === 'acknowledged' || spr.status === 'funding_initiated') {
      supplementaryPending += grossEur
    }
    // paid, waived: no payout impact
  }

  return {
    inEscrowGross: roundEur(inEscrowGross),
    inEscrowNetEstimated: roundEur(inEscrowNetEstimated),
    releasableNetEstimated: roundEur(releasableNetEstimated),
    releasePendingGross: roundEur(releasePendingGross),
    releasePendingNetEstimated: roundEur(releasePendingNetEstimated),
    releasedPayoutEligible: roundEur(releasedPayoutEligible),
    releasedPayoutBlocked: roundEur(releasedPayoutBlocked),
    releasedPayoutReversedFailed: roundEur(releasedPayoutReversedFailed),
    disputedGross: roundEur(disputedGross),
    supplementaryReleased: roundEur(supplementaryReleased),
    supplementaryAwaitingRelease: roundEur(supplementaryAwaitingRelease),
    supplementaryPending: roundEur(supplementaryPending),
    platformFeeCollected: roundEur(platformFeeCollected),
    platformFeeEstimated: roundEur(platformFeeEstimated),
    payoutReadiness,
    payoutBlockingReason: accountBlockingReason,
    perJob,
  }
}
