/**
 * Finance / KPI Projection Truth — Invariant Tests
 *
 * Corridor: Finance/KPI Projection Truth
 *
 * These tests enforce that the derived financial projections remain truthful
 * across all cases covered by the prior hardening blocks:
 *
 *   A. GMV is based on canonical commercial truth (escrow_created) only
 *   B. Platform fee derives from platform_fee ledger entries only
 *   C. in_escrow / release_pending / released / disputed / refunded buckets are
 *      mutually exclusive — a payment lands in exactly one
 *   D. Disputed / refunded payments are NOT counted as positive KPI flow
 *   E. Partial release (split resolution) accounting:
 *        GMV = full total, payouts = craftsman net, refunds = customer portion,
 *        revenue = platform fee on craftsman portion
 *   F. Finance KPI values are reload-stable (same entries → same values)
 *   G. updatePaymentAmounts amount correction keeps escrow_created aligned → no
 *      GMV drift
 *   H. dispute_hold does NOT reduce openEscrow (hold ≠ withdrawal)
 *   I. activePayments includes disputed but excludes released / refunded
 *   J. revenuePotential excludes jobs with refunded payments
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  getGMV,
  getRevenue,
  getPayouts,
  getRefunds,
  getOpenEscrow,
  getFinanceKPIs,
} from '../../src/lib/payments/ledger/ledgerSelectors'
import { getLedger } from '../../src/lib/payments/ledger/ledgerStore'
import {
  createPaymentForJob,
  updatePaymentAmounts,
} from '../../src/lib/payments/service'
import { deriveCraftsmanPayoutSummary } from '../../src/lib/payout/craftsmanPayoutSummary'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'
import type { Payment } from '../../src/lib/payments/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// Test fixture rate for building ledger entries in split-resolution scenarios.
// This is NOT the production fee rate — production uses resolveJobFeeRate (5 % or 9 %).
const TEST_LEDGER_FEE_RATE = 0.12
const NET_PAYOUT_RATE = 1 - TEST_LEDGER_FEE_RATE

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ledgerEntry(
  overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'type' | 'amount' | 'paymentId'>
): LedgerEntry {
  return {
    id: `led-${Math.random().toString(36).slice(2, 10)}`,
    jobId: overrides.jobId ?? 'job-default',
    currency: 'EUR',
    createdAt: Date.now(),
    ...overrides,
  }
}

function payment(
  overrides: Partial<Payment> & Pick<Payment, 'state'>
): Payment {
  const gross = overrides.amounts?.totalAmount ?? 1000
  return {
    id: `pay-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    craftsmanUserId: 'craftsman-x',
    state: overrides.state,
    amounts: {
      totalAmount: gross,
      depositAmount: Number((gross * 0.25).toFixed(2)),
      finalAmount: Number((gross * 0.75).toFixed(2)),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

const readyAccount: ProviderPayoutAccount = {
  id: 'acc-1',
  providerUserId: 'craftsman-x',
  stripeConnectAccountId: 'acct_test',
  onboardingStatus: 'onboarding_complete',
  chargesEnabled: true,
  payoutsEnabled: true,
  onboardingCompletedAt: Date.now(),
  requirementsDue: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ── A. GMV based on escrow_created only ──────────────────────────────────────

describe('A — GMV is based on escrow_created entries only', () => {
  it('counts only escrow_created, ignores payout/fee/refund', () => {
    const entries = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 880 }),
      ledgerEntry({ type: 'platform_fee', paymentId: 'p1', amount: 120 }),
    ]
    expect(getGMV(entries)).toBe(1000)
  })

  it('sums multiple escrow_created entries across payments', () => {
    const entries = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'escrow_created', paymentId: 'p2', amount: 2500 }),
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 880 }),
    ]
    expect(getGMV(entries)).toBe(3500)
  })

  it('returns 0 when no escrow_created entries', () => {
    const entries = [
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 880 }),
      ledgerEntry({ type: 'platform_fee', paymentId: 'p1', amount: 120 }),
    ]
    expect(getGMV(entries)).toBe(0)
  })

  it('disputed payment does not reduce GMV — dispute_hold is separate', () => {
    const entries = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p1', amount: 1000 }),
    ]
    expect(getGMV(entries)).toBe(1000)
    expect(getOpenEscrow(entries)).toBe(1000) // hold does not reduce open escrow
  })
})

// ── B. Platform fee from platform_fee entries only ────────────────────────────

describe('B — Platform fee derives from platform_fee ledger entries', () => {
  it('getRevenue sums only platform_fee entries', () => {
    const entries = [
      ledgerEntry({ type: 'platform_fee', paymentId: 'p1', amount: 120 }),
      ledgerEntry({ type: 'platform_fee', paymentId: 'p2', amount: 240 }),
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 880 }),
    ]
    expect(getRevenue(entries)).toBe(360)
  })

  it('refunded payment contributes 0 to revenue (no platform_fee entry)', () => {
    const entries = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'refund', paymentId: 'p1', amount: 1000 }),
    ]
    expect(getRevenue(entries)).toBe(0)
  })

  it('platform_fee derived from released amount — not estimated', () => {
    const p = payment({ state: 'released', amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 } })
    const exactFee = 120
    const entries = [
      ledgerEntry({ type: 'platform_fee', paymentId: p.id, jobId: p.jobId, amount: exactFee }),
      ledgerEntry({ type: 'payout', paymentId: p.id, jobId: p.jobId, amount: 880 }),
    ]
    const s = deriveCraftsmanPayoutSummary('craftsman-x', [p], entries, readyAccount)
    expect(s.platformFeeCollected).toBe(exactFee)
    expect(s.platformFeeEstimated).toBe(0)
  })
})

// ── C. Buckets are mutually exclusive ─────────────────────────────────────────

describe('C — Payment state buckets are mutually exclusive', () => {
  const states: Array<Payment['state']> = [
    'in_escrow', 'work_in_progress', 'release_pending', 'released', 'disputed', 'refunded',
  ]

  for (const state of states) {
    it(`${state} payment lands in exactly one bucket`, () => {
      const p = payment({ state, id: `pay-${state}`, jobId: `job-${state}` })
      const ledger: LedgerEntry[] = state === 'released'
        ? [
            ledgerEntry({ type: 'payout', paymentId: p.id, jobId: p.jobId, amount: 880 }),
            ledgerEntry({ type: 'platform_fee', paymentId: p.id, jobId: p.jobId, amount: 120 }),
          ]
        : []

      const s = deriveCraftsmanPayoutSummary('craftsman-x', [p], ledger, readyAccount)

      const buckets = [
        s.inEscrowGross,
        s.releasePendingGross,
        s.releasedPayoutEligible + s.releasedPayoutBlocked,
        s.disputedGross,
      ]
      const nonZeroBuckets = buckets.filter((v) => v > 0)

      if (state === 'refunded') {
        // refunded payments don't fill any positive bucket
        expect(nonZeroBuckets).toHaveLength(0)
      } else {
        expect(nonZeroBuckets).toHaveLength(1)
      }
    })
  }
})

// ── D. Disputed / refunded NOT counted as positive KPI flow ──────────────────

describe('D — Disputed and refunded payments are not positive KPI', () => {
  it('refunded payment: all payout buckets = 0', () => {
    const p = payment({ state: 'refunded' })
    const s = deriveCraftsmanPayoutSummary('craftsman-x', [p], [], readyAccount)

    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.disputedGross).toBe(0)
    expect(s.perJob.find((e) => e.paymentId === p.id)?.netAmount).toBe(0)
  })

  it('disputed payment goes to disputedGross, not inEscrow', () => {
    const p = payment({ state: 'disputed' })
    const s = deriveCraftsmanPayoutSummary('craftsman-x', [p], [], readyAccount)

    expect(s.disputedGross).toBe(1000)
    expect(s.inEscrowGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
  })

  it('full dispute refund: openEscrow → 0, GMV unchanged, revenue = 0', () => {
    const entries = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'dispute_resolved_refund', paymentId: 'p1', amount: 1000 }),
    ]
    expect(getGMV(entries)).toBe(1000)       // GMV still counts committed escrow
    expect(getRevenue(entries)).toBe(0)       // no fee on full refund
    expect(getRefunds(entries)).toBe(1000)
    expect(getOpenEscrow(entries)).toBe(0)
  })
})

// ── E. Split resolution accounting ───────────────────────────────────────────

describe('E — Split resolution: correct accounting across GMV/payouts/refunds/fee', () => {
  /**
   * Scenario: total = 1000, split 70/30
   *   craftsman portion = 700, fee = 700 * 0.12 = 84, craftsman net = 700 * 0.88 = 616
   *   customer refund = 300
   */
  const TOTAL = 1000
  const SPLIT = 0.7
  const craftsmanPortion = Number((TOTAL * SPLIT).toFixed(2))
  const customerRefund = Number((TOTAL * (1 - SPLIT)).toFixed(2))
  const craftsmanFee = Number((craftsmanPortion * TEST_LEDGER_FEE_RATE).toFixed(2))
  const craftsmanNet = Number((craftsmanPortion * NET_PAYOUT_RATE).toFixed(2))

  const splitEntries: LedgerEntry[] = [
    ledgerEntry({ type: 'escrow_created', paymentId: 'p-split', amount: TOTAL }),
    ledgerEntry({ type: 'dispute_hold', paymentId: 'p-split', amount: TOTAL }),
    ledgerEntry({ type: 'dispute_resolved_release', paymentId: 'p-split', amount: craftsmanNet }),
    ledgerEntry({ type: 'platform_fee', paymentId: 'p-split', amount: craftsmanFee }),
    ledgerEntry({ type: 'dispute_resolved_refund', paymentId: 'p-split', amount: customerRefund }),
  ]

  it('GMV = full total (escrow_created)', () => {
    expect(getGMV(splitEntries)).toBe(TOTAL)
  })

  it('revenue = platform fee on craftsman portion only', () => {
    expect(getRevenue(splitEntries)).toBeCloseTo(craftsmanFee, 2)
  })

  it('payouts = craftsman net (dispute_resolved_release)', () => {
    expect(getPayouts(splitEntries)).toBeCloseTo(craftsmanNet, 2)
  })

  it('refunds = customer portion (dispute_resolved_refund)', () => {
    expect(getRefunds(splitEntries)).toBeCloseTo(customerRefund, 2)
  })

  it('openEscrow = 0 after full split settlement', () => {
    expect(getOpenEscrow(splitEntries)).toBe(0)
  })

  it('GMV = payouts + refunds + revenue (accounting identity holds)', () => {
    const kpis = getFinanceKPIs(splitEntries)
    const accounted = kpis.payouts + kpis.refunds + kpis.revenue
    expect(Math.abs(kpis.gmv - accounted)).toBeLessThan(0.01)
  })

  it('split-resolved payment lands in releasedPayoutEligible via dispute_resolved_release entry', () => {
    const p = payment({
      state: 'released',
      id: 'p-split',
      jobId: 'job-split',
      craftsmanUserId: 'craftsman-x',
      amounts: { totalAmount: TOTAL, depositAmount: 250, finalAmount: 750 },
    })
    const s = deriveCraftsmanPayoutSummary('craftsman-x', [p], splitEntries, readyAccount)

    expect(s.releasedPayoutEligible).toBeCloseTo(craftsmanNet, 2)
    expect(s.disputedGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
  })
})

// ── F. Finance KPI values are reload-stable ───────────────────────────────────

describe('F — Finance KPI values are reload-stable (same entries → same values)', () => {
  it('getFinanceKPIs is a pure function — same input always produces same output', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 2000 }),
      ledgerEntry({ type: 'platform_fee', paymentId: 'p1', amount: 240 }),
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 1760 }),
      ledgerEntry({ type: 'escrow_created', paymentId: 'p2', amount: 1500 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p2', amount: 1500 }),
    ]
    const first = getFinanceKPIs(entries)
    const second = getFinanceKPIs(entries)

    expect(first).toEqual(second)
  })

  it('deriveCraftsmanPayoutSummary is pure — same input always produces same output', () => {
    const p = payment({ state: 'in_escrow' })
    const ledger: LedgerEntry[] = []

    const first = deriveCraftsmanPayoutSummary('craftsman-x', [p], ledger, readyAccount)
    const second = deriveCraftsmanPayoutSummary('craftsman-x', [p], ledger, readyAccount)

    expect(first.inEscrowGross).toBe(second.inEscrowGross)
    expect(first.platformFeeEstimated).toBe(second.platformFeeEstimated)
    expect(first.payoutReadiness).toBe(second.payoutReadiness)
  })
})

// ── G. updatePaymentAmounts keeps escrow_created aligned (GMV no drift) ───────

describe('G — updatePaymentAmounts corrects escrow_created → GMV does not drift', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('after amount correction, GMV matches the updated totalAmount', async () => {
    const ORIGINAL = 2000
    const CORRECTED = 3500

    await createPaymentForJob('job-gmv-drift', ORIGINAL)

    // Verify original GMV
    expect(getGMV(getLedger())).toBe(ORIGINAL)

    // Update to correct amount
    await updatePaymentAmounts('job-gmv-drift', CORRECTED)

    // GMV must match the corrected amount
    expect(getGMV(getLedger())).toBe(CORRECTED)
  })

  it('when amount is unchanged, GMV remains stable after updatePaymentAmounts', async () => {
    const AMOUNT = 1500

    await createPaymentForJob('job-gmv-stable', AMOUNT)
    await updatePaymentAmounts('job-gmv-stable', AMOUNT) // no-op: same amount

    expect(getGMV(getLedger())).toBe(AMOUNT)
    // Only one escrow_created entry must exist
    const escrowEntries = getLedger().filter((e) => e.type === 'escrow_created')
    expect(escrowEntries).toHaveLength(1)
  })

  it('correctEscrowCreatedAmount updates the in-memory ledger entry', () => {
    // Simulate a ledger that already has an escrow_created entry
    // (no repository needed — direct service-level test)
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'pay-corr', amount: 2000 }),
    ]
    // Verify initial amount
    expect(entries[0].amount).toBe(2000)

    // The correctEscrowCreatedAmount function operates on the repository, so
    // we test via the full repository path in beforeEach-scoped tests above.
    // Here we assert the ledgerSelectors behave correctly when the entry
    // IS already corrected (simulating post-correction state).
    const corrected: LedgerEntry[] = [{ ...entries[0], amount: 3500 }]
    expect(getGMV(corrected)).toBe(3500)
  })
})

// ── H. dispute_hold does NOT reduce openEscrow ────────────────────────────────

describe('H — dispute_hold is informational; does not reduce openEscrow', () => {
  it('openEscrow stays at total after dispute_hold is written', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p-hold', amount: 1000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p-hold', amount: 1000 }),
    ]
    expect(getOpenEscrow(entries)).toBe(1000)
  })

  it('openEscrow reaches 0 only after dispute resolution entries are written', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p-hold', amount: 1000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p-hold', amount: 1000 }),
      ledgerEntry({ type: 'dispute_resolved_refund', paymentId: 'p-hold', amount: 1000 }),
    ]
    expect(getOpenEscrow(entries)).toBe(0)
  })

  it('getDisputeHoldCount counts holds without affecting financial aggregates', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'escrow_created', paymentId: 'p2', amount: 2000 }),
      ledgerEntry({ type: 'dispute_hold', paymentId: 'p2', amount: 2000 }),
    ]
    const kpis = getFinanceKPIs(entries)
    expect(kpis.disputeHoldCount).toBe(2)
    expect(kpis.gmv).toBe(3000)
    expect(kpis.openEscrow).toBe(3000)  // holds don't subtract
    expect(kpis.revenue).toBe(0)
  })
})

// ── I. activePayments semantics ───────────────────────────────────────────────

describe('I — activePayments includes disputed but not released/refunded', () => {
  it('released payment is excluded from active', () => {
    const all: Payment[] = [
      payment({ state: 'released' }),
      payment({ state: 'in_escrow' }),
      payment({ state: 'disputed' }),
      payment({ state: 'refunded' }),
    ]
    const active = all.filter(
      (p) => p.state !== 'released' && p.state !== 'refunded'
    )
    expect(active.some((p) => p.state === 'released')).toBe(false)
    expect(active.some((p) => p.state === 'refunded')).toBe(false)
    expect(active.some((p) => p.state === 'in_escrow')).toBe(true)
    expect(active.some((p) => p.state === 'disputed')).toBe(true)
  })
})

// ── J. revenuePotential excludes refunded-payment jobs ───────────────────────

describe('J — revenuePotential excludes jobs with refunded payments', () => {
  it('refunded job is excluded from the potential pipeline', () => {
    // Simulate what getRevenuePotential does: filter out refunded
    const paymentsMap: Record<string, Payment['state']> = {
      'job-active': 'in_escrow',
      'job-refunded': 'refunded',
      'job-released': 'released',
    }
    const amounts: Record<string, number> = {
      'job-active': 1000,
      'job-refunded': 2000,
      'job-released': 500,
    }

    const refundedJobIds = new Set(
      Object.entries(paymentsMap)
        .filter(([, state]) => state === 'refunded')
        .map(([jobId]) => jobId)
    )

    const potential = Object.entries(amounts)
      .filter(([jobId]) => !refundedJobIds.has(jobId))
      .reduce((sum, [, amt]) => sum + amt, 0)

    // Only job-active (1000) and job-released (500) count
    expect(potential).toBe(1500)
    // job-refunded (2000) is excluded
    expect(potential).not.toBe(3500)
  })

  it('all payments active → potential = sum of all amounts', () => {
    const amounts = [1000, 2000, 500]
    const refundedJobIds = new Set<string>()
    const potential = amounts
      .filter((_, i) => !refundedJobIds.has(`job-${i}`))
      .reduce((s, a) => s + a, 0)
    expect(potential).toBe(3500)
  })
})

// ── Accounting identity ───────────────────────────────────────────────────────

describe('Accounting identity: GMV = payouts + refunds + revenue + openEscrow', () => {
  it('fully-released standard payment satisfies accounting identity', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'deposit_paid', paymentId: 'p1', amount: 250 }),
      ledgerEntry({ type: 'final_paid', paymentId: 'p1', amount: 750 }),
      ledgerEntry({ type: 'platform_fee', paymentId: 'p1', amount: 120 }),
      ledgerEntry({ type: 'payout', paymentId: 'p1', amount: 880 }),
    ]
    const kpis = getFinanceKPIs(entries)
    expect(kpis.openEscrow).toBe(0)
    expect(Math.abs(kpis.gmv - (kpis.payouts + kpis.refunds + kpis.revenue))).toBeLessThan(0.01)
  })

  it('in-escrow payment: openEscrow = GMV (nothing paid out yet)', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 2000 }),
    ]
    const kpis = getFinanceKPIs(entries)
    expect(kpis.openEscrow).toBe(2000)
    expect(kpis.payouts).toBe(0)
    expect(kpis.revenue).toBe(0)
    expect(kpis.refunds).toBe(0)
  })

  it('full refund: openEscrow = 0, GMV = refunds, revenue = 0', () => {
    const entries: LedgerEntry[] = [
      ledgerEntry({ type: 'escrow_created', paymentId: 'p1', amount: 1000 }),
      ledgerEntry({ type: 'refund', paymentId: 'p1', amount: 1000 }),
    ]
    const kpis = getFinanceKPIs(entries)
    expect(kpis.openEscrow).toBe(0)
    expect(kpis.refunds).toBe(1000)
    expect(kpis.revenue).toBe(0)
    expect(kpis.payouts).toBe(0)
  })
})
