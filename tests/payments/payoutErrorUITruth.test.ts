/**
 * Payout Error UI Truth — Patch B2
 *
 * Verifies that payout_failed and transfer_reversed never appear as
 * success states in Finance, Job, or Payment UI surfaces.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveMoneyFlowProjection,
  type MoneyFlowProjectionInput,
} from '../../src/lib/payments/moneyFlowProjection'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-b2',
    title: 'Patch B2 Test Job',
    status: 'completed',
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
    id: 'plan-b2',
    sourceOfferId: 'offer-b2',
    jobId: 'job-b2',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    currency: 'EUR',
    totalAmount: 2000,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'fully_released',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platformFeeRate: 0.09,
    platformFeeAmount: 180,
    ...overrides,
  }
}

function makeTranche(overrides: Partial<EscrowTranche> = {}): EscrowTranche {
  return {
    id: 'tr-b2',
    planId: 'plan-b2',
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
    id: 'payout-b2',
    providerUserId: 'provider-1',
    stripeConnectAccountId: 'acct_b2',
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

function fullyReleasedWithProof(): MoneyFlowProjectionInput {
  return {
    job: makeJob(),
    escrowPlan: makePlan({ status: 'fully_released' }),
    tranches: [
      makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', externalReleaseRef: 'tr_dep_b2', releaseTrigger: 'work_started' }),
      makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'released', externalReleaseRef: 'tr_fin_b2', releaseTrigger: 'work_completed' }),
    ],
    payment: null,
    dispute: null,
    providerPayoutAccount: makePayoutAccount(),
  }
}

const FINAL_SUCCESS_PATTERN = /vollständig freigegeben|ausgezahlt|auf deinem konto|erfolgreich abgeschlossen/i

// ── payout_failed ─────────────────────────────────────────────────────────────

describe('Patch B2 — payout_failed', () => {
  function withFailedPayout(): MoneyFlowProjectionInput {
    return {
      ...fullyReleasedWithProof(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_b2', 'failed'],
        ['tr_fin_b2', 'failed'],
      ]),
    }
  }

  it('payoutStatus is payout_failed', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.payoutStatus).toBe('payout_failed')
  })

  it('requiresReconciliation is true', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.requiresReconciliation).toBe(true)
  })

  it('summaryLine does not contain final success text', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.summaryLine).not.toMatch(FINAL_SUCCESS_PATTERN)
  })

  it('summaryLine contains "fehlgeschlagen"', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.summaryLine).toMatch(/fehlgeschlagen/i)
  })

  it('payoutStatusLabel is correct error text', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.payoutStatusLabel).toBe('Auszahlung fehlgeschlagen')
  })

  it('isTerminal stays true (escrow done), but requiresReconciliation prevents success UI', () => {
    const r = deriveMoneyFlowProjection(withFailedPayout())
    expect(r.isTerminal).toBe(true)
    expect(r.requiresReconciliation).toBe(true)
  })
})

// ── transfer_reversed ─────────────────────────────────────────────────────────

describe('Patch B2 — transfer_reversed', () => {
  function withReversedTransfer(): MoneyFlowProjectionInput {
    return {
      job: makeJob(),
      escrowPlan: makePlan({ status: 'fully_released' }),
      tranches: [
        makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', externalReleaseRef: 'tr_dep_b2', transferReversalRef: 'prv_dep_rev', releaseTrigger: 'work_started' }),
        makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'released', externalReleaseRef: 'tr_fin_b2', transferReversalRef: 'prv_fin_rev', releaseTrigger: 'work_completed' }),
      ],
      payment: null,
      dispute: null,
      providerPayoutAccount: makePayoutAccount(),
    }
  }

  it('payoutStatus is transfer_reversed', () => {
    const r = deriveMoneyFlowProjection(withReversedTransfer())
    expect(r.payoutStatus).toBe('transfer_reversed')
  })

  it('requiresReconciliation is true', () => {
    const r = deriveMoneyFlowProjection(withReversedTransfer())
    expect(r.requiresReconciliation).toBe(true)
  })

  it('summaryLine does not contain final success text', () => {
    const r = deriveMoneyFlowProjection(withReversedTransfer())
    expect(r.summaryLine).not.toMatch(FINAL_SUCCESS_PATTERN)
  })

  it('summaryLine contains reversal/clarification language', () => {
    const r = deriveMoneyFlowProjection(withReversedTransfer())
    expect(r.summaryLine).toMatch(/storniert|nötig|klärung/i)
  })

  it('payoutStatusLabel is correct reversal text', () => {
    const r = deriveMoneyFlowProjection(withReversedTransfer())
    expect(r.payoutStatusLabel).toBe('Überweisung storniert — Klärung läuft')
  })
})

// ── payout_blocked in terminal state ─────────────────────────────────────────

describe('Patch B2 — payout_blocked (terminal)', () => {
  it('summaryLine does not contain final success text', () => {
    const r = deriveMoneyFlowProjection({
      ...fullyReleasedWithProof(),
      providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
    })
    expect(r.payoutStatus).toBe('payout_blocked')
    expect(r.summaryLine).not.toMatch(FINAL_SUCCESS_PATTERN)
    expect(r.summaryLine).toMatch(/blockiert/i)
  })

  it('requiresReconciliation is false for payout_blocked (setup issue, not error)', () => {
    const r = deriveMoneyFlowProjection({
      ...fullyReleasedWithProof(),
      providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
    })
    expect(r.requiresReconciliation).toBe(false)
  })
})

// ── Success states remain correct ─────────────────────────────────────────────

describe('Patch B2 — success states unchanged', () => {
  it('payout_completed still shows "Ausgezahlt"', () => {
    const r = deriveMoneyFlowProjection({
      ...fullyReleasedWithProof(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_b2', 'completed'],
        ['tr_fin_b2', 'completed'],
      ]),
    })
    expect(r.payoutStatus).toBe('payout_completed')
    expect(r.summaryLine).toBe('Ausgezahlt')
    expect(r.requiresReconciliation).toBe(false)
  })

  it('transfer_triggered still shows "Auszahlung in Bearbeitung"', () => {
    const r = deriveMoneyFlowProjection(fullyReleasedWithProof())
    expect(r.payoutStatus).toBe('transfer_triggered')
    expect(r.summaryLine).toBe('Auszahlung in Bearbeitung')
    expect(r.requiresReconciliation).toBe(false)
  })

  it('payout_in_transit still shows "Auszahlung läuft"', () => {
    // Partial payout confirmed for one tranche, plan not yet fully_released
    const r = deriveMoneyFlowProjection({
      job: makeJob(),
      escrowPlan: makePlan({ status: 'partially_released' }),
      tranches: [
        makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', externalReleaseRef: 'tr_dep_b2', releaseTrigger: 'work_started' }),
        makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'funded', releaseTrigger: 'work_completed' }),
      ],
      payment: null,
      dispute: null,
      providerPayoutAccount: makePayoutAccount(),
      payoutOutcomesByTransfer: new Map([['tr_dep_b2', 'completed']]),
    })
    expect(r.payoutStatus).toBe('payout_in_transit')
    expect(r.requiresReconciliation).toBe(false)
  })

  it('payout_unknown still shows "Klärung erforderlich"', () => {
    const r = deriveMoneyFlowProjection({
      job: makeJob(),
      escrowPlan: makePlan({ status: 'fully_released' }),
      tranches: [
        makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', releaseTrigger: 'work_started' }),
        makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'released', releaseTrigger: 'work_completed' }),
      ],
      payment: null,
      dispute: null,
      providerPayoutAccount: makePayoutAccount(),
    })
    expect(r.payoutStatus).toBe('payout_unknown')
    expect(r.requiresReconciliation).toBe(true)
    expect(r.summaryLine).toBe('Klärung erforderlich')
  })
})

// ── Partial payout_failed (one of two tranches failed) ────────────────────────

describe('Patch B2 — partial payout_failed dominates', () => {
  it('any failed bank payout makes payoutStatus payout_failed', () => {
    const r = deriveMoneyFlowProjection({
      ...fullyReleasedWithProof(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_b2', 'completed'],
        ['tr_fin_b2', 'failed'],
      ]),
    })
    expect(r.payoutStatus).toBe('payout_failed')
    expect(r.requiresReconciliation).toBe(true)
    expect(r.summaryLine).not.toMatch(FINAL_SUCCESS_PATTERN)
  })
})
