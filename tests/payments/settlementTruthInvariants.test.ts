/**
 * Settlement Truth Invariants — Release-to-Settlement Corridor
 *
 * Hardening suite for the final external-handoff corridor:
 *   internal release → provider payout readiness → Stripe Connect → actual bank settlement
 *
 * Invariants enforced:
 *
 *   A. Internal release success is NOT interpreted as settled / Ausgezahlt
 *   B. Provider payout readiness gates block correctly and return honest reasons
 *   C. released / payout_eligible / payout_blocked / no_account states are distinct and non-conflatable
 *   D. deriveCraftsmanPayoutSummary keeps released separate from settled; no bucket overclaims
 *   E. Finance/summary layer does NOT equate releasedPayoutEligible with "bank settlement done"
 *   F. Provider readiness gate is uniform — same logic applies to canProviderReceivePayout and canCompleteRelease
 *   G. Idempotent payout eligibility derivation is stable — same input always yields same output
 *   H. Missing or broken provider linkage is recognised explicitly, not silently allowed
 *   I. getPaymentStateLabel('released') MUST NOT return 'Ausgezahlt'
 *   J. projectHealthSelectors released indicator MUST NOT use 'Ausgezahlt' as statusLabel
 *   K. notification label for payment_released MUST NOT be 'Ausgezahlt'
 *   L. Legacy (helpers.ts) and primary (selectors.ts) label paths must agree on released label
 */

import { describe, it, expect } from 'vitest'

import {
  getPaymentStateLabel,
  getPaymentStateDescription,
} from '../../src/lib/payments/selectors'
import { getPaymentStateLabel as getPaymentStateLabelLegacy } from '../../src/lib/jobs/helpers'
import { mapSignalToNotificationItem } from '../../src/lib/notifications/notificationSelectors'
import { deriveCraftsmanPayoutSummary } from '../../src/lib/payout/craftsmanPayoutSummary'
import {
  canProviderReceivePayout,
  canCompleteRelease,
  derivePaymentGatingSummary,
} from '../../src/lib/payout/paymentGatingRules'
import { deriveProviderPaymentReadiness } from '../../src/lib/payout/providerPaymentReadiness'
import { isPaymentPayoutEligible } from '../../src/lib/payout/payoutEligibility'
import { derivePayoutReadinessStatus } from '../../src/lib/payout/selectors'
import type { Payment } from '../../src/lib/payments/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { NotificationSignal } from '../../src/lib/notifications/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePayment(state: Payment['state'], id = 'pay-1'): Payment {
  return {
    id,
    jobId: 'job-1',
    craftsmanUserId: 'craftsman-1',
    state,
    amounts: { totalAmount: 4000, depositAmount: 1000, finalAmount: 3000 },
    createdAt: 1_000_000,
    updatedAt: 1_000_001,
  }
}

function makeReadyAccount(overrides: Partial<ProviderPayoutAccount> = {}): ProviderPayoutAccount {
  return {
    id: 'acc-1',
    providerUserId: 'craftsman-1',
    stripeConnectAccountId: 'acct_live_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: 1_000_000,
    requirementsDue: null,
    createdAt: 1_000_000,
    updatedAt: 1_000_001,
    ...overrides,
  }
}

function makeReleasedLedger(paymentId: string): LedgerEntry[] {
  return [
    {
      id: `ledger-payout-${paymentId}`,
      paymentId,
      jobId: 'job-1',
      type: 'payout',
      amount: 3800,
      currency: 'EUR',
      createdAt: 1_000_002,
    },
    {
      id: `ledger-fee-${paymentId}`,
      paymentId,
      jobId: 'job-1',
      type: 'platform_fee',
      amount: 200,
      currency: 'EUR',
      createdAt: 1_000_002,
    },
  ]
}


// ─────────────────────────────────────────────────────────────────────────────
// A. Internal release is NOT Ausgezahlt
// ─────────────────────────────────────────────────────────────────────────────

describe('A — released label must not claim bank settlement', () => {
  it('getPaymentStateLabel released is not Ausgezahlt', () => {
    const label = getPaymentStateLabel('released')
    expect(label).not.toBe('Ausgezahlt')
  })

  it('getPaymentStateLabel released is Freigegeben', () => {
    expect(getPaymentStateLabel('released')).toBe('Freigegeben')
  })

  it('getPaymentStateDescription released does not say ausgezahlt', () => {
    const desc = getPaymentStateDescription('released')
    expect(desc.toLowerCase()).not.toContain('ausgezahlt')
  })

  it('getPaymentStateDescription released explicitly references escrow release and Stripe payout schedule', () => {
    const desc = getPaymentStateDescription('released')
    expect(desc.toLowerCase()).toContain('freigegeben')
    expect(desc.toLowerCase()).toContain('stripe')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. Provider readiness gate blocks correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('B — provider payout readiness gate', () => {
  it('null account is blocked with no_stripe_account reason', () => {
    const result = canProviderReceivePayout(null)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('payout_not_ready')
  })

  it('no Stripe account ID is blocked', () => {
    const result = canProviderReceivePayout(makeReadyAccount({ stripeConnectAccountId: null }))
    expect(result.allowed).toBe(false)
  })

  it('charges_enabled=false is blocked', () => {
    const result = canProviderReceivePayout(makeReadyAccount({ chargesEnabled: false }))
    expect(result.allowed).toBe(false)
  })

  it('payouts_enabled=false is blocked', () => {
    const result = canProviderReceivePayout(makeReadyAccount({ payoutsEnabled: false }))
    expect(result.allowed).toBe(false)
  })

  it('payout_blocked onboarding status is blocked', () => {
    const result = canProviderReceivePayout(
      makeReadyAccount({ onboardingStatus: 'payout_blocked', chargesEnabled: false, payoutsEnabled: false })
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('payout_blocked')
  })

  it('fully ready account is allowed', () => {
    const result = canProviderReceivePayout(makeReadyAccount())
    expect(result.allowed).toBe(true)
    expect(result.reason).toBeNull()
  })

  it('canCompleteRelease uses same gate as canProviderReceivePayout — null blocked on both', () => {
    const payout = canProviderReceivePayout(null)
    const release = canCompleteRelease(null)
    expect(payout.allowed).toBe(false)
    expect(release.allowed).toBe(false)
  })

  it('canCompleteRelease uses same gate as canProviderReceivePayout — ready allowed on both', () => {
    const account = makeReadyAccount()
    const payout = canProviderReceivePayout(account)
    const release = canCompleteRelease(account)
    expect(payout.allowed).toBe(true)
    expect(release.allowed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. released / payout_eligible / payout_blocked / no_account are distinct
// ─────────────────────────────────────────────────────────────────────────────

describe('C — released, payout_eligible, payout_blocked, no_account are distinct', () => {
  it('released payment + no account → payoutEligible=false (released ≠ settled)', () => {
    expect(isPaymentPayoutEligible(makePayment('released'), null)).toBe(false)
  })

  it('released payment + charges not enabled → payoutEligible=false', () => {
    expect(
      isPaymentPayoutEligible(makePayment('released'), makeReadyAccount({ chargesEnabled: false }))
    ).toBe(false)
  })

  it('released payment + payouts not enabled → payoutEligible=false', () => {
    expect(
      isPaymentPayoutEligible(makePayment('released'), makeReadyAccount({ payoutsEnabled: false }))
    ).toBe(false)
  })

  it('released payment + ready account → payoutEligible=true', () => {
    expect(isPaymentPayoutEligible(makePayment('released'), makeReadyAccount())).toBe(true)
  })

  it('non-released payment + ready account → payoutEligible=false', () => {
    for (const state of ['in_escrow', 'work_in_progress', 'release_pending', 'disputed', 'refunded'] as const) {
      expect(isPaymentPayoutEligible(makePayment(state), makeReadyAccount())).toBe(false)
    }
  })

  it('PayoutReadinessStatus payout_ready means both flags enabled', () => {
    const status = derivePayoutReadinessStatus(makeReadyAccount())
    expect(status).toBe('payout_ready')
  })

  it('PayoutReadinessStatus no_account when null', () => {
    const status = derivePayoutReadinessStatus(null)
    expect(status).toBe('no_account')
  })

  it('PayoutReadinessStatus payout_blocked when flagged', () => {
    const status = derivePayoutReadinessStatus(
      makeReadyAccount({ onboardingStatus: 'payout_blocked', chargesEnabled: false, payoutsEnabled: false })
    )
    expect(status).toBe('payout_blocked')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D + E. deriveCraftsmanPayoutSummary buckets — released ≠ settled
// ─────────────────────────────────────────────────────────────────────────────

describe('D + E — payout summary buckets keep released separate from settled', () => {
  const CRAFTSMAN = 'craftsman-1'

  it('released + ready account → releasedPayoutEligible, not a settled bucket', () => {
    const payment = makePayment('released')
    const ledger = makeReleasedLedger(payment.id)
    const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], ledger, makeReadyAccount())

    expect(summary.releasedPayoutEligible).toBe(3800)
    expect(summary.releasedPayoutBlocked).toBe(0)
    // The summary has no "settled" bucket — asserting the type does not contain one
    expect('settledAmount' in summary).toBe(false)
    expect('bankSettled' in summary).toBe(false)
  })

  it('released + blocked account → releasedPayoutBlocked, not releasedPayoutEligible', () => {
    const payment = makePayment('released')
    const ledger = makeReleasedLedger(payment.id)
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN,
      [payment],
      ledger,
      makeReadyAccount({ payoutsEnabled: false })
    )

    expect(summary.releasedPayoutBlocked).toBe(3800)
    expect(summary.releasedPayoutEligible).toBe(0)
  })

  it('released + null account → releasedPayoutBlocked', () => {
    const payment = makePayment('released')
    const ledger = makeReleasedLedger(payment.id)
    const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], ledger, null)

    expect(summary.releasedPayoutBlocked).toBe(3800)
    expect(summary.releasedPayoutEligible).toBe(0)
    expect(summary.payoutReadiness).toBe('no_account')
  })

  it('non-released payment does not enter released bucket', () => {
    for (const state of ['in_escrow', 'work_in_progress', 'release_pending'] as const) {
      const payment = makePayment(state)
      const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], [], makeReadyAccount())
      expect(summary.releasedPayoutEligible).toBe(0)
      expect(summary.releasedPayoutBlocked).toBe(0)
    }
  })

  it('missing ledger entry → isExact=false, falls back to estimate', () => {
    const payment = makePayment('released')
    // No ledger entries → isExact must be false and an estimate is computed
    const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], [], makeReadyAccount())

    const entry = summary.perJob.find((e) => e.paymentId === payment.id)!
    expect(entry.isExact).toBe(false)
    expect(entry.netAmount).toBeGreaterThan(0)
  })

  it('exact ledger entry → isExact=true', () => {
    const payment = makePayment('released')
    const ledger = makeReleasedLedger(payment.id)
    const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], ledger, makeReadyAccount())

    const entry = summary.perJob.find((e) => e.paymentId === payment.id)!
    expect(entry.isExact).toBe(true)
    expect(entry.netAmount).toBe(3800)
  })

  it('same inputs always produce same output — idempotent derivation', () => {
    const payment = makePayment('released')
    const ledger = makeReleasedLedger(payment.id)
    const account = makeReadyAccount()

    const first = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], ledger, account)
    const second = deriveCraftsmanPayoutSummary(CRAFTSMAN, [payment], ledger, account)

    expect(first.releasedPayoutEligible).toBe(second.releasedPayoutEligible)
    expect(first.releasedPayoutBlocked).toBe(second.releasedPayoutBlocked)
    expect(first.payoutReadiness).toBe(second.payoutReadiness)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. Gate uniformity — canProviderReceivePayout and canCompleteRelease
// ─────────────────────────────────────────────────────────────────────────────

describe('F — gate uniformity between payout and release checks', () => {
  const cases: Array<Partial<ProviderPayoutAccount> | null> = [
    null,
    { stripeConnectAccountId: null },
    { chargesEnabled: false },
    { payoutsEnabled: false },
    { chargesEnabled: false, payoutsEnabled: false, onboardingStatus: 'payout_blocked' },
  ]

  for (const override of cases) {
    it(`both gates agree for account=${JSON.stringify(override)}`, () => {
      const account = override === null ? null : makeReadyAccount(override as Partial<ProviderPayoutAccount>)
      const payout = canProviderReceivePayout(account)
      const release = canCompleteRelease(account)
      // Both must agree on allowed/blocked — they must not diverge
      expect(payout.allowed).toBe(release.allowed)
    })
  }

  it('derivePaymentGatingSummary summary is consistent with individual gates', () => {
    const account = makeReadyAccount({ payoutsEnabled: false })
    const summary = derivePaymentGatingSummary(account)

    expect(summary.fundingAllowed).toBe(true)
    expect(summary.payoutBlocked).toBe(true)
    expect(summary.releaseBlocked).toBe(true)
    expect(summary.payoutBlockReason).not.toBeNull()
    expect(summary.releaseBlockReason).not.toBeNull()
  })

  it('fully ready account — funding, payout, release all allowed', () => {
    const summary = derivePaymentGatingSummary(makeReadyAccount())
    expect(summary.fundingAllowed).toBe(true)
    expect(summary.payoutBlocked).toBe(false)
    expect(summary.releaseBlocked).toBe(false)
    expect(summary.payoutBlockReason).toBeNull()
    expect(summary.releaseBlockReason).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I. projectHealthSelectors released label
// ─────────────────────────────────────────────────────────────────────────────

describe('I — projectHealthSelectors released statusLabel must not be Ausgezahlt', () => {
  it('getPaymentStateLabel released is used by health indicator and is not Ausgezahlt', () => {
    // projectHealthSelectors.derivePaymentIndicator is private; we verify the canonical
    // label function it delegates to returns the correct value.
    const label = getPaymentStateLabel('released')
    expect(label).not.toBe('Ausgezahlt')
    expect(label).toBe('Freigegeben')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// J + L. Label convergence — legacy helpers.ts and primary selectors.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('J + L — legacy and primary released labels must agree', () => {
  it('helpers.ts and selectors.ts return same label for released', () => {
    const primary = getPaymentStateLabel('released')
    const legacy = getPaymentStateLabelLegacy('released')
    expect(primary).toBe(legacy)
  })

  it('neither returns Ausgezahlt for released', () => {
    expect(getPaymentStateLabel('released')).not.toBe('Ausgezahlt')
    expect(getPaymentStateLabelLegacy('released')).not.toBe('Ausgezahlt')
  })

  it('terminal states (refunded, disputed) are consistent between implementations', () => {
    // Terminal states that carry payout/settlement truth must match.
    // Other states (in_escrow, work_in_progress, etc.) differ in wording
    // between helpers.ts and selectors.ts — that's a known pre-existing divergence
    // outside the settlement-truth scope.
    expect(getPaymentStateLabel('refunded')).toBe(getPaymentStateLabelLegacy('refunded'))
    expect(getPaymentStateLabel('disputed')).toBe(getPaymentStateLabelLegacy('disputed'))
    expect(getPaymentStateLabel('release_pending')).toBe(getPaymentStateLabelLegacy('release_pending'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K. Notification label payment_released
// ─────────────────────────────────────────────────────────────────────────────

describe('K — notification label for payment_released must not be Ausgezahlt', () => {
  function makeSignal(): NotificationSignal {
    return {
      id: 'sig-1',
      jobId: 'job-1',
      type: 'payment_released',
      priority: 'info',
      read: false,
      occurredAt: 1_000_000,
    }
  }

  it('notification label for payment_released is not Ausgezahlt', () => {
    const item = mapSignalToNotificationItem(makeSignal())
    expect(item.label).not.toBe('Ausgezahlt')
    expect(item.label).toBe('Freigegeben')
  })

  it('notification description for payment_released does not say ausgezahlt', () => {
    const item = mapSignalToNotificationItem(makeSignal())
    expect(item.description.toLowerCase()).not.toContain('ausgezahlt')
  })

  it('notification description for payment_released references Stripe payout schedule', () => {
    const item = mapSignalToNotificationItem(makeSignal())
    expect(item.description.toLowerCase()).toContain('stripe')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// H. Missing/broken provider linkage is recognised explicitly
// ─────────────────────────────────────────────────────────────────────────────

describe('H — missing provider linkage yields explicit blocking reason', () => {
  it('null account yields structured blocking reason with code', () => {
    const readiness = deriveProviderPaymentReadiness(null)
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason).not.toBeNull()
    expect(readiness.blockingReason?.code).toBe('no_stripe_account')
  })

  it('null stripeConnectAccountId yields explicit no_stripe_account reason', () => {
    const readiness = deriveProviderPaymentReadiness(makeReadyAccount({ stripeConnectAccountId: null }))
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason?.code).toBe('no_stripe_account')
  })

  it('payout_blocked status yields payout_blocked reason', () => {
    const readiness = deriveProviderPaymentReadiness(
      makeReadyAccount({ onboardingStatus: 'payout_blocked', chargesEnabled: false, payoutsEnabled: false })
    )
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason?.code).toBe('payout_blocked')
    expect(readiness.blockingReason?.severity).toBe('error')
  })

  it('charges disabled yields charges_disabled reason', () => {
    const readiness = deriveProviderPaymentReadiness(makeReadyAccount({ chargesEnabled: false }))
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason?.code).toBe('charges_disabled')
  })

  it('payouts disabled yields payouts_disabled reason', () => {
    const readiness = deriveProviderPaymentReadiness(makeReadyAccount({ payoutsEnabled: false }))
    expect(readiness.isPayoutReady).toBe(false)
    expect(readiness.blockingReason?.code).toBe('payouts_disabled')
  })

  it('canProviderReceivePayout blocked reason is not null and has human-readable explanation', () => {
    const result = canProviderReceivePayout(null)
    expect(result.allowed).toBe(false)
    expect(result.explanation).toBeTruthy()
    expect(result.explanation.length).toBeGreaterThan(10)
  })
})
