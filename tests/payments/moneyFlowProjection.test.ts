/**
 * MoneyFlowProjection — Edge Case Tests
 *
 * Validates the canonical money-flow projection across all documented
 * scenarios from Block 7D.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveMoneyFlowProjection,
  type MoneyFlowProjectionInput,
} from '../../src/lib/payments/moneyFlowProjection'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { Dispute } from '../../src/lib/disputes/types'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Badezimmer Renovierung',
    status: 'booked',
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

function makeInput(overrides: Partial<MoneyFlowProjectionInput> = {}): MoneyFlowProjectionInput {
  const depositTranche = makeTranche({ id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500, releaseTrigger: 'work_started' })
  const finalTranche = makeTranche({ id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500, releaseTrigger: 'work_completed' })

  return {
    job: makeJob(),
    escrowPlan: makePlan(),
    tranches: [depositTranche, finalTranche],
    payment: null,
    dispute: null,
    providerPayoutAccount: makePayoutAccount(),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deriveMoneyFlowProjection', () => {
  describe('Amounts', () => {
    it('derives correct total, fee, and net amounts', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.totalAmount).toBe(2000)
      expect(result.platformFeeRate).toBe(0.09)
      expect(result.platformFeeAmount).toBe(180)
      expect(result.providerNetAmount).toBe(1820)
    })

    it('uses payment amounts as fallback when no escrow plan', () => {
      const payment: Payment = {
        id: 'pay-1',
        jobId: 'job-1',
        state: 'in_escrow',
        amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: null,
        tranches: [],
        payment,
      }))
      expect(result.totalAmount).toBe(1000)
      expect(result.hasEscrowPlan).toBe(false)
    })
  })

  describe('Funding Status', () => {
    it('returns customer_not_paid for awaiting_customer_funding', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
      }))
      expect(result.fundingStatus).toBe('customer_not_paid')
      expect(result.fundingStatusLabel).toBe('Kundenzahlung ausstehend')
    })

    it('returns payment_processing for funding_initiated', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'funding_initiated' }),
      }))
      expect(result.fundingStatus).toBe('payment_processing')
    })

    it('returns payment_processing when fundingRequestStatus is funding_started', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
        fundingRequestStatus: 'funding_started',
      }))
      expect(result.fundingStatus).toBe('payment_processing')
    })

    it('returns funded_in_escrow for funded plans', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.fundingStatus).toBe('funded_in_escrow')
      expect(result.fundingStatusLabel).toBe('Kundenzahlung eingegangen')
    })

    it('returns funding_failed for failed funding', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'funding_failed' }),
      }))
      expect(result.fundingStatus).toBe('funding_failed')
    })

    it('returns no_escrow_plan when no plan exists', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: null,
        tranches: [],
      }))
      expect(result.fundingStatus).toBe('no_escrow_plan')
    })

    it('returns funding_expired when the funding request expired (plan still awaiting)', () => {
      // The expiry cron / sync gate update funding_requests.status only and
      // leave escrow_plans at 'awaiting_customer_funding'. The projection must
      // surface the dead request, not 'customer_not_paid'.
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
        fundingRequestStatus: 'expired',
      }))
      expect(result.fundingStatus).toBe('funding_expired')
      expect(result.fundingStatusLabel).toBe('Zahlungsanfrage abgelaufen')
      // Terminal-dead: nothing for the craftsman to wait on or do here.
      expect(result.primaryAction).toBe('no_action')
      expect(result.blockingReason).toBe('none')
      expect(result.summaryLine).toBe('Zahlungsanfrage abgelaufen')
      // Must NOT masquerade as a still-pending customer payment.
      expect(result.summaryLine).not.toMatch(/ausstehend/i)
    })

    it('returns funding_expired when the funding request was cancelled', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
        fundingRequestStatus: 'cancelled',
      }))
      expect(result.fundingStatus).toBe('funding_expired')
      expect(result.primaryAction).toBe('no_action')
      expect(result.blockingReason).toBe('none')
    })

    it('regression: a genuinely pending request (sent) stays customer_not_paid', () => {
      // The fix must not bleed into the common case — an unfunded-but-live
      // request still reads as customer_not_paid with the wait action.
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
        fundingRequestStatus: 'sent',
      }))
      expect(result.fundingStatus).toBe('customer_not_paid')
      expect(result.fundingStatusLabel).toBe('Kundenzahlung ausstehend')
      expect(result.primaryAction).toBe('wait_for_customer_payment')
      expect(result.blockingReason).toBe('waiting_for_customer_payment')
    })
  })

  describe('Release Status', () => {
    it('shows 0% released when nothing released', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.releasedAmount).toBe(0)
      expect(result.releasedPercent).toBe(0)
    })

    it('shows 25% released when deposit tranche released', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', releasedAt: Date.now(), externalReleaseRef: 'tr_abc' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.releasedAmount).toBe(500)
      expect(result.releasedPercent).toBe(25)
      expect(result.unreleasedAmount).toBe(1500)
    })

    it('shows 100% released when both tranches released with proof', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', releasedAt: Date.now(), externalReleaseRef: 'tr_deposit' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', releasedAt: Date.now(), externalReleaseRef: 'tr_final' }),
        ],
      }))
      expect(result.releasedAmount).toBe(2000)
      expect(result.releasedPercent).toBe(100)
      expect(result.isTerminal).toBe(true)
    })

    it('shows releasableAmount for eligible tranches', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.releasableAmount).toBe(500)
    })
  })

  describe('Payout Status', () => {
    it('returns no_transfer_yet when no tranches released', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.payoutStatus).toBe('no_transfer_yet')
    })

    it('returns transfer_triggered when released tranches have external refs', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_abc123' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.payoutStatus).toBe('transfer_triggered')
      // The label MUST describe a payout hand-off that is on its way to
      // the bank, not a completed bank arrival — `external_release_ref`
      // only proves the Stripe Transfer to the provider's Connected
      // Account; bank delivery is the separate `payout.paid` outcome.
      expect(result.payoutStatusLabel).toBe('Zur Auszahlung übergeben')
      expect(result.payoutStatusLabel).not.toMatch(/ausgelöst/i)
      expect(result.payoutStatusLabel).not.toMatch(/auf deinem konto/i)
    })

    it('returns payout_blocked when released but provider not ready', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_abc' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
        providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
      }))
      expect(result.payoutStatus).toBe('payout_blocked')
    })

    it('returns payout_unknown and requiresReconciliation when released but no external ref', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.payoutStatus).toBe('payout_unknown')
      expect(result.requiresReconciliation).toBe(true)
    })
  })

  describe('Blocking Reason', () => {
    it('returns none when funded and no issues', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
      }))
      expect(result.blockingReason).toBe('none')
    })

    it('returns blocked_by_dispute when dispute is active', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        dispute: { id: 'disp-1', jobId: 'job-1', status: 'open', title: 'Test', reason: 'work_quality', description: '', createdAt: Date.now(), updatedAt: Date.now() } as Dispute,
      }))
      expect(result.blockingReason).toBe('blocked_by_dispute')
      expect(result.isDisputed).toBe(true)
    })

    it('returns waiting_for_customer_payment when not funded', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
      }))
      expect(result.blockingReason).toBe('waiting_for_customer_payment')
    })

    it('returns waiting_for_work_start when funded but work not started', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'booked' }),
      }))
      expect(result.blockingReason).toBe('waiting_for_work_start')
    })

    it('returns blocked_by_provider_readiness when tranche eligible but payout not ready', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
        providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
      }))
      expect(result.blockingReason).toBe('blocked_by_provider_readiness')
    })
  })

  describe('Primary Next Action', () => {
    it('returns wait_for_customer_payment when not funded', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
      }))
      expect(result.primaryAction).toBe('wait_for_customer_payment')
    })

    it('returns start_work when funded and job not started', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'booked' }),
      }))
      expect(result.primaryAction).toBe('start_work')
    })

    it('returns complete_work when deposit tranche still eligible (auto-release pending recovery)', () => {
      // Deposit tranche is auto-released at work start. If still eligible,
      // reconciliation cron will handle it — no manual CTA needed.
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.primaryAction).toBe('complete_work')
    })

    it('returns complete_work when deposit released and work in progress', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.primaryAction).toBe('complete_work')
    })

    it('returns release_final_tranche when final tranche eligible', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'waiting_payment' }),
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'eligible_for_release' }),
        ],
      }))
      expect(result.primaryAction).toBe('release_final_tranche')
    })

    it('returns resolve_dispute when dispute is blocking', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        dispute: { id: 'disp-1', jobId: 'job-1', status: 'under_review', title: 'Test', reason: 'work_quality', description: '', createdAt: Date.now(), updatedAt: Date.now() } as Dispute,
      }))
      expect(result.primaryAction).toBe('resolve_dispute')
    })

    it('returns fix_provider_payout_setup when tranche eligible but payout not ready', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
        providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
      }))
      expect(result.primaryAction).toBe('fix_provider_payout_setup')
    })

    it('returns no_action when fully released', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released' }),
        ],
      }))
      expect(result.primaryAction).toBe('no_action')
      expect(result.isTerminal).toBe(true)
    })
  })

  describe('Tranche Projections', () => {
    it('derives correct per-tranche blocking reason for dispute', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        dispute: { id: 'disp-1', jobId: 'job-1', status: 'open', title: 'Test', reason: 'work_quality', description: '', createdAt: Date.now(), updatedAt: Date.now() } as Dispute,
      }))
      expect(result.tranches[0].isBlocked).toBe(true)
      expect(result.tranches[0].blockingReason).toBe('Freigabe wegen Streitfall blockiert')
    })

    it('derives correct per-tranche blocking reason for payout readiness', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
        providerPayoutAccount: makePayoutAccount({ payoutsEnabled: false }),
      }))
      expect(result.tranches[0].isBlocked).toBe(true)
      expect(result.tranches[0].blockingReason).toContain('Auszahlung')
    })

    it('derives correct label and status for funded tranche', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      const dep = result.tranches.find((t) => t.kind === 'deposit_release')!
      expect(dep.label).toBe('25 % Arbeitsbeginn')
      expect(dep.statusLabel).toBe('Im Stripe-Absicherung')
      expect(dep.isReleased).toBe(false)
      expect(dep.isEligible).toBe(false)
    })

    it('provides release date for released tranche', () => {
      const now = Date.now()
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', releasedAt: now }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      const dep = result.tranches.find((t) => t.kind === 'deposit_release')!
      expect(dep.releasedAt).toBe(now)
      expect(dep.releasedAtFormatted).toBeTruthy()
    })
  })

  describe('Summary Line', () => {
    it('shows dispute summary when disputed', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        dispute: { id: 'disp-1', jobId: 'job-1', status: 'open', title: 'Test', reason: 'work_quality', description: '', createdAt: Date.now(), updatedAt: Date.now() } as Dispute,
      }))
      expect(result.summaryLine).toContain('Streitfall')
    })

    it('shows transfer-in-progress summary for terminal with Stripe Transfer', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_dep123' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', externalReleaseRef: 'tr_fin456' }),
        ],
      }))
      // transfer_triggered = Stripe Transfer created, bank arrival not yet confirmed
      expect(result.payoutStatus).toBe('transfer_triggered')
      expect(result.summaryLine).toBe('Auszahlung in Bearbeitung')
      expect(result.requiresReconciliation).toBe(false)
    })

    it('shows reconciliation summary for terminal with no Stripe Transfer', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released' }),
        ],
      }))
      expect(result.payoutStatus).toBe('payout_unknown')
      expect(result.requiresReconciliation).toBe(true)
      expect(result.summaryLine).toBe('Klärung erforderlich')
    })

    it('shows error summary for terminal with payout_failed', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_dep' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', externalReleaseRef: 'tr_fin' }),
        ],
        payoutOutcomesByTransfer: new Map([['tr_dep', 'failed'], ['tr_fin', 'failed']]),
      }))
      expect(result.payoutStatus).toBe('payout_failed')
      expect(result.requiresReconciliation).toBe(true)
      expect(result.summaryLine).not.toMatch(/vollständig freigegeben/i)
      expect(result.summaryLine).not.toMatch(/ausgezahlt/i)
      expect(result.summaryLine).toMatch(/fehlgeschlagen/i)
    })

    it('shows reversal summary for terminal with transfer_reversed', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_dep', transferReversalRef: 'prv_rev' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', externalReleaseRef: 'tr_fin', transferReversalRef: 'prv_rev2' }),
        ],
      }))
      expect(result.payoutStatus).toBe('transfer_reversed')
      expect(result.requiresReconciliation).toBe(true)
      expect(result.summaryLine).not.toMatch(/vollständig freigegeben/i)
      expect(result.summaryLine).not.toMatch(/ausgezahlt/i)
      expect(result.summaryLine).toMatch(/storniert|nötig|klärung/i)
    })

    it('shows customer payment pending for unfunded', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'awaiting_customer_funding' }),
      }))
      expect(result.summaryLine).toContain('Kundenzahlung')
    })
  })

  describe('Edge Cases', () => {
    it('handles no escrow plan gracefully', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: null,
        tranches: [],
        payment: null,
      }))
      expect(result.hasEscrowPlan).toBe(false)
      expect(result.totalAmount).toBe(0)
      expect(result.tranches).toHaveLength(0)
      expect(result.fundingStatus).toBe('no_escrow_plan')
    })

    it('handles refunded plan correctly', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'refunded' }),
      }))
      expect(result.isTerminal).toBe(true)
      expect(result.fundingStatus).toBe('funded_in_escrow')
    })

    it('handles cancelled plan correctly', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'cancelled' }),
      }))
      expect(result.isTerminal).toBe(true)
    })

    it('claims transfer_triggered (not bank arrival) when all tranches have proof', () => {
      // transfer_triggered is the maximum provable state — we can only confirm
      // the Stripe Transfer to the Connected Account, not a bank payout.
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_abc' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', externalReleaseRef: 'tr_def' }),
        ],
      }))
      expect(result.payoutStatus).toBe('transfer_triggered')
      expect(result.requiresReconciliation).toBe(false)
    })

    it('returns false for requiresReconciliation when transfer is proven', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_abc123' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'funded' }),
        ],
      }))
      expect(result.requiresReconciliation).toBe(false)
    })

    it('returns false for requiresReconciliation when no tranches released at all', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.requiresReconciliation).toBe(false)
      expect(result.payoutStatus).toBe('no_transfer_yet')
    })

    it('returns payout_completed summary for terminal when payout.paid confirmed', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'completed' }),
        escrowPlan: makePlan({ status: 'fully_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 500, status: 'released', externalReleaseRef: 'tr_abc' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 1500, status: 'released', externalReleaseRef: 'tr_def' }),
        ],
        payoutOutcomesByTransfer: new Map([
          ['tr_abc', 'completed'],
          ['tr_def', 'completed'],
        ]),
      }))
      expect(result.payoutStatus).toBe('payout_completed')
      expect(result.requiresReconciliation).toBe(false)
      expect(result.summaryLine).toBe('Ausgezahlt')
    })
  })
})
