/**
 * MoneyFlowProjection — partial-refund summary (Block P · Batch 3, G6)
 *
 * After the T+80 default 75/25 settle (settle_dispute_default), the held 75% is
 * refunded and the released 25% deposit stays with the craftsman. The escrow plan
 * is NOT marked 'refunded' (mirrors settle_consensus_split). The projection must
 * therefore NOT show 'Vollständig erstattet' — it must show a partial-refund
 * summary derived from the ACTUAL refunded-tranche amount (so it is correct for
 * the corridor po_* model and for any split, not only 75/25).
 *
 * NOTE: the SQL settle logic itself is not unit-testable without a DB — that is
 * covered by supabase/repro/20260614060000_partial_default_settle_repro.sql at
 * apply time. These tests pin the TS projection (G6) only.
 */

import { describe, it, expect } from 'vitest'
import { deriveMoneyFlowProjection } from '../../src/lib/payments/moneyFlowProjection'
import type { Dispute } from '../../src/lib/disputes/types'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

const JOB_ID = 'b3-job-1'
const PLAN_ID = 'b3-plan-1'
const TOTAL = 1000

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    title: 'Batch3 partial-refund job',
    status: 'waiting_payment',
    assignedMemberIds: [],
    photoCount: 0,
    notes: [],
    activities: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Job
}

function makePlan(overrides: Partial<EscrowPaymentPlan> = {}): EscrowPaymentPlan {
  return {
    id: PLAN_ID,
    sourceOfferId: 'b3-offer-1',
    jobId: JOB_ID,
    customerUserId: 'b3-customer-1',
    providerId: 'b3-craft-1',
    currency: 'EUR',
    totalAmount: TOTAL,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'partially_released',
    platformFeeRate: 0.09,
    platformFeeAmount: 90,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Build a tranche pair: the deposit (depAmount) in `depStatus` and the final
 * (TOTAL - depAmount) in `finStatus`. Mirrors the corridor end-state where the
 * deposit is released via payout (no transfer ref) and the final is refunded.
 */
function makeTranches(depStatus: EscrowTranche['status'], finStatus: EscrowTranche['status'], depAmount = 250): EscrowTranche[] {
  return [
    {
      id: 'b3-tr-dep',
      planId: PLAN_ID,
      kind: 'deposit_release',
      percentage: 25,
      amount: depAmount,
      releaseTrigger: 'work_started',
      status: depStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'b3-tr-fin',
      planId: PLAN_ID,
      kind: 'final_release',
      percentage: 75,
      amount: TOTAL - depAmount,
      releaseTrigger: 'work_completed',
      status: finStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'b3-pay-1',
    jobId: JOB_ID,
    craftsmanUserId: 'b3-craft-1',
    state: 'disputed',
    amounts: { totalAmount: TOTAL, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

function makeAccount(): ProviderPayoutAccount {
  return {
    id: 'b3-acc-1',
    providerUserId: 'b3-craft-1',
    stripeConnectAccountId: 'acct_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'b3-disp-1',
    jobId: JOB_ID,
    status: 'resolved',
    reason: 'work_quality',
    title: 'Batch3 dispute',
    description: 'partial default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function project(input: {
  plan: EscrowPaymentPlan
  tranches: EscrowTranche[]
  payment: Payment
  dispute: Dispute | null
}) {
  return deriveMoneyFlowProjection({
    job: makeJob(),
    escrowPlan: input.plan,
    tranches: input.tranches,
    payment: input.payment,
    dispute: input.dispute,
    providerPayoutAccount: makeAccount(),
  })
}

describe('MoneyFlowProjection · partial-refund summary (G6)', () => {
  it('settled 75/25 default → "Teilrückerstattung – 75 % erstattet, 25 % einbehalten", NOT "Vollständig erstattet"', () => {
    const mfp = project({
      // After settle: plan stays partially_released, payment stays disputed.
      plan: makePlan({ status: 'partially_released' }),
      tranches: makeTranches('released', 'refunded'),
      payment: makePayment({ state: 'disputed' }),
      dispute: makeDispute({
        decision: 'refund',
        resolutionType: 'refund_partial',
        settlementStatus: 'settled',
        splitRatio: 0.25,
      }),
    })

    expect(mfp.summaryLine).toBe('Teilrückerstattung – 75 % erstattet, 25 % einbehalten')
    expect(mfp.summaryLine).not.toBe('Vollständig erstattet')
  })

  it('reflects the ACTUAL split, not a hardcoded 75/25 (operator 60/40 partial refund)', () => {
    const mfp = project({
      plan: makePlan({ status: 'partially_released' }),
      // 600 refunded, 400 retained → 60 % / 40 %
      tranches: makeTranches('released', 'refunded', 400),
      payment: makePayment({ state: 'disputed' }),
      dispute: makeDispute({
        decision: 'refund',
        resolutionType: 'refund_partial',
        settlementStatus: 'settled',
        splitRatio: 0.4,
      }),
    })

    expect(mfp.summaryLine).toBe('Teilrückerstattung – 60 % erstattet, 40 % einbehalten')
  })

  it('full refund (refund_full, plan refunded) still shows "Vollständig erstattet" — branch does not hijack full refunds', () => {
    const mfp = project({
      plan: makePlan({ status: 'refunded' }),
      tranches: makeTranches('refunded', 'refunded'),
      payment: makePayment({ state: 'refunded' }),
      dispute: makeDispute({
        decision: 'refund',
        resolutionType: 'refund_full',
        settlementStatus: 'settled',
      }),
    })

    expect(mfp.summaryLine).toBe('Vollständig erstattet')
  })

  it('held-zero default (nothing refunded, escrow already fully released) falls through — no partial-refund line', () => {
    const mfp = project({
      plan: makePlan({ status: 'fully_released' }),
      tranches: makeTranches('released', 'released'),
      payment: makePayment({ state: 'disputed' }),
      dispute: makeDispute({
        decision: 'refund',
        resolutionType: 'refund_partial',
        settlementStatus: 'settled',
        splitRatio: 0.25,
      }),
    })

    expect(mfp.summaryLine).not.toContain('Teilrückerstattung')
  })

  it('pending (not yet settled) partial refund does NOT show the partial-refund line', () => {
    const mfp = project({
      plan: makePlan({ status: 'partially_released' }),
      tranches: makeTranches('released', 'funded'),
      payment: makePayment({ state: 'disputed' }),
      dispute: makeDispute({
        decision: 'refund',
        resolutionType: 'refund_partial',
        settlementStatus: 'pending',
        splitRatio: 0.25,
      }),
    })

    expect(mfp.summaryLine).not.toContain('Teilrückerstattung')
    expect(mfp.summaryLine).not.toBe('Vollständig erstattet')
  })

  it('active dispute still shows "Streitfall aktiv" (blocking status wins over the partial branch)', () => {
    const mfp = project({
      plan: makePlan({ status: 'partially_released' }),
      tranches: makeTranches('released', 'funded'),
      payment: makePayment({ state: 'disputed' }),
      dispute: makeDispute({ status: 'under_review' }),
    })

    expect(mfp.summaryLine).toBe('Streitfall aktiv — Gelder eingefroren')
  })
})
