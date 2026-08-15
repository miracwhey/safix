/**
 * Canonical Commercial Display Context
 *
 * Resolves semantically separated commercial/payment amounts for UI
 * surfaces so they never derive their own meaning ad hoc.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AMOUNT SEMANTICS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * orderValue         — the agreed commercial basis for the job
 *                      (canonical hierarchy: escrow → offer → job)
 *
 * escrowTotal        — total amount held in escrow (when escrow exists,
 *                      always equals order value in full-upfront model)
 *
 * fundingAmount      — how much the customer funds (100 % upfront)
 *
 * depositRelease     — first tranche: 25 % released at work start
 *
 * finalRelease       — second tranche: 75 % released at completion
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RULES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. orderValue ≡ escrowTotal ≡ fundingAmount (full-upfront escrow model)
 * 2. depositRelease + finalRelease ≡ escrowTotal (release split, not
 *    customer payment split)
 * 3. All surfaces must use this context instead of reading
 *    payment.amounts directly
 * 4. Context is scoped by jobId — different jobs are independent
 */

import { resolveCanonicalAmount, type CanonicalAmount } from './canonicalAmountResolver'
import { getEscrowPlanByJobId } from '../payments/escrow/escrowService'
import { calculateTrancheAmounts } from '../payments/escrow/escrowService'
import { formatEuro } from './formatters'

// ── Types ─────────────────────────────────────────────────────────────────

export type CommercialDisplayContext = {
  /** Canonical order value from resolveCanonicalAmount() */
  orderValue: CanonicalAmount

  /** Whether an escrow plan exists for this job */
  hasEscrow: boolean

  /** Escrow total amount (euros), null if no escrow */
  escrowTotal: number | null

  /** Escrow total formatted, empty string if no escrow */
  escrowTotalFormatted: string

  /**
   * Customer funding amount: always 100 % of order value in the
   * full-upfront escrow model.  Null before escrow plan exists.
   */
  fundingAmount: number | null

  /** Customer funding amount formatted */
  fundingAmountFormatted: string

  /**
   * First release tranche: 25 % of escrow total, released at work start.
   * Null before escrow plan exists.
   */
  depositRelease: number | null

  /** First release tranche formatted */
  depositReleaseFormatted: string

  /**
   * Second release tranche: 75 % of escrow total, released at completion.
   * Null before escrow plan exists.
   */
  finalRelease: number | null

  /** Second release tranche formatted */
  finalReleaseFormatted: string

  /**
   * Whether orderValue, escrowTotal, and fundingAmount all agree.
   * True when no escrow exists (only orderValue stands), or when all
   * three are equal.
   */
  amountsAligned: boolean
}

// ── Resolver ──────────────────────────────────────────────────────────────

/**
 * Resolves the canonical commercial display context for a job.
 *
 * All payment/commercial display surfaces should consume this context
 * instead of independently reading payment.amounts, escrow plan fields,
 * or job.amount.
 */
export function resolveCommercialDisplayContext(jobId: string): CommercialDisplayContext {
  const orderValue = resolveCanonicalAmount(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)

  const hasEscrow = escrowPlan != null && escrowPlan.totalAmount > 0
  const escrowTotal = hasEscrow ? escrowPlan.totalAmount : null
  const escrowTotalFormatted = escrowTotal !== null ? formatEuro(escrowTotal) : ''

  // Full-upfront model: customer funds 100 % of the escrow total
  const fundingAmount = escrowTotal
  const fundingAmountFormatted = fundingAmount !== null ? formatEuro(fundingAmount) : ''

  // Release tranches: 25 % deposit release + 75 % final release
  let depositRelease: number | null = null
  let depositReleaseFormatted = ''
  let finalRelease: number | null = null
  let finalReleaseFormatted = ''

  if (escrowTotal !== null) {
    const tranches = calculateTrancheAmounts(escrowTotal)
    depositRelease = tranches.depositAmount
    depositReleaseFormatted = formatEuro(tranches.depositAmount)
    finalRelease = tranches.finalAmount
    finalReleaseFormatted = formatEuro(tranches.finalAmount)
  }

  const amountsAligned =
    escrowTotal === null ||
    orderValue.amount === null ||
    escrowTotal === orderValue.amount

  return {
    orderValue,
    hasEscrow,
    escrowTotal,
    escrowTotalFormatted,
    fundingAmount,
    fundingAmountFormatted,
    depositRelease,
    depositReleaseFormatted,
    finalRelease,
    finalReleaseFormatted,
    amountsAligned,
  }
}
