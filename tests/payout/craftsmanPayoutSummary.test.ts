/**
 * Sub-block 5.1 — CraftsmanPayoutSummary Selector Tests
 *
 * Covers:
 *   A. Selector correctness — payments land in the right bucket
 *   B. Amount accuracy — exact vs estimated, ledger vs rate-derived
 *   C. Platform-fee transparency — collected vs estimated
 *   D. Dispute interaction — disputed bucket, dispute_resolved_release as release entry
 *   E. Payout account gate — bucket assignment depends on account readiness
 *   F. Craftsman scoping — other craftsmen never counted
 */

import { describe, it, expect } from 'vitest'
import {
  deriveCraftsmanPayoutSummary,
} from '../../src/lib/payout/craftsmanPayoutSummary'
import type { Payment } from '../../src/lib/payments/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { PayoutStatus } from '../../src/lib/payments/moneyFlowProjection'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Test fixture rate for building ledger entries in released-payment scenarios.
// This is NOT the production fee rate — production uses resolveJobFeeRate (5 % or 9 %).
const TEST_LEDGER_FEE_RATE = 0.12
const NET_PAYOUT_RATE = 1 - TEST_LEDGER_FEE_RATE

// Effective rate for estimate calculations — resolveJobFeeRate returns 9% for
// test jobs without commercialOrigin (unknown → safe default).
const EFFECTIVE_FEE_RATE = 0.09
const EFFECTIVE_NET_RATE = 1 - EFFECTIVE_FEE_RATE

const CRAFTSMAN = 'craftsman-a'
const OTHER_CRAFTSMAN = 'craftsman-b'

function makePayment(
  overrides: Partial<Payment> & { state: Payment['state'] }
): Payment {
  return {
    id: `pay-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    craftsmanUserId: CRAFTSMAN,
    state: overrides.state,
    amounts: {
      totalAmount: 1000,
      depositAmount: 250,
      finalAmount: 750,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

function makeLedgerEntry(
  overrides: Partial<LedgerEntry> & { type: LedgerEntry['type']; paymentId: string; jobId: string; amount: number }
): LedgerEntry {
  return {
    id: `led-${Math.random().toString(36).slice(2, 8)}`,
    currency: 'EUR',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makePayoutAccount(
  overrides: Partial<ProviderPayoutAccount> = {}
): ProviderPayoutAccount {
  return {
    id: 'acc-1',
    providerUserId: CRAFTSMAN,
    stripeConnectAccountId: 'acct_test',
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

/** Standard released payment: payout + platform_fee ledger entries. */
function makeReleasedLedger(payment: Payment): LedgerEntry[] {
  const gross = payment.amounts.totalAmount
  return [
    makeLedgerEntry({
      type: 'final_paid',
      paymentId: payment.id,
      jobId: payment.jobId,
      amount: payment.amounts.finalAmount,
    }),
    makeLedgerEntry({
      type: 'platform_fee',
      paymentId: payment.id,
      jobId: payment.jobId,
      amount: Number((gross * TEST_LEDGER_FEE_RATE).toFixed(2)),
    }),
    makeLedgerEntry({
      type: 'payout',
      paymentId: payment.id,
      jobId: payment.jobId,
      amount: Number((gross * NET_PAYOUT_RATE).toFixed(2)),
    }),
  ]
}

// ── Gruppe A — Selector correctness ──────────────────────────────────────────

describe('Gruppe A — Payments land in the correct bucket', () => {
  const ready = makePayoutAccount()

  it('released payment with ready account → releasedPayoutEligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-rel-1', jobId: 'job-rel-1' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    expect(s.releasedPayoutEligible).toBeGreaterThan(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.disputedGross).toBe(0)
  })

  it('released payment with blocked account → releasedPayoutBlocked', () => {
    const p = makePayment({ state: 'released', id: 'pay-rel-2', jobId: 'job-rel-2' })
    const ledger = makeReleasedLedger(p)
    const blocked = makePayoutAccount({ payoutsEnabled: false })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, blocked)

    expect(s.releasedPayoutBlocked).toBeGreaterThan(0)
    expect(s.releasedPayoutEligible).toBe(0)
  })

  it('in_escrow payment → inEscrow bucket', () => {
    const p = makePayment({ state: 'in_escrow', id: 'pay-esc-1', jobId: 'job-esc-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.inEscrowGross).toBe(1000)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.disputedGross).toBe(0)
  })

  it('work_in_progress payment → inEscrow bucket', () => {
    const p = makePayment({ state: 'work_in_progress', id: 'pay-wip-1', jobId: 'job-wip-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.inEscrowGross).toBe(1000)
    expect(s.releasedPayoutEligible).toBe(0)
  })

  it('release_pending payment → releasePending bucket', () => {
    const p = makePayment({ state: 'release_pending', id: 'pay-rp-1', jobId: 'job-rp-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.releasePendingGross).toBe(1000)
    expect(s.inEscrowGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
  })

  it('disputed payment → disputed bucket, not escrow', () => {
    const p = makePayment({ state: 'disputed', id: 'pay-dis-1', jobId: 'job-dis-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.disputedGross).toBe(1000)
    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
  })

  it('refunded payment → no positive bucket, netAmount = 0', () => {
    const p = makePayment({ state: 'refunded', id: 'pay-ref-1', jobId: 'job-ref-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.disputedGross).toBe(0)
    const jobEntry = s.perJob.find((e) => e.paymentId === p.id)
    expect(jobEntry?.netAmount).toBe(0)
  })
})

// ── Gruppe B — Amount accuracy ────────────────────────────────────────────────

describe('Gruppe B — Amounts: exact from ledger vs estimated', () => {
  const ready = makePayoutAccount()

  it('released payment: releasedPayoutEligible uses ledger payout amount, not totalAmount × 0.88', () => {
    // Ledger payout = 860 (slightly different from 1000 × 0.88 = 880 due to rounding or custom amount)
    const p = makePayment({ state: 'released', id: 'pay-exact-1', jobId: 'job-exact-1', amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 } })
    const customPayoutAmount = 860 // differs from 1000 * 0.88 = 880
    const ledger: LedgerEntry[] = [
      makeLedgerEntry({ type: 'platform_fee', paymentId: p.id, jobId: p.jobId, amount: 140 }),
      makeLedgerEntry({ type: 'payout', paymentId: p.id, jobId: p.jobId, amount: customPayoutAmount }),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    expect(s.releasedPayoutEligible).toBe(860)
    expect(s.releasedPayoutEligible).not.toBe(880)
  })

  it('released payment: perJob entry isExact = true when ledger entry found', () => {
    const p = makePayment({ state: 'released', id: 'pay-ex-2', jobId: 'job-ex-2' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(true)
    expect(entry.netAmount).toBe(Number((1000 * NET_PAYOUT_RATE).toFixed(2)))
  })

  it('released payment with no ledger entry: isExact = false, uses rate estimate', () => {
    const p = makePayment({ state: 'released', id: 'pay-noled-1', jobId: 'job-noled-1' })
    // No ledger entries — estimate uses per-job fee rate (9 % default)
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(false)
    expect(entry.netAmount).toBeCloseTo(1000 * EFFECTIVE_NET_RATE, 2)
  })

  it('in_escrow payment: isExact = false, net is estimate', () => {
    const p = makePayment({ state: 'in_escrow', id: 'pay-esc-ex', jobId: 'job-esc-ex' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(false)
    expect(entry.netAmount).toBeCloseTo(1000 * EFFECTIVE_NET_RATE, 2)
  })

  it('released payment: platformFee is exact from ledger', () => {
    const p = makePayment({ state: 'released', id: 'pay-fee-1', jobId: 'job-fee-1' })
    const exactFeeAmount = 123.45
    const ledger: LedgerEntry[] = [
      makeLedgerEntry({ type: 'platform_fee', paymentId: p.id, jobId: p.jobId, amount: exactFeeAmount }),
      makeLedgerEntry({ type: 'payout', paymentId: p.id, jobId: p.jobId, amount: 876.55 }),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    expect(s.platformFeeCollected).toBe(exactFeeAmount)
    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.platformFee).toBe(exactFeeAmount)
  })

  it('inEscrow net estimate matches gross × effective net rate (9 % fee)', () => {
    const p = makePayment({ state: 'in_escrow', id: 'pay-net-est', jobId: 'job-net-est' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.inEscrowNetEstimated).toBeCloseTo(1000 * EFFECTIVE_NET_RATE, 2)
  })

  it('releasePending net estimate matches gross × effective net rate (9 % fee)', () => {
    const p = makePayment({ state: 'release_pending', id: 'pay-rp-est', jobId: 'job-rp-est' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.releasePendingNetEstimated).toBeCloseTo(1000 * EFFECTIVE_NET_RATE, 2)
  })
})

// ── Gruppe C — Platform-fee transparency ──────────────────────────────────────

describe('Gruppe C — Platform-fee transparency', () => {
  const ready = makePayoutAccount()

  it('platformFeeCollected = 0 when no released payments', () => {
    const p = makePayment({ state: 'in_escrow', id: 'pay-pf-1', jobId: 'job-pf-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.platformFeeCollected).toBe(0)
  })

  it('platformFeeEstimated > 0 when unreleased payments exist', () => {
    const p = makePayment({ state: 'in_escrow', id: 'pay-pf-2', jobId: 'job-pf-2' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.platformFeeEstimated).toBeGreaterThan(0)
    expect(s.platformFeeEstimated).toBeCloseTo(1000 * EFFECTIVE_FEE_RATE, 2)
  })

  it('platformFeeCollected sums exact ledger platform_fee entries', () => {
    const p1 = makePayment({ state: 'released', id: 'pay-pf-3', jobId: 'job-pf-3', amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 } })
    const p2 = makePayment({ state: 'released', id: 'pay-pf-4', jobId: 'job-pf-4', amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 } })
    const ledger = [
      ...makeReleasedLedger(p1),
      ...makeReleasedLedger(p2),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p1, p2], ledger, ready)

    // 2000 × 0.12 + 1000 × 0.12 = 240 + 120 = 360
    expect(s.platformFeeCollected).toBeCloseTo(360, 1)
    expect(s.platformFeeEstimated).toBe(0)
  })

  it('platformFeeEstimated covers inEscrow + releasePending + disputed', () => {
    const esc = makePayment({ state: 'in_escrow', id: 'pay-pf-5', jobId: 'job-pf-5' })
    const rp = makePayment({ state: 'release_pending', id: 'pay-pf-6', jobId: 'job-pf-6' })
    const dis = makePayment({ state: 'disputed', id: 'pay-pf-7', jobId: 'job-pf-7' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [esc, rp, dis], [], ready)

    // 3 × 1000 × 0.09 = 270 (9 % default fee, no commercialOrigin)
    expect(s.platformFeeEstimated).toBeCloseTo(270, 1)
    expect(s.platformFeeCollected).toBe(0)
  })
})

// ── Gruppe D — Dispute interaction ────────────────────────────────────────────

describe('Gruppe D — Dispute interaction', () => {
  const ready = makePayoutAccount()

  it('disputed payment not counted in inEscrow or releasePending', () => {
    const p = makePayment({ state: 'disputed', id: 'pay-d-1', jobId: 'job-d-1' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.disputedGross).toBe(1000)
  })

  it('disputed with dispute_hold ledger entry: uses hold amount, isExact = true', () => {
    const p = makePayment({ state: 'disputed', id: 'pay-d-2', jobId: 'job-d-2' })
    const holdAmount = 950 // slightly different from gross
    const ledger: LedgerEntry[] = [
      makeLedgerEntry({ type: 'dispute_hold', paymentId: p.id, jobId: p.jobId, amount: holdAmount }),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    expect(s.disputedGross).toBe(holdAmount)
    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(true)
    expect(entry.grossAmount).toBe(holdAmount)
  })

  it('disputed without dispute_hold: uses payment gross, isExact = false', () => {
    const p = makePayment({ state: 'disputed', id: 'pay-d-3', jobId: 'job-d-3' })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], [], ready)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(false)
    expect(entry.grossAmount).toBe(1000)
  })

  it('dispute_resolved_release counts as release entry (not payout type)', () => {
    // Payment released via dispute resolution — ledger has dispute_resolved_release, NOT payout
    const p = makePayment({ state: 'released', id: 'pay-drel-1', jobId: 'job-drel-1' })
    const disputeReleaseAmount = 600
    const ledger: LedgerEntry[] = [
      makeLedgerEntry({
        type: 'dispute_resolved_release',
        paymentId: p.id,
        jobId: p.jobId,
        amount: disputeReleaseAmount,
        disputeId: 'disp-1',
      }),
      makeLedgerEntry({
        type: 'platform_fee',
        paymentId: p.id,
        jobId: p.jobId,
        amount: 72,
        disputeId: 'disp-1',
      }),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    // dispute_resolved_release is treated as the release entry
    expect(s.releasedPayoutEligible).toBe(disputeReleaseAmount)
    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.isExact).toBe(true)
    expect(entry.netAmount).toBe(disputeReleaseAmount)
  })

  it('payout entry takes precedence over dispute_resolved_release when both somehow present', () => {
    // This should not occur in practice (NON_REPEATING_TYPES), but the selector
    // must behave deterministically: payout is searched first.
    const p = makePayment({ state: 'released', id: 'pay-drel-2', jobId: 'job-drel-2' })
    const payoutAmount = 880
    const resolvedAmount = 600
    const ledger: LedgerEntry[] = [
      makeLedgerEntry({ type: 'payout', paymentId: p.id, jobId: p.jobId, amount: payoutAmount }),
      makeLedgerEntry({ type: 'dispute_resolved_release', paymentId: p.id, jobId: p.jobId, amount: resolvedAmount }),
    ]
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    // payout entry is found first → that value wins
    expect(s.releasedPayoutEligible).toBe(payoutAmount)
  })
})

// ── Gruppe E — Payout account gate ───────────────────────────────────────────

describe('Gruppe E — Payout account gate affects released bucket assignment', () => {
  const p = makePayment({ state: 'released', id: 'pay-gate-1', jobId: 'job-gate-1' })
  const ledger = makeReleasedLedger(p)
  const netAmount = Number((1000 * NET_PAYOUT_RATE).toFixed(2))

  it('null account → released payment in releasedPayoutBlocked', () => {
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, null)

    expect(s.releasedPayoutBlocked).toBeCloseTo(netAmount, 2)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.payoutReadiness).toBe('no_account')
  })

  it('onboarding_required → released payment in releasedPayoutBlocked', () => {
    const account = makePayoutAccount({
      stripeConnectAccountId: 'acct_test',
      onboardingStatus: 'onboarding_in_progress',
      chargesEnabled: false,
      payoutsEnabled: false,
    })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    expect(s.releasedPayoutBlocked).toBeGreaterThan(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.payoutReadiness).not.toBe('payout_ready')
  })

  it('payout_ready → released payment in releasedPayoutEligible', () => {
    const account = makePayoutAccount({ chargesEnabled: true, payoutsEnabled: true })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    expect(s.releasedPayoutEligible).toBeCloseTo(netAmount, 2)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.payoutReadiness).toBe('payout_ready')
  })

  it('payout_blocked → released payment in releasedPayoutBlocked with non-null blockingReason', () => {
    const account = makePayoutAccount({
      onboardingStatus: 'payout_blocked',
      chargesEnabled: true,
      payoutsEnabled: false,
    })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    expect(s.releasedPayoutBlocked).toBeGreaterThan(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.payoutBlockingReason).not.toBeNull()
    expect(typeof s.payoutBlockingReason).toBe('string')
  })

  it('blocked perJob entry carries blockingReason string', () => {
    const account = makePayoutAccount({ payoutsEnabled: false })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.blockingReason).not.toBeNull()
    expect(typeof entry.blockingReason).toBe('string')
  })

  it('eligible perJob entry has blockingReason = null', () => {
    const account = makePayoutAccount({ chargesEnabled: true, payoutsEnabled: true })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.blockingReason).toBeNull()
    expect(entry.payoutEligible).toBe(true)
  })

  it('payoutBlockingReason is null when account is ready', () => {
    const account = makePayoutAccount({ chargesEnabled: true, payoutsEnabled: true })
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, account)

    expect(s.payoutBlockingReason).toBeNull()
  })
})

// ── Gruppe F — Craftsman scoping ──────────────────────────────────────────────

describe('Gruppe F — Other craftsmen never counted', () => {
  const ready = makePayoutAccount()

  it('payment from other craftsman not included in any bucket', () => {
    const own = makePayment({ state: 'in_escrow', id: 'pay-sc-1', jobId: 'job-sc-1', craftsmanUserId: CRAFTSMAN })
    const other = makePayment({ state: 'in_escrow', id: 'pay-sc-2', jobId: 'job-sc-2', craftsmanUserId: OTHER_CRAFTSMAN })

    const sOwn = deriveCraftsmanPayoutSummary(CRAFTSMAN, [own, other], [], ready)
    expect(sOwn.inEscrowGross).toBe(1000)
    expect(sOwn.perJob).toHaveLength(1)
    expect(sOwn.perJob[0].paymentId).toBe(own.id)
  })

  it('summary for craftsman-a ≠ summary for craftsman-b on shared payments', () => {
    const pA = makePayment({ state: 'released', id: 'pay-sc-3', jobId: 'job-sc-3', craftsmanUserId: CRAFTSMAN, amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 } })
    const pB = makePayment({ state: 'in_escrow', id: 'pay-sc-4', jobId: 'job-sc-4', craftsmanUserId: OTHER_CRAFTSMAN, amounts: { totalAmount: 500, depositAmount: 125, finalAmount: 375 } })
    const ledgerA = makeReleasedLedger(pA)

    const sA = deriveCraftsmanPayoutSummary(CRAFTSMAN, [pA, pB], ledgerA, ready)
    const sB = deriveCraftsmanPayoutSummary(OTHER_CRAFTSMAN, [pA, pB], ledgerA, ready)

    expect(sA.releasedPayoutEligible).toBeGreaterThan(0)
    expect(sA.inEscrowGross).toBe(0)
    expect(sB.inEscrowGross).toBe(500)
    expect(sB.releasedPayoutEligible).toBe(0)
  })

  it('perJob only contains entries for the specified craftsman', () => {
    const own = makePayment({ state: 'release_pending', id: 'pay-sc-5', jobId: 'job-sc-5', craftsmanUserId: CRAFTSMAN })
    const other = makePayment({ state: 'release_pending', id: 'pay-sc-6', jobId: 'job-sc-6', craftsmanUserId: OTHER_CRAFTSMAN })

    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [own, other], [], ready)
    expect(s.perJob.every((e) => e.paymentId !== other.id)).toBe(true)
  })

  it('empty payments list → all buckets zero', () => {
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [], [], ready)

    expect(s.inEscrowGross).toBe(0)
    expect(s.releasePendingGross).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.releasedPayoutReversedFailed).toBe(0)
    expect(s.disputedGross).toBe(0)
    expect(s.platformFeeCollected).toBe(0)
    expect(s.platformFeeEstimated).toBe(0)
    expect(s.perJob).toHaveLength(0)
  })
})

// ── Gruppe G — Outcome-aware released bucketing (payoutStatus = SSoT) ─────────
// MoneyFlowProjection.payoutStatus is the single source of truth for the payout
// OUTCOME. A reversed/failed payout must be diverted out of the eligible bucket
// so no finance surface claims a reversed/failed payout as "In Auszahlung".

describe('Gruppe G — payoutStatus diverts reversed/failed out of the eligible bucket', () => {
  const ready = makePayoutAccount()

  function statusMap(paymentId: string, status: PayoutStatus): Map<string, PayoutStatus> {
    return new Map<string, PayoutStatus>([[paymentId, status]])
  }

  it('payout_failed → releasedPayoutReversedFailed, NOT releasedPayoutEligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-fail', jobId: 'job-g-fail' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [p], ledger, ready, [], statusMap(p.id, 'payout_failed'),
    )

    const netAmount = Number((1000 * NET_PAYOUT_RATE).toFixed(2))
    expect(s.releasedPayoutReversedFailed).toBeCloseTo(netAmount, 2)
    expect(s.releasedPayoutEligible).toBe(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    const entry = s.perJob.find((e) => e.paymentId === p.id)!
    expect(entry.payoutEligible).toBe(false)
  })

  it('transfer_reversed → releasedPayoutReversedFailed, NOT eligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-rev', jobId: 'job-g-rev' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [p], ledger, ready, [], statusMap(p.id, 'transfer_reversed'),
    )

    expect(s.releasedPayoutReversedFailed).toBeGreaterThan(0)
    expect(s.releasedPayoutEligible).toBe(0)
  })

  it('NO REGRESSION: payout_completed stays in releasedPayoutEligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-done', jobId: 'job-g-done' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [p], ledger, ready, [], statusMap(p.id, 'payout_completed'),
    )

    const netAmount = Number((1000 * NET_PAYOUT_RATE).toFixed(2))
    expect(s.releasedPayoutEligible).toBeCloseTo(netAmount, 2)
    expect(s.releasedPayoutReversedFailed).toBe(0)
  })

  it('NO REGRESSION: transfer_triggered (common pending payout) stays eligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-trig', jobId: 'job-g-trig' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [p], ledger, ready, [], statusMap(p.id, 'transfer_triggered'),
    )

    expect(s.releasedPayoutEligible).toBeGreaterThan(0)
    expect(s.releasedPayoutReversedFailed).toBe(0)
  })

  it('NO REGRESSION: omitted map (no projection) → legacy account-gated eligible', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-omit', jobId: 'job-g-omit' })
    const ledger = makeReleasedLedger(p)
    const s = deriveCraftsmanPayoutSummary(CRAFTSMAN, [p], ledger, ready)

    expect(s.releasedPayoutEligible).toBeGreaterThan(0)
    expect(s.releasedPayoutReversedFailed).toBe(0)
  })

  it('payout_failed on a blocked account still diverts to reversed/failed (failure dominates)', () => {
    const p = makePayment({ state: 'released', id: 'pay-g-fb', jobId: 'job-g-fb' })
    const ledger = makeReleasedLedger(p)
    const blocked = makePayoutAccount({ payoutsEnabled: false })
    const s = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [p], ledger, blocked, [], statusMap(p.id, 'payout_failed'),
    )

    expect(s.releasedPayoutReversedFailed).toBeGreaterThan(0)
    expect(s.releasedPayoutBlocked).toBe(0)
    expect(s.releasedPayoutEligible).toBe(0)
  })
})
