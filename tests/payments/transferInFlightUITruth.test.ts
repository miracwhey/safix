/**
 * Transfer-in-Flight UI Truth — Patch B
 *
 * Verifies that Finance, Job, and Payment UI surfaces never suggest
 * final payout until Stripe's transfer.paid (payout.paid webhook) is confirmed.
 *
 * Scenarios (a–e):
 *   a) transfer.created but not transfer.paid  → "Auszahlung in Bearbeitung"
 *   b) requiresReconciliation=true             → "Klärung erforderlich", no final label
 *   c) DB released without transfer.paid       → no bank-payout label
 *   d) transfer.paid confirmed                 → only then "Ausgezahlt"
 *   e) Customer and craftsman labels are semantically separate
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
    id: 'job-patch-b',
    title: 'Patch B Test Job',
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
    id: 'plan-patch-b',
    sourceOfferId: 'offer-patch-b',
    jobId: 'job-patch-b',
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
    id: 'tr-patch-b',
    planId: 'plan-patch-b',
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
    id: 'payout-patch-b',
    providerUserId: 'provider-1',
    stripeConnectAccountId: 'acct_123',
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

function fullyReleasedWithTransfer(): MoneyFlowProjectionInput {
  return {
    job: makeJob(),
    escrowPlan: makePlan({ status: 'fully_released' }),
    tranches: [
      makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', externalReleaseRef: 'tr_dep_abc', releaseTrigger: 'work_started' }),
      makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'released', externalReleaseRef: 'tr_fin_def', releaseTrigger: 'work_completed' }),
    ],
    payment: null,
    dispute: null,
    providerPayoutAccount: makePayoutAccount(),
  }
}

// ── a) transfer.created but not transfer.paid ─────────────────────────────────

describe('Patch B — transfer.created but not transfer.paid', () => {
  it('shows "Auszahlung in Bearbeitung" not "Ausgezahlt"', () => {
    const result = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    expect(result.payoutStatus).toBe('transfer_triggered')
    expect(result.summaryLine).toBe('Auszahlung in Bearbeitung')
    expect(result.summaryLine).not.toMatch(/ausgezahlt/i)
    expect(result.summaryLine).not.toMatch(/auf deinem konto/i)
  })

  it('payoutStatusLabel correctly says "Zur Auszahlung übergeben" not "Auf deinem Konto"', () => {
    const result = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    expect(result.payoutStatusLabel).toBe('Zur Auszahlung übergeben')
    expect(result.payoutStatusLabel).not.toMatch(/auf deinem konto/i)
    expect(result.payoutStatusLabel).not.toMatch(/ausgezahlt/i)
  })

  it('requiresReconciliation is false when transfer proof exists', () => {
    const result = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    expect(result.requiresReconciliation).toBe(false)
  })
})

// ── b) requiresReconciliation=true → fail-closed UI ──────────────────────────

describe('Patch B — requiresReconciliation (DB released, no transfer ref)', () => {
  function dbReleasedNoTransfer(): MoneyFlowProjectionInput {
    return {
      job: makeJob(),
      escrowPlan: makePlan({ status: 'fully_released' }),
      tranches: [
        makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', releaseTrigger: 'work_started' }),
        makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'released', releaseTrigger: 'work_completed' }),
      ],
      payment: null,
      dispute: null,
      providerPayoutAccount: makePayoutAccount(),
    }
  }

  it('sets requiresReconciliation=true', () => {
    const result = deriveMoneyFlowProjection(dbReleasedNoTransfer())
    expect(result.requiresReconciliation).toBe(true)
  })

  it('payoutStatus is payout_unknown', () => {
    const result = deriveMoneyFlowProjection(dbReleasedNoTransfer())
    expect(result.payoutStatus).toBe('payout_unknown')
  })

  it('summaryLine shows "Klärung erforderlich"', () => {
    const result = deriveMoneyFlowProjection(dbReleasedNoTransfer())
    expect(result.summaryLine).toBe('Klärung erforderlich')
  })

  it('summaryLine does not contain final payout language', () => {
    const result = deriveMoneyFlowProjection(dbReleasedNoTransfer())
    expect(result.summaryLine).not.toMatch(/ausgezahlt/i)
    expect(result.summaryLine).not.toMatch(/auf deinem konto/i)
    expect(result.summaryLine).not.toMatch(/vollständig freigegeben/i)
  })
})

// ── c) DB released ohne transfer.paid → kein Bank-Auszahlungslabel ────────────

describe('Patch B — DB released, no bank payout confirmed', () => {
  it('does not show "payout_completed" when transfer exists but no payout.paid signal', () => {
    const result = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    // transfer_triggered = transfer created. NOT payout_completed.
    expect(result.payoutStatus).not.toBe('payout_completed')
    expect(result.payoutStatusLabel).not.toMatch(/auf deinem konto/i)
  })

  it('does not show "payout_completed" when DB released and no transfer at all', () => {
    const result = deriveMoneyFlowProjection({
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
    expect(result.payoutStatus).toBe('payout_unknown')
    expect(result.payoutStatus).not.toBe('payout_completed')
  })
})

// ── d) transfer.paid → erst dann "Ausgezahlt" ────────────────────────────────

describe('Patch B — transfer.paid (payout.paid webhook confirmed)', () => {
  it('shows "Ausgezahlt" summary only when payout.paid outcome exists for all transfers', () => {
    const result = deriveMoneyFlowProjection({
      ...fullyReleasedWithTransfer(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_abc', 'completed'],
        ['tr_fin_def', 'completed'],
      ]),
    })
    expect(result.payoutStatus).toBe('payout_completed')
    expect(result.summaryLine).toBe('Ausgezahlt')
    expect(result.requiresReconciliation).toBe(false)
  })

  it('does not claim payout_completed when only partial transfer confirmed', () => {
    // Only deposit transfer confirmed, final still pending
    const result = deriveMoneyFlowProjection({
      ...fullyReleasedWithTransfer(),
      escrowPlan: makePlan({ status: 'partially_released' }),
      tranches: [
        makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, status: 'released', externalReleaseRef: 'tr_dep_abc', releaseTrigger: 'work_started' }),
        makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, status: 'funded', releaseTrigger: 'work_completed' }),
      ],
      payoutOutcomesByTransfer: new Map([['tr_dep_abc', 'completed']]),
    })
    // Partial: only deposit released + confirmed. Full plan not yet fully_released.
    // payout_in_transit: partial evidence of bank arrival but job not fully done
    expect(result.payoutStatus).toBe('payout_in_transit')
    expect(result.payoutStatus).not.toBe('payout_completed')
    expect(result.summaryLine).not.toMatch(/ausgezahlt/i)
  })

  it('payoutStatusLabel shows "Auf deinem Konto" only for payout_completed', () => {
    const result = deriveMoneyFlowProjection({
      ...fullyReleasedWithTransfer(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_abc', 'completed'],
        ['tr_fin_def', 'completed'],
      ]),
    })
    expect(result.payoutStatusLabel).toBe('Auf deinem Konto')
  })
})

// ── e) Customer and craftsman labels are semantically separate ─────────────────

describe('Patch B — customer vs craftsman label separation', () => {
  it('craftsman sees payout-status labels (transfer/bank state), not customer escrow language', () => {
    // Craftsman projection for transfer_triggered
    const craftsmanProj = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    expect(craftsmanProj.payoutStatus).toBe('transfer_triggered')
    // Craftsman label must describe bank-transfer progress
    expect(craftsmanProj.payoutStatusLabel).toBe('Zur Auszahlung übergeben')
    // Must NOT say "Vollständig erstattet" or customer escrow language
    expect(craftsmanProj.payoutStatusLabel).not.toMatch(/erstattet/i)
  })

  it('isTerminal does not imply bank payout — only escrow completion', () => {
    const result = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    // Escrow is done (isTerminal=true), but transfer_triggered ≠ bank confirmed
    expect(result.isTerminal).toBe(true)
    expect(result.payoutStatus).toBe('transfer_triggered')
    // summaryLine should NOT say "Vollständig freigegeben" (escrow language only)
    expect(result.summaryLine).toBe('Auszahlung in Bearbeitung')
  })

  it('customer-facing "freigegeben" does not cross into craftsman bank-payout semantics', () => {
    // When plan is fully_released, customer sees "Vollständig freigegeben" badge
    // (escrow done). Craftsman sees transfer/bank status separately.
    // This test verifies the craftsman summaryLine never uses pure escrow language
    // for terminal+transfer states.
    const resultWithTransfer = deriveMoneyFlowProjection(fullyReleasedWithTransfer())
    expect(resultWithTransfer.summaryLine).not.toBe('Vollständig freigegeben')

    const resultWithPayout = deriveMoneyFlowProjection({
      ...fullyReleasedWithTransfer(),
      payoutOutcomesByTransfer: new Map([
        ['tr_dep_abc', 'completed'],
        ['tr_fin_def', 'completed'],
      ]),
    })
    expect(resultWithPayout.summaryLine).toBe('Ausgezahlt')
    // "Vollständig freigegeben" only when there's no transfer status to report
    const resultWithNoTransferInfo = deriveMoneyFlowProjection({
      job: makeJob(),
      escrowPlan: makePlan({ status: 'fully_released' }),
      tranches: [],
      payment: null,
      dispute: null,
      providerPayoutAccount: makePayoutAccount(),
    })
    expect(resultWithNoTransferInfo.summaryLine).toBe('Vollständig freigegeben')
  })
})
