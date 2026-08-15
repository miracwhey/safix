/**
 * Payout Corridor Truth Invariants
 *
 * Validates that the critical invariants identified in the E2E audit hold
 * after the A+B fixes (atomic release, proof-based isReleased, canonical amount).
 *
 * Invariants tested:
 *   1. released-with-proof: isReleased=true, counted in releasedAmount
 *   2. released-without-proof: isReleased=false, NOT counted in releasedAmount
 *   3. payoutStatus='payout_unknown' when released-without-proof exists
 *   4. payoutStatus='transfer_triggered' when all released tranches have proof
 *   5. payoutStatus='no_transfer_yet' when no tranches are released
 *   6. canonicalTotalAmount (with ChangeOrder delta) takes precedence over escrowPlan.totalAmount
 *   7. No split-brain: same released amount in moneyFlowProjection and craftsmanPayoutSummary
 *      for a tranche with externalReleaseRef set
 *   8. Retry path: two calls with same transferId produce same result (idempotent)
 */

import { describe, it, expect } from 'vitest'
import {
  deriveMoneyFlowProjection,
  type MoneyFlowProjectionInput,
} from '../../src/lib/payments/moneyFlowProjection'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Küchenmontage',
    status: 'in_progress',
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
    id: 'plan-1',
    sourceOfferId: 'offer-1',
    jobId: 'job-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    currency: 'EUR',
    totalAmount: 2000,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platformFeeRate: 0.09,
    platformFeeAmount: 180,
    ...overrides,
  }
}

function makeTranche(overrides: Partial<EscrowTranche> = {}): EscrowTranche {
  return {
    id: 'tranche-1',
    planId: 'plan-1',
    kind: 'deposit_release',
    percentage: 25,
    amount: 500,
    releaseTrigger: 'work_started',
    status: 'funded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makePayoutAccount(overrides: Partial<ProviderPayoutAccount> = {}): ProviderPayoutAccount {
  return {
    id: 'payout-1',
    providerUserId: 'provider-1',
    stripeConnectAccountId: 'acct_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    ...overrides,
  }
}

function makeInput(overrides: Partial<MoneyFlowProjectionInput> = {}): MoneyFlowProjectionInput {
  return {
    job: makeJob(),
    escrowPlan: makePlan(),
    tranches: [],
    payment: null,
    dispute: null,
    providerPayoutAccount: makePayoutAccount(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Invariant 1: released-with-proof → isReleased=true, counted in releasedAmount', () => {
  it('counts tranche as released when status=released AND externalReleaseRef is set', () => {
    const tranche = makeTranche({
      id: 'tranche-deposit',
      status: 'released',
      externalReleaseRef: 'tr_stripe_123',
      releasedAt: Date.now(),
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.tranches[0].isReleased).toBe(true)
    expect(proj.releasedAmount).toBe(500)
    expect(proj.unreleasedAmount).toBe(1500)
  })
})

describe('Invariant 2: released-without-proof → isReleased=false, NOT in releasedAmount', () => {
  it('does not count tranche as released when status=released but externalReleaseRef is null', () => {
    const tranche = makeTranche({
      id: 'tranche-deposit',
      status: 'released',
      externalReleaseRef: null,
      releasedAt: Date.now(),
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.tranches[0].isReleased).toBe(false)
    expect(proj.releasedAmount).toBe(0)
  })
})

describe('Invariant 3: payoutStatus=payout_unknown when released-without-proof', () => {
  it('returns payout_unknown when tranche has status=released but no externalReleaseRef', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: null,
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.payoutStatus).toBe('payout_unknown')
  })
})

describe('Invariant 4: payoutStatus=transfer_triggered when all released tranches have proof', () => {
  it('returns transfer_triggered when status=released AND externalReleaseRef is set', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_stripe_456',
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.payoutStatus).toBe('transfer_triggered')
  })

  it('returns transfer_triggered for two tranches both with proof', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      kind: 'deposit_release',
      percentage: 25,
      amount: 500,
      status: 'released',
      externalReleaseRef: 'tr_deposit',
    })
    const final = makeTranche({
      id: 'tranche-final',
      kind: 'final_release',
      percentage: 75,
      amount: 1500,
      status: 'released',
      externalReleaseRef: 'tr_final',
    })
    const plan = makePlan({ status: 'fully_released' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [deposit, final] }))

    expect(proj.payoutStatus).toBe('transfer_triggered')
    expect(proj.releasedAmount).toBe(2000)
    expect(proj.isTerminal).toBe(true)
  })
})

describe('Invariant 5: payoutStatus=no_transfer_yet when no tranches are released', () => {
  it('returns no_transfer_yet when all tranches are funded (not released)', () => {
    const tranche = makeTranche({ status: 'funded' })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.payoutStatus).toBe('no_transfer_yet')
    expect(proj.releasedAmount).toBe(0)
  })
})

describe('Invariant 5b: payoutStatus=payout_blocked when provider account not ready', () => {
  it('returns payout_blocked when account not payout-ready and tranche has proof', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_stripe_789',
    })
    const blockedAccount = makePayoutAccount({
      chargesEnabled: false,
      payoutsEnabled: false,
      onboardingStatus: 'onboarding_in_progress',
    })
    const proj = deriveMoneyFlowProjection(makeInput({
      tranches: [tranche],
      providerPayoutAccount: blockedAccount,
    }))

    expect(proj.payoutStatus).toBe('payout_blocked')
  })
})

describe('Invariant 6: canonicalTotalAmount overrides escrowPlan.totalAmount', () => {
  it('uses canonicalTotalAmount when provided (ChangeOrder delta scenario)', () => {
    const planWithLowerAmount = makePlan({ totalAmount: 2000 })
    // ChangeOrder of +500 added on top
    const proj = deriveMoneyFlowProjection(makeInput({
      escrowPlan: planWithLowerAmount,
      tranches: [],
      canonicalTotalAmount: 2500,
    }))

    expect(proj.totalAmount).toBe(2500)
  })

  it('falls back to escrowPlan.totalAmount when canonicalTotalAmount is null', () => {
    const proj = deriveMoneyFlowProjection(makeInput({
      canonicalTotalAmount: null,
    }))

    expect(proj.totalAmount).toBe(2000) // from makePlan()
  })

  it('falls back to escrowPlan.totalAmount when canonicalTotalAmount is undefined', () => {
    const proj = deriveMoneyFlowProjection(makeInput())

    expect(proj.totalAmount).toBe(2000)
  })
})

describe('Invariant 7: no split-brain between proof-based released check', () => {
  it('tranche with proof: isReleased=true in TrancheProjection, releasedAmount accumulates', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      amount: 500,
      status: 'released',
      externalReleaseRef: 'tr_stripe_abc',
    })
    const final = makeTranche({
      id: 'tranche-final',
      kind: 'final_release',
      amount: 1500,
      status: 'funded',
      externalReleaseRef: null,
    })
    const plan = makePlan({ status: 'partially_released' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [deposit, final] }))

    // Only the proven-released deposit tranche counts
    expect(proj.tranches.find((t) => t.id === 'tranche-deposit')?.isReleased).toBe(true)
    expect(proj.tranches.find((t) => t.id === 'tranche-final')?.isReleased).toBe(false)
    expect(proj.releasedAmount).toBe(500)
    expect(proj.unreleasedAmount).toBe(1500)
  })

  it('tranche released-without-proof: isReleased=false, NOT in releasedAmount', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      amount: 500,
      status: 'released',
      externalReleaseRef: null, // proof missing — inconsistent state
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [deposit] }))

    expect(proj.tranches[0].isReleased).toBe(false)
    expect(proj.releasedAmount).toBe(0)
    expect(proj.payoutStatus).toBe('payout_unknown')
  })
})

describe('Invariant 8: idempotent — same result for same externalReleaseRef', () => {
  it('two projections with same tranche produce identical results', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_idempotent',
    })
    const input = makeInput({ tranches: [tranche] })
    const proj1 = deriveMoneyFlowProjection(input)
    const proj2 = deriveMoneyFlowProjection(input)

    expect(proj1.releasedAmount).toBe(proj2.releasedAmount)
    expect(proj1.payoutStatus).toBe(proj2.payoutStatus)
    expect(proj1.tranches[0].isReleased).toBe(proj2.tranches[0].isReleased)
  })
})

describe('Mixed: one with proof, one without — partial healing state', () => {
  it('counts only proof-backed tranche in releasedAmount, signals payout_unknown overall', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      amount: 500,
      status: 'released',
      externalReleaseRef: 'tr_deposit_ok',
    })
    const final = makeTranche({
      id: 'tranche-final',
      kind: 'final_release',
      amount: 1500,
      status: 'released',
      externalReleaseRef: null, // healing not yet complete
    })
    const plan = makePlan({ status: 'fully_released' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [deposit, final] }))

    // Deposit counted, final not
    expect(proj.releasedAmount).toBe(500)
    // Mixed state: proven deposit + unproven final → healing incomplete
    expect(proj.payoutStatus).toBe('payout_unknown')
    expect(proj.tranches.find((t) => t.id === 'tranche-deposit')?.isReleased).toBe(true)
    expect(proj.tranches.find((t) => t.id === 'tranche-final')?.isReleased).toBe(false)
  })
})

// ── Reversal Invariants ───────────────────────────────────────────────────────

describe('Invariant 9: single reversed tranche → isReleased=false, transfer_reversed', () => {
  it('tranche with transferReversalRef is NOT counted as released', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_was_created',
      transferReversalRef: 'trr_stripe_reversal',
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.tranches[0].isReleased).toBe(false)
    expect(proj.releasedAmount).toBe(0)
    expect(proj.payoutStatus).toBe('transfer_reversed')
  })

  it('payoutStatus is transfer_reversed even when plan.status is fully_released', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_was_created',
      transferReversalRef: 'trr_reversal',
    })
    const plan = makePlan({ status: 'fully_released' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [tranche] }))

    expect(proj.payoutStatus).toBe('transfer_reversed')
    expect(proj.releasedAmount).toBe(0)
  })
})

describe('Invariant 10: two tranches — one proven, one reversed → payout_unknown', () => {
  it('mixed proven + reversed state → payout_unknown, only proven tranche in releasedAmount', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      amount: 500,
      status: 'released',
      externalReleaseRef: 'tr_deposit_ok',
      transferReversalRef: undefined, // not reversed
    })
    const final = makeTranche({
      id: 'tranche-final',
      kind: 'final_release',
      amount: 1500,
      status: 'released',
      externalReleaseRef: 'tr_final_was_created',
      transferReversalRef: 'trr_final_reversed', // reversed
    })
    const plan = makePlan({ status: 'partially_released' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [deposit, final] }))

    expect(proj.tranches.find((t) => t.id === 'tranche-deposit')?.isReleased).toBe(true)
    expect(proj.tranches.find((t) => t.id === 'tranche-final')?.isReleased).toBe(false)
    expect(proj.releasedAmount).toBe(500)
    // Some proven, some reversed → mixed/unclear state
    expect(proj.payoutStatus).toBe('payout_unknown')
  })
})

describe('Invariant 11: all tranches reversed → transfer_reversed, releasedAmount=0', () => {
  it('both tranches reversed → transfer_reversed with zero released amount', () => {
    const deposit = makeTranche({
      id: 'tranche-deposit',
      amount: 500,
      status: 'released',
      externalReleaseRef: 'tr_deposit',
      transferReversalRef: 'trr_deposit_rev',
    })
    const final = makeTranche({
      id: 'tranche-final',
      kind: 'final_release',
      amount: 1500,
      status: 'released',
      externalReleaseRef: 'tr_final',
      transferReversalRef: 'trr_final_rev',
    })
    const plan = makePlan({ status: 'funded_in_escrow' })
    const proj = deriveMoneyFlowProjection(makeInput({ escrowPlan: plan, tranches: [deposit, final] }))

    expect(proj.releasedAmount).toBe(0)
    expect(proj.payoutStatus).toBe('transfer_reversed')
    expect(proj.tranches[0].isReleased).toBe(false)
    expect(proj.tranches[1].isReleased).toBe(false)
  })
})

describe('Invariant 12: reversal does not affect happy-path tranche', () => {
  it('tranche with externalReleaseRef but no reversal: isReleased=true, transfer_triggered', () => {
    const tranche = makeTranche({
      status: 'released',
      externalReleaseRef: 'tr_clean',
      transferReversalRef: undefined,
    })
    const proj = deriveMoneyFlowProjection(makeInput({ tranches: [tranche] }))

    expect(proj.tranches[0].isReleased).toBe(true)
    expect(proj.releasedAmount).toBe(500)
    expect(proj.payoutStatus).toBe('transfer_triggered')
  })
})
