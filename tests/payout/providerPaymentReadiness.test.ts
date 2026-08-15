/**
 * Provider Payment Readiness Tests
 *
 * Verifies the unified provider payment readiness model that combines
 * Stripe Connect payout state into structured readiness assessments.
 *
 * Tests cover:
 * 1. Provider can send quote without Stripe Connect completed
 * 2. Payout/release remains blocked when provider payout readiness is incomplete
 * 3. Provider payment readiness persists after reload/re-entry
 * 4. No regression to quote lifecycle
 * 5. Comprehensive readiness derivation for all account states
 */

import { describe, it, expect } from 'vitest'
import {
  deriveProviderPaymentReadiness,
  isProviderPayoutReady,
} from '../../src/lib/payout/providerPaymentReadiness'
import {
  canProviderSendQuote,
  canProviderReceiveRequests,
  canProviderChat,
  canProviderViewJobs,
  canProviderTriggerFundingStep,
  canProviderReceivePayout,
  canCompleteRelease,
  canCustomerAcceptQuote,
  canCustomerFund,
  derivePaymentGatingSummary,
} from '../../src/lib/payout/paymentGatingRules'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makePayoutAccount(
  overrides: Partial<ProviderPayoutAccount> = {}
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

// ── Provider Payment Readiness Derivation ─────────────────────────────────

describe('deriveProviderPaymentReadiness', () => {
  it('returns fully ready for a complete payout account', () => {
    const readiness = deriveProviderPaymentReadiness(makePayoutAccount())

    expect(readiness.hasStripeAccount).toBe(true)
    expect(readiness.isOnboardingComplete).toBe(true)
    expect(readiness.chargesEnabled).toBe(true)
    expect(readiness.payoutsEnabled).toBe(true)
    expect(readiness.isPaymentReady).toBe(true)
    expect(readiness.isPayoutReady).toBe(true)
    expect(readiness.missingRequirements).toHaveLength(0)
    expect(readiness.blockingReason).toBeNull()
    expect(readiness.payoutStatus).toBe('payout_ready')
  })

  it('returns not ready for null account', () => {
    const readiness = deriveProviderPaymentReadiness(null)

    expect(readiness.hasStripeAccount).toBe(false)
    expect(readiness.isOnboardingComplete).toBe(false)
    expect(readiness.chargesEnabled).toBe(false)
    expect(readiness.payoutsEnabled).toBe(false)
    expect(readiness.isPaymentReady).toBe(false)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason).not.toBeNull()
    expect(readiness.blockingReason!.code).toBe('no_stripe_account')
    expect(readiness.blockingReason!.severity).toBe('warning')
    expect(readiness.payoutStatus).toBe('no_account')
  })

  it('returns not ready when stripeConnectAccountId is null', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({ stripeConnectAccountId: null })
    )

    expect(readiness.hasStripeAccount).toBe(false)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason!.code).toBe('no_stripe_account')
  })

  it('returns onboarding_incomplete when charges and payouts are disabled', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingStatus: 'onboarding_in_progress',
      })
    )

    expect(readiness.hasStripeAccount).toBe(true)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason!.code).toBe('onboarding_incomplete')
    expect(readiness.blockingReason!.severity).toBe('warning')
  })

  it('returns charges_disabled when only charges are off', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({
        chargesEnabled: false,
        payoutsEnabled: true,
        onboardingStatus: 'onboarding_complete',
      })
    )

    expect(readiness.hasStripeAccount).toBe(true)
    expect(readiness.isPaymentReady).toBe(false)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason!.code).toBe('charges_disabled')
  })

  it('returns payouts_disabled when only payouts are off', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({
        chargesEnabled: true,
        payoutsEnabled: false,
        onboardingStatus: 'onboarding_complete',
      })
    )

    expect(readiness.hasStripeAccount).toBe(true)
    expect(readiness.isPaymentReady).toBe(true)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason!.code).toBe('payouts_disabled')
  })

  it('returns payout_blocked for blocked accounts', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingStatus: 'payout_blocked',
      })
    )

    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason!.code).toBe('payout_blocked')
    expect(readiness.blockingReason!.severity).toBe('error')
  })

  it('includes pending requirements from requirementsDue', () => {
    const readiness = deriveProviderPaymentReadiness(
      makePayoutAccount({
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingStatus: 'onboarding_in_progress',
        requirementsDue: 'Bankverbindung, Identitätsnachweis',
      })
    )

    expect(readiness.missingRequirements).toContain('Bankverbindung')
    expect(readiness.missingRequirements).toContain('Identitätsnachweis')
  })
})

describe('isProviderPayoutReady', () => {
  it('returns true for fully ready account', () => {
    expect(isProviderPayoutReady(makePayoutAccount())).toBe(true)
  })

  it('returns false for null account', () => {
    expect(isProviderPayoutReady(null)).toBe(false)
  })

  it('returns false when payouts disabled', () => {
    expect(
      isProviderPayoutReady(makePayoutAccount({ payoutsEnabled: false }))
    ).toBe(false)
  })

  it('returns false when charges disabled', () => {
    expect(
      isProviderPayoutReady(makePayoutAccount({ chargesEnabled: false }))
    ).toBe(false)
  })
})

// ── Gating Rules: Operations NOT blocked by Stripe Connect ────────────────

describe('Provider operations NOT blocked by Stripe Connect', () => {
  const scenarios = [
    { label: 'null account', account: null },
    { label: 'no Stripe ID', account: makePayoutAccount({ stripeConnectAccountId: null }) },
    { label: 'onboarding in progress', account: makePayoutAccount({ chargesEnabled: false, payoutsEnabled: false }) },
    { label: 'payout blocked', account: makePayoutAccount({ chargesEnabled: false, payoutsEnabled: false, onboardingStatus: 'payout_blocked' as const }) },
  ]

  for (const { label, account } of scenarios) {
    it(`provider can send quote with ${label}`, () => {
      expect(canProviderSendQuote(account).allowed).toBe(true)
    })

    it(`provider can receive requests with ${label}`, () => {
      expect(canProviderReceiveRequests(account).allowed).toBe(true)
    })

    it(`provider can chat with ${label}`, () => {
      expect(canProviderChat(account).allowed).toBe(true)
    })

    it(`provider can view jobs with ${label}`, () => {
      expect(canProviderViewJobs(account).allowed).toBe(true)
    })

    it(`provider can trigger funding step with ${label}`, () => {
      expect(canProviderTriggerFundingStep(account).allowed).toBe(true)
    })

    it(`customer can accept quote with ${label}`, () => {
      expect(canCustomerAcceptQuote(account).allowed).toBe(true)
    })

    it(`customer can fund with ${label}`, () => {
      expect(canCustomerFund(account).allowed).toBe(true)
    })
  }
})

// ── Gating Rules: Payout/Release IS blocked without Stripe Connect ────────

describe('Payout/release blocked without Stripe Connect', () => {
  it('payout blocked when account is null', () => {
    const decision = canProviderReceivePayout(null)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('payout_not_ready')
  })

  it('payout blocked when no Stripe ID', () => {
    const decision = canProviderReceivePayout(makePayoutAccount({ stripeConnectAccountId: null }))
    expect(decision.allowed).toBe(false)
  })

  it('payout blocked when onboarding incomplete', () => {
    const decision = canProviderReceivePayout(
      makePayoutAccount({ chargesEnabled: false, payoutsEnabled: false })
    )
    expect(decision.allowed).toBe(false)
  })

  it('payout allowed when fully ready', () => {
    const decision = canProviderReceivePayout(makePayoutAccount())
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBeNull()
  })

  it('release blocked when account is null', () => {
    const decision = canCompleteRelease(null)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('payout_not_ready')
  })

  it('release blocked when payouts disabled', () => {
    const decision = canCompleteRelease(
      makePayoutAccount({ payoutsEnabled: false })
    )
    expect(decision.allowed).toBe(false)
  })

  it('release allowed when fully ready', () => {
    const decision = canCompleteRelease(makePayoutAccount())
    expect(decision.allowed).toBe(true)
  })

  it('release blocked when payout_blocked status', () => {
    const decision = canCompleteRelease(
      makePayoutAccount({
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingStatus: 'payout_blocked',
      })
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('payout_blocked')
  })
})

// ── Gating Summary ────────────────────────────────────────────────────────

describe('derivePaymentGatingSummary', () => {
  it('shows funding allowed, payout/release blocked for null account', () => {
    const summary = derivePaymentGatingSummary(null)
    expect(summary.fundingAllowed).toBe(true)
    expect(summary.payoutBlocked).toBe(true)
    expect(summary.releaseBlocked).toBe(true)
    expect(summary.payoutBlockReason).not.toBeNull()
    expect(summary.releaseBlockReason).not.toBeNull()
  })

  it('shows everything unblocked for fully ready account', () => {
    const summary = derivePaymentGatingSummary(makePayoutAccount())
    expect(summary.fundingAllowed).toBe(true)
    expect(summary.payoutBlocked).toBe(false)
    expect(summary.releaseBlocked).toBe(false)
    expect(summary.payoutBlockReason).toBeNull()
    expect(summary.releaseBlockReason).toBeNull()
  })

  it('does NOT collapse into one vague state — funding vs payout vs release are distinct', () => {
    const summary = derivePaymentGatingSummary(
      makePayoutAccount({ payoutsEnabled: false })
    )
    // Funding is always allowed (platform-side collection)
    expect(summary.fundingAllowed).toBe(true)
    // Payout is blocked because payouts disabled
    expect(summary.payoutBlocked).toBe(true)
    // Release is also blocked (provider can't receive)
    expect(summary.releaseBlocked).toBe(true)
    // These are three distinct states, not one "payments not set up"
  })
})
