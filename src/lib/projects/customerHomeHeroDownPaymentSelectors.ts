/**
 * Block 7.2.1a — P7 down-payment-pending derivation.
 *
 * Customer-side hero copy needs to differentiate "you owe an upfront
 * Zahlung" from "everything is funded — work is running".
 * Today both states render the same Zahlung wording. P7 fixes this by
 * gating the wording on whether ANY open down-payment-flow exists for
 * the customer.
 *
 * Sources of truth (no new DB column needed):
 *  - **FundingRequest** in non-terminal status (`sent`, `funding_started`,
 *    `funding_initiated`) — the upfront escrow flow.
 *  - **SupplementaryPaymentRequest** in non-terminal status (`pending`,
 *    `acknowledged`, `funding_initiated`) — Nachtrags-Anzahlung.
 *
 * If either domain has at least one such request for the customer, the
 * Zahlung wording stays. Otherwise the hero falls back to a neutral
 * status that does not mislead the customer into expecting a payment
 * step that does not exist.
 */

import type { FundingRequest } from '../payments/fundingRequest/types'
import type { SupplementaryPaymentRequest } from '../payments/supplementary/types'

const FUNDING_REQUEST_OPEN_STATUSES: ReadonlySet<FundingRequest['status']> = new Set([
  'sent',
  'funding_started',
  'funding_initiated',
])

const SUPPLEMENTARY_OPEN_STATUSES: ReadonlySet<SupplementaryPaymentRequest['status']> = new Set([
  'pending',
  'acknowledged',
  'funding_initiated',
])

/**
 * Returns `true` when the customer has at least one open down-payment-style
 * obligation: either a funding request awaiting payment, or a
 * supplementary payment request not yet funded.
 *
 * Both arrays may be unfiltered — the helper does the status filtering
 * itself. Either may be omitted when the corresponding domain is not
 * (yet) hydrated; the helper treats `undefined` as "no pending request".
 */
export function deriveDownPaymentRequestPending(
  fundingRequests?: ReadonlyArray<FundingRequest>,
  supplementaryPayments?: ReadonlyArray<SupplementaryPaymentRequest>,
): boolean {
  if (fundingRequests && fundingRequests.length > 0) {
    for (const fr of fundingRequests) {
      if (FUNDING_REQUEST_OPEN_STATUSES.has(fr.status)) return true
    }
  }
  if (supplementaryPayments && supplementaryPayments.length > 0) {
    for (const sp of supplementaryPayments) {
      if (SUPPLEMENTARY_OPEN_STATUSES.has(sp.status)) return true
    }
  }
  return false
}
