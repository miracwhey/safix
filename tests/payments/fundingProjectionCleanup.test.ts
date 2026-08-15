/**
 * Cross-Surface Funding Projection Cleanup Tests
 *
 * Validates the canonical funded dominance rule:
 * When funded truth exists for a given funding context, pending/required/due
 * (German: fällig) projections for the same context must no longer render
 * as active calls to action.
 *
 * Covers:
 * 1. isFundingConfirmedForJob canonical utility
 * 2. Thread offer artifact: deriveOfferPhase suppresses payment_due when funded
 * 3. Attention selectors: suppress deposit_required attention when funded
 * 4. Next action selectors: skip deposit CTA when funded
 * 5. Customer next action selectors: skip deposit CTA when funded
 * 6. Customer deposit selectors: return deposit_paid when funded
 * 7. Unrelated pending payment contexts are NOT accidentally hidden
 * 8. No regression to funding entry route or funding screen
 * 9. No regression to payment execution assumptions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  isFundingConfirmedForJob,
  getFundingRequestByJobId,
  ensureFundingRequest,
  markFundingCompleted,
  markFundingRequestSent,
  markFundingCancelled,
} from '../../src/lib/payments/fundingRequest'
import { markFundingRequestExpired } from '../../src/lib/payments/fundingRequest/fundingRequestService'
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import { deriveNextAction } from '../../src/lib/jobs/nextActionSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveCustomerDepositAction } from '../../src/lib/jobs/customerDepositSelectors'
import { deriveJobOperationalSummary } from '../../src/lib/jobs/operationalSummarySelectors'
import { addJob } from '../../src/lib/jobs'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-fd-1',
    projectId: 'project-fd-1',
    title: 'Funding Dominance Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '1.000 €',
    description: 'Test',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    proposalSentAt: 1000,
    proposalAcceptedAt: 2000,
    ...overrides,
  }
}

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-fd-1',
    jobId: 'job-fd-1',
    state: 'deposit_required',
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

async function createFundedRequest(jobId: string) {
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: 'escrow-plan-fd-1',
    jobId,
    offerId: 'offer-fd-1',
    totalAmount: 1000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const request = await ensureFundingRequest({
    sourceOfferId: 'offer-fd-1',
    jobId,
    escrowPlanId: 'escrow-plan-fd-1',
    customerUserId: 'customer-fd',
    providerUserId: 'craftsman-fd',
    providerId: 'provider-fd',
    amount: 1000,
  })
  await markFundingRequestSent(request.id)
  await markFundingCompleted(request.id)
  return request
}

async function createPendingRequest(jobId: string, escrowPlanId: string, offerId: string) {
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: escrowPlanId,
    jobId,
    offerId,
    totalAmount: 500,
    currency: 'EUR',
    status: 'awaiting_customer_funding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return await ensureFundingRequest({
    sourceOfferId: offerId,
    jobId,
    escrowPlanId,
    customerUserId: 'customer-fd',
    providerUserId: 'craftsman-fd',
    providerId: 'provider-fd',
    amount: 500,
  })
}

/** Creates a funding request and drives it to a terminal-dead status. */
async function createTerminalDeadRequest(
  jobId: string,
  escrowPlanId: string,
  offerId: string,
  kind: 'expired' | 'cancelled',
) {
  const request = await createPendingRequest(jobId, escrowPlanId, offerId)
  await markFundingRequestSent(request.id)
  if (kind === 'expired') {
    await markFundingRequestExpired(request.id)
  } else {
    await markFundingCancelled(request.id)
  }
  return request
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Cross-surface funding projection cleanup', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Canonical funded dominance utility ────────────────────────────

  describe('isFundingConfirmedForJob', () => {
    it('returns false when no funding request exists for the job', () => {
      expect(isFundingConfirmedForJob('nonexistent-job')).toBe(false)
    })

    it('returns false when funding request exists but is not funded', async () => {
      await createPendingRequest('job-fd-1', 'escrow-plan-pending', 'offer-pending')
      expect(isFundingConfirmedForJob('job-fd-1')).toBe(false)
    })

    it('returns true when funding request exists and is funded', async () => {
      await createFundedRequest('job-fd-1')
      expect(isFundingConfirmedForJob('job-fd-1')).toBe(true)
    })
  })

  // ── 2. Attention selectors — deposit_required suppression ────────────

  describe('attention selectors — funded dominance', () => {
    it('suppresses deposit_required attention when funding is confirmed for the same job', async () => {
      const job = buildJob()
      await addJob(job)
      await createFundedRequest(job.id)

      const items = deriveAttentionItems([job], [], 123456)
      const depositItem = items.find((item) => item.id === `attn-deposit-${job.id}`)

      expect(depositItem).toBeUndefined()
    })

    it('still emits deposit_required attention when funding is NOT confirmed', async () => {
      const job = buildJob()
      await addJob(job)
      await createPendingRequest(job.id, 'escrow-plan-pending', 'offer-pending')

      const items = deriveAttentionItems([job], [], 123456)
      const depositItem = items.find((item) => item.id === `attn-deposit-${job.id}`)

      expect(depositItem).toBeDefined()
      expect(depositItem?.severity).toBe('action')
      expect(depositItem?.title).toBe('Zahlung ausstehend')
    })

    it('does not suppress attention for unrelated jobs', async () => {
      const fundedJob = buildJob({ id: 'job-funded' })
      const pendingJob = buildJob({ id: 'job-pending', projectId: 'project-pending' })
      await addJob(fundedJob)
      await addJob(pendingJob)

      await createFundedRequest(fundedJob.id)
      await createPendingRequest(pendingJob.id, 'escrow-plan-other', 'offer-other')

      const items = deriveAttentionItems([fundedJob, pendingJob], [], 123456)

      // Funded job: no attention
      expect(items.find((i) => i.id === `attn-deposit-${fundedJob.id}`)).toBeUndefined()

      // Pending job: still has attention
      const pendingItem = items.find((i) => i.id === `attn-deposit-${pendingJob.id}`)
      expect(pendingItem).toBeDefined()
      expect(pendingItem?.title).toBe('Zahlung ausstehend')
    })
  })

  // ── 3. Next action selectors — deposit CTA suppression ──────────────

  describe('deriveNextAction — funded dominance', () => {
    it('skips deposit_required CTA when fundingStatus is funded', () => {
      const vm = deriveNextAction('new', 'deposit_required', undefined, 1, 2, 'funded')

      // Should NOT show the deposit-required CTA
      expect(vm.label).not.toBe('Zahlung ausstehend')
    })

    it('shows deposit_required CTA when fundingStatus is NOT funded', () => {
      const vm = deriveNextAction('new', 'deposit_required', undefined, 1, 2, 'sent')

      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung ausstehend')
    })

    it('shows deposit_required CTA when fundingStatus is undefined (backward compat)', () => {
      const vm = deriveNextAction('new', 'deposit_required', undefined, 1, 2)

      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung ausstehend')
    })
  })

  // ── 4. Customer next action selectors — deposit CTA suppression ─────

  describe('deriveCustomerNextAction — funded dominance', () => {
    it('shows funded truth (payment domain) when fundingStatus is funded', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2, 'funded')

      // Funded dominance: instead of falling through to stale job lifecycle,
      // the canonical funded truth is projected on the payment domain.
      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung gesichert')
    })

    it('shows deposit_required CTA when fundingStatus is NOT funded', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2, 'sent')

      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung leisten')
    })

    it('shows deposit_required CTA when fundingStatus is undefined (backward compat)', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2)

      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung leisten')
    })
  })

  // ── 5. Customer deposit selectors — phase override ──────────────────

  describe('deriveCustomerDepositAction — funded dominance', () => {
    it('returns deposit_paid when payment says deposit_required but funding is confirmed', () => {
      const job = buildJob()
      const payment = buildPayment()

      const vm = deriveCustomerDepositAction(job, payment, 'funded')

      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('deposit_paid')
      expect(vm!.customerActionRequired).toBe(false)
      expect(vm!.phaseLabel).toBe('Zahlung bestätigt')
    })

    it('returns deposit_required when funding is NOT confirmed', () => {
      const job = buildJob()
      const payment = buildPayment()

      const vm = deriveCustomerDepositAction(job, payment, 'sent')

      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('deposit_required')
      expect(vm!.customerActionRequired).toBe(true)
    })

    it('returns deposit_required when fundingStatus is undefined (backward compat)', () => {
      const job = buildJob()
      const payment = buildPayment()

      const vm = deriveCustomerDepositAction(job, payment)

      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('deposit_required')
      expect(vm!.customerActionRequired).toBe(true)
    })

    it('does not affect beyond_deposit phase regardless of funding status', () => {
      const job = buildJob()
      const payment = buildPayment({ state: 'in_escrow' })

      const vm = deriveCustomerDepositAction(job, payment, 'funded')

      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('beyond_deposit')
    })
  })

  // ── 6. Context scoping — no accidental global suppression ───────────

  describe('context-scoped suppression', () => {
    it('only suppresses attention for the specific funded job, not globally', async () => {
      const jobA = buildJob({ id: 'job-a' })
      const jobB = buildJob({ id: 'job-b', projectId: 'project-b' })
      await addJob(jobA)
      await addJob(jobB)

      // Only jobA has confirmed funding
      await createFundedRequest(jobA.id)
      await createPendingRequest(jobB.id, 'escrow-b', 'offer-b')

      // Verify dominance check is scoped
      expect(isFundingConfirmedForJob(jobA.id)).toBe(true)
      expect(isFundingConfirmedForJob(jobB.id)).toBe(false)

      // Attention: jobA suppressed, jobB still active
      const items = deriveAttentionItems([jobA, jobB], [], Date.now())
      expect(items.find((i) => i.id === 'attn-deposit-job-a')).toBeUndefined()
      expect(items.find((i) => i.id === 'attn-deposit-job-b')).toBeDefined()
    })
  })

  // ── 7. No regression to non-payment attention ───────────────────────

  describe('no regression to non-payment attention', () => {
    it('disputed payment attention is unaffected by funding dominance', async () => {
      const job = buildJob({ paymentState: 'disputed' })
      await addJob(job)
      await createFundedRequest(job.id) // funded exists but payment is disputed

      const items = deriveAttentionItems([job], [], Date.now())
      const disputeItem = items.find((i) => i.category === 'dispute')

      expect(disputeItem).toBeDefined()
      expect(disputeItem?.title).toBe('Streitfall aktiv')
    })

    it('release_pending attention is unaffected by funding dominance', async () => {
      // release_pending is only emitted during the customer approval phase
      // (job.status === 'waiting_payment') — the phase gate is guarded by
      // attentionSelectors and must not be circumvented by funding dominance.
      const job = buildJob({ status: 'waiting_payment', paymentState: 'release_pending' })
      await addJob(job)
      await createFundedRequest(job.id)

      const items = deriveAttentionItems([job], [], Date.now())
      const releaseItem = items.find((i) => i.title === 'Freigabe erforderlich')

      expect(releaseItem).toBeDefined()
    })
  })

  // ── 8. No regression to deposit_paid next action ────────────────────

  describe('no regression to deposit_paid display', () => {
    it('deposit_paid next action still shows its own label when funded', () => {
      const vm = deriveNextAction('new', 'deposit_paid', undefined, 1, 2, 'funded')

      // deposit_paid is already a funded-level state, so funded dominance
      // does not override it — the deposit_paid-specific branch handles it.
      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung bestätigt')
    })

    it('customer deposit_paid next action still shows its own label when funded', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_paid', undefined, 1, 2, 'funded')

      // deposit_paid is already a funded-level state, so funded dominance
      // does not override it — the deposit_paid-specific branch handles it.
      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlung bestätigt')
    })
  })

  // ── 9. No regression to funding entry route ─────────────────────────

  describe('no regression to funding entry', () => {
    it('funding request is still queryable after marking as funded', async () => {
      const request = await createFundedRequest('job-fd-1')
      const found = getFundingRequestByJobId('job-fd-1')

      expect(found).toBeDefined()
      expect(found!.status).toBe('funded')
      expect(found!.id).toBe(request.id)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Terminal-dead funding (expired / cancelled) — Block-2 customer/HW twin
//
// A terminally-dead raw FundingRequestStatus ('expired' | 'cancelled') must
// never be presented as a pending / payable deposit. The customer must NOT be
// told to pay (the request returns HTTP 409 FUNDING_REQUEST_EXPIRED); the HW
// must be told to send a new request — not that "the customer must pay".
// ═══════════════════════════════════════════════════════════════════════════

describe('Terminal-dead funding presentation (expired / cancelled)', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Customer next action ──────────────────────────────────────────
  describe('deriveCustomerNextAction — terminal-dead', () => {
    it('presents an honest expired action (active, NOT urgent) for expired funding', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2, 'expired')

      expect(vm.domain).toBe('payment')
      expect(vm.label).toBe('Zahlungsanfrage abgelaufen')
      expect(vm.priority).toBe('active')
      expect(vm.priority).not.toBe('urgent')
      expect(vm.label).not.toBe('Zahlung leisten')
    })

    it('presents an honest expired action for cancelled funding', () => {
      const vm = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2, 'cancelled')

      expect(vm.label).toBe('Zahlungsanfrage abgelaufen')
      expect(vm.priority).toBe('active')
    })

    it('regression: still shows urgent "Zahlung leisten" for a genuinely pending status', () => {
      const sent = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2, 'sent')
      const undef = deriveCustomerNextAction('new', 'deposit_required', undefined, 1, 2)

      expect(sent.label).toBe('Zahlung leisten')
      expect(sent.priority).toBe('urgent')
      expect(undef.label).toBe('Zahlung leisten')
      expect(undef.priority).toBe('urgent')
    })
  })

  // ── 2. Customer deposit selector ─────────────────────────────────────
  describe('deriveCustomerDepositAction — terminal-dead', () => {
    it('returns funding_expired phase with NO customer action for expired funding', () => {
      const vm = deriveCustomerDepositAction(buildJob(), buildPayment(), 'expired')

      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('funding_expired')
      expect(vm!.customerActionRequired).toBe(false)
      expect(vm!.phaseLabel).toBe('Anfrage abgelaufen')
    })

    it('returns funding_expired phase for cancelled funding', () => {
      const vm = deriveCustomerDepositAction(buildJob(), buildPayment(), 'cancelled')

      expect(vm!.phase).toBe('funding_expired')
      expect(vm!.customerActionRequired).toBe(false)
    })

    it('regression: pending status still requires customer action', () => {
      const sent = deriveCustomerDepositAction(buildJob(), buildPayment(), 'sent')
      const undef = deriveCustomerDepositAction(buildJob(), buildPayment())

      expect(sent!.phase).toBe('deposit_required')
      expect(sent!.customerActionRequired).toBe(true)
      expect(undef!.phase).toBe('deposit_required')
      expect(undef!.customerActionRequired).toBe(true)
    })
  })

  // ── 3. Operational summary blocker (HW thread) ───────────────────────
  describe('deriveJobOperationalSummary — terminal-dead blocker', () => {
    function summaryFor(fundingStatus?: string) {
      return deriveJobOperationalSummary({
        jobId: 'job-fd-1',
        jobStatus: 'new',
        paymentState: 'deposit_required',
        disputeStatus: undefined,
        schedulingStatus: undefined,
        schedule: undefined,
        artifactCount: 0,
        timelineSignals: [],
        proposalSentAt: 1,
        proposalAcceptedAt: 2,
        fundingStatus,
      })
    }

    it('blocks with funding_expired (HW must act, customer must NOT) for expired funding', () => {
      const summary = summaryFor('expired')

      expect(summary.blocker.reason).toBe('funding_expired')
      expect(summary.blocker.label).toBe('Zahlungsanfrage abgelaufen')
      expect(summary.blocker.isBlocking).toBe(true)
      expect(summary.blocker.isDisplayed).toBe(true)
      expect(summary.requiresCraftsmanAction).toBe(true)
      expect(summary.requiresCustomerAction).toBe(false)
    })

    it('blocks with funding_expired for cancelled funding', () => {
      expect(summaryFor('cancelled').blocker.reason).toBe('funding_expired')
    })

    it('HW next action mirrors the blocker (no "Kunde muss zahlen") for expired funding', () => {
      const summary = summaryFor('expired')

      expect(summary.nextAction.label).toBe('Zahlungsanfrage abgelaufen')
      expect(summary.nextAction.label).not.toBe('Zahlung ausstehend')
    })

    it('regression: pending funding still blocks with awaiting_deposit (customer must pay)', () => {
      const summary = summaryFor('sent')

      expect(summary.blocker.reason).toBe('awaiting_deposit')
      expect(summary.requiresCustomerAction).toBe(true)
      expect(summary.requiresCraftsmanAction).toBe(false)
      expect(summary.nextAction.label).toBe('Zahlung ausstehend')
    })
  })

  // ── 4. Craftsman next action (folded-in twin) ────────────────────────
  describe('deriveNextAction (craftsman) — terminal-dead', () => {
    it('presents expired instead of "Zahlung ausstehend" for expired funding', () => {
      const vm = deriveNextAction('new', 'deposit_required', undefined, 1, 2, 'expired')

      expect(vm.label).toBe('Zahlungsanfrage abgelaufen')
      expect(vm.label).not.toBe('Zahlung ausstehend')
    })

    it('regression: pending funding still shows "Zahlung ausstehend"', () => {
      expect(deriveNextAction('new', 'deposit_required', undefined, 1, 2, 'sent').label)
        .toBe('Zahlung ausstehend')
      expect(deriveNextAction('new', 'deposit_required', undefined, 1, 2).label)
        .toBe('Zahlung ausstehend')
    })
  })

  // ── 5. Attention selectors (folded-in twin) ──────────────────────────
  describe('deriveAttentionItems — terminal-dead', () => {
    it('does NOT emit a customer pay-now attention for an expired funding request', async () => {
      const job = buildJob()
      await addJob(job)
      await createTerminalDeadRequest(job.id, 'escrow-plan-expired', 'offer-expired', 'expired')

      const items = deriveAttentionItems([job], [], Date.now())

      expect(items.find((i) => i.id === `attn-deposit-${job.id}`)).toBeUndefined()
    })

    it('does NOT emit a customer pay-now attention for a cancelled funding request', async () => {
      const job = buildJob()
      await addJob(job)
      await createTerminalDeadRequest(job.id, 'escrow-plan-cancelled', 'offer-cancelled', 'cancelled')

      const items = deriveAttentionItems([job], [], Date.now())

      expect(items.find((i) => i.id === `attn-deposit-${job.id}`)).toBeUndefined()
    })

    it('regression: still emits the pay attention for a genuinely pending request', async () => {
      const job = buildJob()
      await addJob(job)
      await createPendingRequest(job.id, 'escrow-plan-pending', 'offer-pending')

      const items = deriveAttentionItems([job], [], Date.now())
      const depositItem = items.find((i) => i.id === `attn-deposit-${job.id}`)

      expect(depositItem).toBeDefined()
      expect(depositItem?.title).toBe('Zahlung ausstehend')
    })
  })
})
