import { describe, it, expect } from 'vitest'
import { isPaymentPayoutEligible } from '../../src/lib/payout/payoutEligibility'
import type { Payment } from '../../src/lib/payments/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

function makePayment(state: Payment['state']): Payment {
  return {
    id: 'pay-test',
    jobId: 'job-test',
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makePayoutAccount(
  overrides: Partial<ProviderPayoutAccount> = {},
): ProviderPayoutAccount {
  return {
    id: 'payout-acc-1',
    providerUserId: 'user-1',
    stripeConnectAccountId: 'acct_test123',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('isPaymentPayoutEligible', () => {
  it('returns true when payment is released and account is payout_ready', () => {
    expect(
      isPaymentPayoutEligible(makePayment('released'), makePayoutAccount()),
    ).toBe(true)
  })

  it('returns false when payment is not released (in_escrow)', () => {
    expect(
      isPaymentPayoutEligible(makePayment('in_escrow'), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when payment is not released (work_in_progress)', () => {
    expect(
      isPaymentPayoutEligible(makePayment('work_in_progress'), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when payment is not released (release_pending)', () => {
    expect(
      isPaymentPayoutEligible(makePayment('release_pending'), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when payment is not released (disputed)', () => {
    expect(
      isPaymentPayoutEligible(makePayment('disputed'), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when payment is not released (refunded)', () => {
    expect(
      isPaymentPayoutEligible(makePayment('refunded'), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when payment is released but payout account is null', () => {
    expect(
      isPaymentPayoutEligible(makePayment('released'), null),
    ).toBe(false)
  })

  it('returns false when payment is released but account has no stripe ID', () => {
    expect(
      isPaymentPayoutEligible(
        makePayment('released'),
        makePayoutAccount({ stripeConnectAccountId: null }),
      ),
    ).toBe(false)
  })

  it('returns false when payment is released but account charges not enabled', () => {
    expect(
      isPaymentPayoutEligible(
        makePayment('released'),
        makePayoutAccount({ chargesEnabled: false }),
      ),
    ).toBe(false)
  })

  it('returns false when payment is released but account payouts not enabled', () => {
    expect(
      isPaymentPayoutEligible(
        makePayment('released'),
        makePayoutAccount({ payoutsEnabled: false }),
      ),
    ).toBe(false)
  })

  it('returns false when payment is released but account is payout_blocked', () => {
    expect(
      isPaymentPayoutEligible(
        makePayment('released'),
        makePayoutAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'payout_blocked',
        }),
      ),
    ).toBe(false)
  })

  it('returns false when payment is deposit_required and account is payout_ready', () => {
    expect(
      isPaymentPayoutEligible(makePayment('deposit_required'), makePayoutAccount()),
    ).toBe(false)
  })
})
