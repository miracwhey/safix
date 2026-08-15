/**
 * Sub-block 5.2 — CraftsmanPayoutSummarySection Verdrahtungs-Tests
 *
 * Covers:
 *   A. Verdrahtung — central buckets are rendered from selector output
 *   B. Blocking / Readiness — blocking reason shown/hidden correctly
 *   C. Exact vs. Estimated — tag wording distinguishes ledger vs. estimate
 *   D. Regression — existing payout card behaviour unaffected
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import CraftsmanPayoutSummarySection from '../../src/components/finance/CraftsmanPayoutSummarySection'
import { deriveCraftsmanPayoutSummary } from '../../src/lib/payout/craftsmanPayoutSummary'
import type { CraftsmanPayoutSummary, ProviderPayoutAccount } from '../../src/lib/payout'
import type { Payment } from '../../src/lib/payments/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEmptySummary(
  overrides: Partial<CraftsmanPayoutSummary> = {}
): CraftsmanPayoutSummary {
  return {
    inEscrowGross: 0,
    inEscrowNetEstimated: 0,
    releasePendingGross: 0,
    releasePendingNetEstimated: 0,
    releasedPayoutEligible: 0,
    releasedPayoutBlocked: 0,
    releasedPayoutReversedFailed: 0,
    disputedGross: 0,
    platformFeeCollected: 0,
    platformFeeEstimated: 0,
    supplementaryReleased: 0,
    supplementaryAwaitingRelease: 0,
    supplementaryPending: 0,
    payoutReadiness: 'payout_ready',
    payoutBlockingReason: null,
    perJob: [],
    ...overrides,
  }
}

function makeReadyAccount(): ProviderPayoutAccount {
  return {
    id: 'acct-1',
    providerUserId: 'user-1',
    stripeConnectAccountId: 'acct_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: 1000,
    requirementsDue: null,
    createdAt: 1000,
    updatedAt: 1000,
  }
}

function makeBlockedAccount(): ProviderPayoutAccount {
  return {
    ...makeReadyAccount(),
    payoutsEnabled: false,
    // 'payout_blocked' is the only onboardingStatus that produces
    // payoutReadiness === 'payout_blocked' from derivePayoutReadinessStatus
    onboardingStatus: 'payout_blocked',
  }
}

function makePayment(
  id: string,
  state: Payment['state'],
  craftsmanUserId: string,
  totalAmount: number
): Payment {
  return {
    id,
    jobId: `job-${id}`,
    craftsmanUserId,
    customerUserId: 'customer-1',
    state,
    amounts: {
      totalAmount,
      depositAmount: 0,
      escrowAmount: totalAmount,
      platformFeeAmount: 0,
      netPayoutAmount: 0,
    },
    stripePaymentIntentId: null,
    stripeTransferId: null,
    createdAt: 1000,
    updatedAt: 1000,
  }
}

function makeLedgerEntry(
  paymentId: string,
  type: LedgerEntry['type'],
  amount: number
): LedgerEntry {
  return {
    id: `ledger-${paymentId}-${type}`,
    paymentId,
    jobId: `job-${paymentId}`,
    type,
    amount,
    createdAt: 1000,
  }
}

function render(summary: CraftsmanPayoutSummary, onSetup?: () => void): string {
  return renderToString(
    React.createElement(CraftsmanPayoutSummarySection, { summary, onSetup })
  )
}

// ── A. Verdrahtung ────────────────────────────────────────────────────────────

describe('A. Verdrahtung — buckets rendered from selector output', () => {
  it('renders "In Auszahlung" row for releasedPayoutEligible', () => {
    const summary = makeEmptySummary({ releasedPayoutEligible: 880 })
    const html = render(summary)
    expect(html).toContain('In Auszahlung')
  })

  it('renders the formatted eligible amount', () => {
    const summary = makeEmptySummary({ releasedPayoutEligible: 880 })
    const html = render(summary)
    // German locale: 880,00 €
    expect(html).toContain('880')
  })

  it('renders releasedPayoutBlocked row when blocked amount > 0', () => {
    const summary = makeEmptySummary({ releasedPayoutBlocked: 440 })
    const html = render(summary)
    expect(html).toContain('Aktion nötig')
  })

  it('does not render blocked row when releasedPayoutBlocked is 0', () => {
    const summary = makeEmptySummary({ releasedPayoutBlocked: 0 })
    const html = render(summary)
    expect(html).not.toContain('Aktion nötig')
  })

  it('renders "In Klärung" row for releasedPayoutReversedFailed and keeps it out of "In Auszahlung"', () => {
    const summary = makeEmptySummary({ releasedPayoutReversedFailed: 880 })
    const html = render(summary)
    expect(html).toContain('In Klärung')
    expect(html).toContain('880')
    // The reversed/failed amount must NOT inflate the "In Auszahlung" row,
    // which renders from releasedPayoutEligible (= 0 here).
    const inAuszahlungIdx = html.indexOf('In Auszahlung')
    const inKlaerungIdx = html.indexOf('In Klärung')
    expect(inAuszahlungIdx).toBeGreaterThanOrEqual(0)
    expect(inKlaerungIdx).toBeGreaterThan(inAuszahlungIdx)
  })

  it('does not render "In Klärung" row when releasedPayoutReversedFailed is 0', () => {
    const summary = makeEmptySummary({ releasedPayoutReversedFailed: 0 })
    const html = render(summary)
    expect(html).not.toContain('In Klärung')
  })

  it('renders inEscrow row when inEscrowGross > 0', () => {
    const summary = makeEmptySummary({
      inEscrowGross: 1000,
      inEscrowNetEstimated: 880,
    })
    const html = render(summary)
    expect(html).toContain('Gesichert')
  })

  it('does not render inEscrow row when inEscrowGross is 0', () => {
    const summary = makeEmptySummary({ inEscrowGross: 0 })
    const html = render(summary)
    expect(html).not.toContain('Gesichert')
  })

  it('renders releasePending as part of "Gesichert" bucket', () => {
    const summary = makeEmptySummary({
      releasePendingGross: 500,
      releasePendingNetEstimated: 440,
    })
    const html = render(summary)
    expect(html).toContain('Gesichert')
    expect(html).toContain('440')
  })

  it('does not render "Gesichert" row when all secured amounts are 0', () => {
    const summary = makeEmptySummary({
      releasePendingGross: 0,
      releasePendingNetEstimated: 0,
      inEscrowNetEstimated: 0,
    })
    const html = render(summary)
    expect(html).not.toContain('Gesichert')
  })

  it('renders disputed row when disputedGross > 0', () => {
    const summary = makeEmptySummary({ disputedGross: 300 })
    const html = render(summary)
    expect(html).toContain('Eingefroren')
  })

  it('does not render disputed row when disputedGross is 0', () => {
    const summary = makeEmptySummary({ disputedGross: 0 })
    const html = render(summary)
    expect(html).not.toContain('Eingefroren')
  })

  it('integrates with deriveCraftsmanPayoutSummary output directly', () => {
    const craftsmanId = 'craftsman-a'
    const payment = makePayment('p1', 'released', craftsmanId, 1000)
    const ledger: LedgerEntry[] = [
      makeLedgerEntry('p1', 'platform_fee', 120),
      makeLedgerEntry('p1', 'payout', 880),
    ]
    const summary = deriveCraftsmanPayoutSummary(
      craftsmanId,
      [payment],
      ledger,
      makeReadyAccount()
    )

    const html = render(summary)
    expect(html).toContain('In Auszahlung')
    expect(html).toContain('880')
  })
})

// ── B. Blocking / Readiness ───────────────────────────────────────────────────

describe('B. Blocking / Readiness — blocking reason shown and hidden correctly', () => {
  it('shows blocking reason banner when payoutReadiness is payout_blocked', () => {
    const summary = makeEmptySummary({
      payoutReadiness: 'payout_blocked',
      payoutBlockingReason: 'Dein Stripe-Konto hat offene Anforderungen.',
    })
    const html = render(summary)
    expect(html).toContain('Dein Stripe-Konto hat offene Anforderungen.')
  })

  it('shows blocking reason text from selector via blocked account', () => {
    const craftsmanId = 'craftsman-b'
    const payment = makePayment('p2', 'released', craftsmanId, 500)
    const ledger: LedgerEntry[] = [
      makeLedgerEntry('p2', 'platform_fee', 60),
      makeLedgerEntry('p2', 'payout', 440),
    ]
    const summary = deriveCraftsmanPayoutSummary(
      craftsmanId,
      [payment],
      ledger,
      makeBlockedAccount()
    )

    const html = render(summary)
    // Blocked account → payoutBlockingReason is set → shown in UI
    expect(summary.payoutBlockingReason).not.toBeNull()
    expect(html).toContain(summary.payoutBlockingReason!)
  })

  it('does not show blocking banner when payoutReadiness is payout_ready', () => {
    const summary = makeEmptySummary({
      payoutReadiness: 'payout_ready',
      payoutBlockingReason: null,
    })
    const html = render(summary)
    expect(html).not.toContain('data-testid="payout-blocking-reason"')
  })

  it('shows onSetup button inside blocking banner when onSetup is provided', () => {
    const summary = makeEmptySummary({
      payoutReadiness: 'payout_blocked',
      payoutBlockingReason: 'Offene Anforderungen.',
    })
    const html = render(summary, () => {})
    expect(html).toContain('Auszahlungskonto einrichten →')
  })

  it('does not show onSetup button when no onSetup handler provided', () => {
    const summary = makeEmptySummary({
      payoutReadiness: 'payout_blocked',
      payoutBlockingReason: 'Offene Anforderungen.',
    })
    const html = render(summary) // no onSetup
    expect(html).not.toContain('Auszahlungskonto einrichten →')
  })
})

// ── C. Exact vs. Estimated ────────────────────────────────────────────────────

describe('C. Tag wording — simplified 4-bucket model', () => {
  it('releasedPayoutEligible carries "Übergeben" tag', () => {
    const summary = makeEmptySummary({ releasedPayoutEligible: 880 })
    const html = render(summary)
    expect(html).toContain('Übergeben')
  })

  it('releasedPayoutBlocked carries "Blockiert" tag', () => {
    const summary = makeEmptySummary({ releasedPayoutBlocked: 440 })
    const html = render(summary)
    expect(html).toContain('Blockiert')
  })

  it('inEscrow merged into "Gesichert" with "Sicher" tag', () => {
    const summary = makeEmptySummary({
      inEscrowGross: 1000,
      inEscrowNetEstimated: 880,
    })
    const html = render(summary)
    expect(html).toContain('Sicher')
    expect(html).toContain('Gesichert')
  })

  it('releasePending merged into "Gesichert" with "Sicher" tag', () => {
    const summary = makeEmptySummary({
      releasePendingGross: 500,
      releasePendingNetEstimated: 440,
    })
    const html = render(summary)
    expect(html).toContain('Sicher')
  })

  it('disputed carries "Konflikt" tag', () => {
    const summary = makeEmptySummary({ disputedGross: 300 })
    const html = render(summary)
    expect(html).toContain('Konflikt')
  })

  it('"Gesichert" row not tagged "Übergeben"', () => {
    const summary = makeEmptySummary({
      inEscrowGross: 1000,
      inEscrowNetEstimated: 880,
      releasedPayoutEligible: 0,
      releasedPayoutBlocked: 0,
    })
    const html = render(summary)
    const gesichertIdx = html.indexOf('Gesichert')
    const sicherIdx = html.indexOf('Sicher')
    expect(sicherIdx).toBeGreaterThan(gesichertIdx)
  })
})

// ── D. Regression ─────────────────────────────────────────────────────────────

describe('D. Regression — component renders without crash in all states', () => {
  it('renders with all-zero summary (no payments)', () => {
    const summary = makeEmptySummary()
    expect(() => render(summary)).not.toThrow()
  })

  it('renders with all buckets populated', () => {
    const summary = makeEmptySummary({
      releasedPayoutEligible: 880,
      releasedPayoutBlocked: 440,
      inEscrowGross: 1000,
      inEscrowNetEstimated: 880,
      releasePendingGross: 500,
      releasePendingNetEstimated: 440,
      disputedGross: 300,
      platformFeeCollected: 120,
      platformFeeEstimated: 216,
      payoutReadiness: 'payout_blocked',
      payoutBlockingReason: 'Konto gesperrt.',
    })
    expect(() => render(summary)).not.toThrow()
    const html = render(summary)
    expect(html).toContain('In Auszahlung')
    expect(html).toContain('Aktion nötig')
    expect(html).toContain('Gesichert')
    expect(html).toContain('Eingefroren')
  })

  it('renders platform fee note when fees are present', () => {
    const summary = makeEmptySummary({
      platformFeeCollected: 120,
      platformFeeEstimated: 60,
    })
    const html = render(summary)
    expect(html).toContain('SaFix-Gebühr')
    expect(html).toContain('120')
  })

  it('does not render platform fee note when both fees are zero', () => {
    const summary = makeEmptySummary({
      platformFeeCollected: 0,
      platformFeeEstimated: 0,
    })
    const html = render(summary)
    expect(html).not.toContain('SaFix-Gebühr')
  })

  it('renders with no_account payoutReadiness without crash', () => {
    const summary = makeEmptySummary({ payoutReadiness: 'no_account' })
    expect(() => render(summary)).not.toThrow()
  })
})
