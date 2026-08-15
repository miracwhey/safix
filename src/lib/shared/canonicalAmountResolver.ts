/**
 * Canonical Amount Resolver
 *
 * Resolves the single canonical monetary amount for a job/order context.
 *
 * AMOUNT HIERARCHY (strongest to weakest):
 *
 *   1. EscrowPlan.totalAmount   — after escrow plan creation, this is the
 *      binding payment basis (aligned with accepted offer at creation time)
 *   2. Accepted Offer price     — after acceptance, the offer is the binding
 *      commercial basis (parsed via parseJobAmount)
 *   3. Job.amount               — client-side copy, may be stale or empty
 *      after reload; used only as last fallback
 *
 * No surface should derive its own commercial total independently.
 * All surfaces should call resolveCanonicalAmount() or consume its result.
 *
 * CHANGE ORDER DELTA:
 *   After a base amount is resolved, accepted ChangeOrders for the job are
 *   summed as deltas (positive = additional cost, negative = credit).
 *   This is the canonical read path for ChangeOrder runtime truth.
 */

import { getJobById } from '../jobs/service'
import { parseJobAmount } from '../jobs/parseJobAmount'
import { getOfferById, getAcceptedOfferByJobId } from '../offers/service'
import { getEscrowPlanByJobId, getEscrowPlanByOfferId } from '../payments/escrow/escrowService'
import { getChangeOrdersByJobId } from '../changeOrders/service'
import { formatEuro } from './formatters'

export type AmountSource = 'escrow' | 'offer' | 'job' | 'none'

export type CanonicalAmount = {
  /** Numeric euro amount, or null if no amount can be resolved */
  amount: number | null
  /** Formatted euro string (e.g. "2.300,00 €"), or empty string */
  formatted: string
  /** Which entity the amount was resolved from */
  source: AmountSource
}

/**
 * Sums the grossTotal of all accepted ChangeOrders for a job.
 * Returns 0 if there are no accepted ChangeOrders or none have a grossTotal set.
 * ChangeOrder.grossTotal is in the same currency unit (cents) as the base amount.
 */
function resolveChangeOrderDelta(jobId: string): number {
  return getChangeOrdersByJobId(jobId)
    .filter((co) => co.status === 'accepted' && co.grossTotal != null)
    .reduce((sum, co) => sum + (co.grossTotal ?? 0), 0)
}

/**
 * Resolves the canonical monetary amount for a given job.
 *
 * Resolution order:
 *   1. EscrowPlan (by jobId, then by sourceOfferId)
 *   2. Accepted offer (by sourceOfferId, then reverse lookup by jobId)
 *   3. Job.amount (fallback only)
 *   + Delta: accepted ChangeOrders are added to the resolved base amount.
 */
export function resolveCanonicalAmount(jobId: string): CanonicalAmount {
  const job = getJobById(jobId)
  if (!job) return { amount: null, formatted: '', source: 'none' }

  // 1. Escrow plan — strongest source after creation
  const sourceOfferId = job.sourceOfferId
  const escrowPlan = getEscrowPlanByJobId(jobId)
    ?? (sourceOfferId ? getEscrowPlanByOfferId(sourceOfferId) : undefined)

  if (escrowPlan && escrowPlan.totalAmount > 0) {
    const base = escrowPlan.totalAmount
    const delta = resolveChangeOrderDelta(jobId)
    const total = base + delta
    return {
      amount: total,
      formatted: formatEuro(total),
      source: 'escrow',
    }
  }

  // 2. Accepted offer — binding commercial basis after acceptance
  const offer = sourceOfferId
    ? getOfferById(sourceOfferId)
    : getAcceptedOfferByJobId(jobId)

  if (offer?.price) {
    const parsed = parseJobAmount(offer.price)
    if (parsed !== null && parsed > 0) {
      const delta = resolveChangeOrderDelta(jobId)
      const total = parsed + delta
      return {
        amount: total,
        formatted: formatEuro(total),
        source: 'offer',
      }
    }
  }

  // 3. Job.amount — fallback only (may be stale or empty)
  const jobAmount = parseJobAmount(job.amount)
  if (jobAmount !== null && jobAmount > 0) {
    const delta = resolveChangeOrderDelta(jobId)
    const total = jobAmount + delta
    return {
      amount: total,
      formatted: formatEuro(total),
      source: 'job',
    }
  }

  return { amount: null, formatted: '', source: 'none' }
}
