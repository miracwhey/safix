import type { Payment } from '../payments/types'
import type { ProviderPayoutAccount } from './types'
import { isPayoutEligible } from './selectors'

/**
 * A payment is payout-eligible when:
 * 1. The payment has been released (state === 'released')
 * 2. The provider has a connected, payout-ready Stripe account
 */
export function isPaymentPayoutEligible(
  payment: Payment,
  payoutAccount: ProviderPayoutAccount | null
): boolean {
  return payment.state === 'released' && isPayoutEligible(payoutAccount)
}
