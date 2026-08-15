/**
 * Finance ↔ MoneyFlowProjection Alignment Tests
 *
 * Verifies that CraftsmanPayoutSummary and MoneyFlowProjection produce
 * consistent amounts for the same job. Both must use the canonical amount
 * hierarchy: EscrowPlan → Offer → Job → payment.amounts fallback.
 *
 * Block 7E invariant: No split brain between Job Detail and Finance Screen.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveMoneyFlowProjection,
} from '../../src/lib/payments/moneyFlowProjection'
import type { Dispute } from '../../src/lib/disputes/types'
import {
  deriveCraftsmanPayoutSummary,
} from '../../src/lib/payout/craftsmanPayoutSummary'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'

// ── Shared fixtures ────────────────────────────────────────────────────────

const JOB_ID = 'align-job-1'
const PAYMENT_ID = 'align-pay-1'
const CRAFTSMAN = 'align-craftsman-1'
const GROSS = 2300

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    title: 'Alignment Test Job',
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
    id: 'plan-align-1',
    sourceOfferId: 'offer-align-1',
    jobId: JOB_ID,
    customerUserId: 'customer-1',
    providerId: CRAFTSMAN,
    currency: 'EUR',
    totalAmount: GROSS,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'funded_in_escrow',
    platformFeeRate: 0.09,
    platformFeeAmount: Number((GROSS * 0.09).toFixed(2)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeTranches(): EscrowTranche[] {
  const dep = Number(((GROSS * 25) / 100).toFixed(2))
  const fin = Number((GROSS - dep).toFixed(2))
  return [
    {
      id: 'tr-dep',
      planId: 'plan-align-1',
      kind: 'deposit_release',
      percentage: 25,
      amount: dep,
      releaseTrigger: 'work_started',
      status: 'funded',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'tr-fin',
      planId: 'plan-align-1',
      kind: 'final_release',
      percentage: 75,
      amount: fin,
      releaseTrigger: 'work_completed',
      status: 'funded',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    jobId: JOB_ID,
    craftsmanUserId: CRAFTSMAN,
    state: 'in_escrow',
    amounts: { totalAmount: GROSS, depositAmount: 575, finalAmount: 1725 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

function makePayoutAccount(overrides: Partial<ProviderPayoutAccount> = {}): ProviderPayoutAccount {
  return {
    id: 'acc-align-1',
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

// ── Alignment tests ────────────────────────────────────────────────────────

describe('Finance ↔ MoneyFlowProjection alignment', () => {
  describe('Amount consistency', () => {
    it('both systems use the same gross amount for in_escrow payment', () => {
      const plan = makePlan()
      const payment = makePayment({ state: 'in_escrow' })
      const account = makePayoutAccount()

      // MoneyFlowProjection — pure, explicit inputs
      const mfp = deriveMoneyFlowProjection({
        job: makeJob(),
        escrowPlan: plan,
        tranches: makeTranches(),
        payment,
        dispute: null,
        providerPayoutAccount: account,
      })

      // CraftsmanPayoutSummary — in test context, resolveCanonicalAmount
      // returns null (no store), falls back to payment.amounts.totalAmount.
      // Both should use GROSS (2300).
      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], [], account,
      )

      // MoneyFlowProjection uses escrowPlan.totalAmount
      expect(mfp.totalAmount).toBe(GROSS)
      // CraftsmanPayoutSummary uses canonical amount (fallback = payment.amounts.totalAmount = GROSS)
      expect(cps.inEscrowGross).toBe(GROSS)
      // Both agree
      expect(mfp.totalAmount).toBe(cps.inEscrowGross)
    })

    it('both systems agree on fee rate and net calculation', () => {
      const plan = makePlan()
      const payment = makePayment({ state: 'in_escrow' })
      const account = makePayoutAccount()

      const mfp = deriveMoneyFlowProjection({
        job: makeJob(),
        escrowPlan: plan,
        tranches: makeTranches(),
        payment,
        dispute: null,
        providerPayoutAccount: account,
      })

      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], [], account,
      )

      // Both use resolveJobFeeRate which defaults to 9% in test context
      const expectedFeeRate = 0.09
      const expectedNet = Number((GROSS * (1 - expectedFeeRate)).toFixed(2))

      expect(mfp.platformFeeRate).toBe(expectedFeeRate)
      expect(mfp.providerNetAmount).toBe(expectedNet)
      expect(cps.inEscrowNetEstimated).toBe(expectedNet)
    })

    it('released payment: MoneyFlowProjection and CraftsmanPayoutSummary agree on gross', () => {
      const plan = makePlan({ status: 'fully_released' })
      const payment = makePayment({ state: 'released' })
      const account = makePayoutAccount()

      const mfp = deriveMoneyFlowProjection({
        job: makeJob({ status: 'completed' }),
        escrowPlan: plan,
        tranches: makeTranches().map(t => ({
          ...t,
          status: 'released' as const,
          releasedAt: Date.now(),
        })),
        payment,
        dispute: null,
        providerPayoutAccount: account,
      })

      // CraftsmanPayoutSummary with ledger entries for exact amounts
      const netAmount = Number((GROSS * 0.88).toFixed(2))
      const feeAmount = Number((GROSS * 0.12).toFixed(2))
      const ledger: LedgerEntry[] = [
        makeLedgerEntry({ type: 'payout', paymentId: PAYMENT_ID, jobId: JOB_ID, amount: netAmount }),
        makeLedgerEntry({ type: 'platform_fee', paymentId: PAYMENT_ID, jobId: JOB_ID, amount: feeAmount }),
      ]
      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], ledger, account,
      )

      // Both use the same gross amount
      expect(mfp.totalAmount).toBe(GROSS)
      const entry = cps.perJob.find(e => e.paymentId === PAYMENT_ID)!
      expect(entry.grossAmount).toBe(GROSS)
    })

    it('disputed payment: both systems identify the same frozen amount', () => {
      const plan = makePlan({ status: 'disputed' })
      const payment = makePayment({ state: 'disputed' })
      const account = makePayoutAccount()

      const mfp = deriveMoneyFlowProjection({
        job: makeJob(),
        escrowPlan: plan,
        tranches: makeTranches().map(t => ({
          ...t,
          status: 'disputed' as const,
        })),
        payment,
        dispute: {
          id: 'dispute-1',
          jobId: JOB_ID,
          status: 'open',
          reason: 'quality_issue',
          title: 'Test Dispute',
          description: 'Test',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as Dispute,
        providerPayoutAccount: account,
      })

      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], [], account,
      )

      // Both flag disputed state
      expect(mfp.isDisputed).toBe(true)
      expect(cps.disputedGross).toBe(GROSS)
      // Total amount matches
      expect(mfp.totalAmount).toBe(GROSS)
    })
  })

  describe('Payout status alignment', () => {
    it('released payment without transfer evidence: neither system claims "ausgezahlt"', () => {
      const plan = makePlan({ status: 'fully_released' })
      const payment = makePayment({ state: 'released' })
      const account = makePayoutAccount()

      const mfp = deriveMoneyFlowProjection({
        job: makeJob({ status: 'completed' }),
        escrowPlan: plan,
        tranches: makeTranches().map(t => ({
          ...t,
          status: 'released' as const,
          releasedAt: Date.now(),
          // NO externalReleaseRef — no transfer evidence
        })),
        payment,
        dispute: null,
        providerPayoutAccount: account,
      })

      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], [], account,
      )

      // MoneyFlowProjection: does NOT say transfer_triggered
      expect(mfp.payoutStatus).not.toBe('transfer_triggered')
      // CraftsmanPayoutSummary: uses "Auszahlbar" (eligible, not "ausgezahlt")
      // The amount lands in releasedPayoutEligible, which means "can be paid out"
      // not "has been paid out"
      expect(cps.releasedPayoutEligible).toBeGreaterThan(0)
    })

    it('blocked payout account: both systems flag the block', () => {
      const plan = makePlan()
      const payment = makePayment({ state: 'in_escrow' })
      const blockedAccount = makePayoutAccount({ payoutsEnabled: false })

      const mfp = deriveMoneyFlowProjection({
        job: makeJob({ status: 'in_progress' }),
        escrowPlan: plan,
        tranches: makeTranches().map(t => ({
          ...t,
          status: 'eligible_for_release' as const,
        })),
        payment,
        dispute: null,
        providerPayoutAccount: blockedAccount,
      })

      // MoneyFlowProjection flags payout block
      expect(mfp.blockingReason).toBe('blocked_by_provider_readiness')

      // CraftsmanPayoutSummary flags payout not ready
      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN,
        [makePayment({ state: 'released' })],
        [],
        blockedAccount,
      )
      expect(cps.releasedPayoutBlocked).toBeGreaterThan(0)
      expect(cps.releasedPayoutEligible).toBe(0)
      expect(cps.payoutBlockingReason).not.toBeNull()
    })
  })

  describe('Terminology alignment', () => {
    it('MoneyFlowProjection never uses "ausgezahlt" without transfer evidence', () => {
      const plan = makePlan({ status: 'fully_released' })
      const mfp = deriveMoneyFlowProjection({
        job: makeJob({ status: 'completed' }),
        escrowPlan: plan,
        tranches: makeTranches().map(t => ({
          ...t,
          status: 'released' as const,
          releasedAt: Date.now(),
        })),
        payment: makePayment({ state: 'released' }),
        dispute: null,
        providerPayoutAccount: makePayoutAccount(),
      })

      // Without externalReleaseRef, payoutStatus must not be transfer_triggered
      expect(mfp.payoutStatus).not.toBe('transfer_triggered')
      // Summary line should say "freigegeben" or "abgeschlossen", never "ausgezahlt"
      expect(mfp.summaryLine.toLowerCase()).not.toContain('ausgezahlt')
    })

    it('CraftsmanPayoutSummary label "Auszahlbar" ≠ "Ausgezahlt"', () => {
      // This is a documentation test: the HeroPayoutCard shows "Auszahlbar"
      // (eligible for payout) not "Ausgezahlt" (paid out).
      // The CraftsmanPayoutSummary field is "releasedPayoutEligible" — not
      // "paidOut" or "transferred".
      const payment = makePayment({ state: 'released' })
      const account = makePayoutAccount()
      const cps = deriveCraftsmanPayoutSummary(
        CRAFTSMAN, [payment], [], account,
      )

      // Field name is "releasedPayoutEligible" — correctly indicates eligibility
      expect(cps).toHaveProperty('releasedPayoutEligible')
      // There is no "paidOut" or "transferred" field — correct
      expect(cps).not.toHaveProperty('paidOut')
      expect(cps).not.toHaveProperty('transferredAmount')
    })
  })
})
