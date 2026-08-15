/**
 * Funded Dominance — Canonical Funded Truth Check
 *
 * Single, explicit dominance rule for funding projection cleanup:
 *
 * When canonical funded truth exists for a given funding context (keyed by
 * jobId → FundingRequest + EscrowPlan), "funded" becomes the dominant
 * visible state.  Pending / required / due / fällig projections for that
 * same context must no longer render as active calls to action.
 *
 * This utility is the ONE place that defines funded dominance. All surfaces
 * (thread cards, attention selectors, next-step selectors, chips, banners)
 * delegate to these functions instead of each re-implementing the check.
 *
 * Context scoping: every check is keyed by jobId. It does NOT suppress
 * unrelated pending payment contexts from different jobs/offers.
 *
 * Canonical funding context key (strongest → weakest):
 *   fundingRequestId → escrowPlanId → jobId → sourceOfferId
 * In the current architecture jobId is the single stable join key used by
 * FundingRequest, EscrowPlan, and all projection surfaces.
 */

import { getFundingRequestByJobId } from './fundingRequestService.js'
import { getEscrowPlanByJobId } from '../escrow/escrowService.js'

/** Escrow plan statuses that confirm the customer's payment has been secured. */
const FUNDED_ESCROW_STATUSES = new Set([
  'funded_in_escrow',
  'partially_released',
  'fully_released',
])

/**
 * Returns true when canonical funded truth exists for the given job.
 *
 * Checks two independent canonical sources (belt-and-suspenders):
 *   1. FundingRequest.status === 'funded'
 *   2. EscrowPlan.status ∈ { funded_in_escrow, partially_released, fully_released }
 *
 * If either confirms funding, the result is true.  This prevents a stale
 * FundingRequest from hiding confirmed truth that the escrow plan already
 * reflects, and vice versa.
 *
 * When this returns true, all pending/required/due/fällig projections for
 * the same funding context must yield to funded confirmation state.
 *
 * @param jobId — The job whose funding context to check
 */
export function isFundingConfirmedForJob(jobId: string): boolean {
  const fundingRequest = getFundingRequestByJobId(jobId)
  if (fundingRequest?.status === 'funded') return true

  const escrowPlan = getEscrowPlanByJobId(jobId)
  if (escrowPlan && FUNDED_ESCROW_STATUSES.has(escrowPlan.status)) return true

  return false
}
