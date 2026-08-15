/**
 * Craftsman Job Operations + Funding Step Card + Customer Funding Flow
 *
 * Tests that the operational bridge works correctly across the app:
 * 1. Provider can send quote without Stripe Connect
 * 2. Provider can create/send funding request without Stripe Connect
 * 3. Customer can reach the correct funding flow from the funding step card
 * 4. Funding step remains tied to accepted quote/job/escrow plan
 * 5. work_started persists and makes the 25% tranche eligible
 * 6. work_completed persists and makes the 75% tranche eligible
 * 7. Payout/release remains blocked when payout readiness is incomplete
 * 8. No duplicate funding requests on repeated actions
 * 9. Project/job/thread surfaces remain aligned after reload/re-entry
 * 10. No regression to quote lifecycle
 * 11. No regression to relationship-thread logic
 * 12. No regression to participant scoping
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  startJobWorkflow,
  markWorkCompleteWorkflow,
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  markDepositPaidForJobWorkflow,
  lockEscrowWorkflow,
} from '../../src/lib/workflow'
import { getJobById } from '../../src/lib/jobs'
import { getOfferById } from '../../src/lib/offers'
import {
  getEscrowPlanByOfferId,
  getEscrowPlanByJobId,
  getEscrowTranches,
  confirmFunding,
  releaseTranche,
} from '../../src/lib/payments/escrow'
import {
  getFundingRequestByJobId,
  getFundingRequestByPlanId,
  getAllFundingRequests,
} from '../../src/lib/payments/fundingRequest'
import {
  canProviderSendQuote,
  canProviderTriggerFundingStep,
  canProviderReceivePayout,
  canCompleteRelease,
  derivePaymentGatingSummary,
} from '../../src/lib/payout/paymentGatingRules'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-ops-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-ops',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-ops',
    projectTitle: 'Job Operations Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

const NO_STRIPE_ACCOUNT: ProviderPayoutAccount | null = null

const INCOMPLETE_ACCOUNT: ProviderPayoutAccount = {
  id: 'acc-incomplete',
  providerUserId: 'craftsman-ops',
  stripeConnectAccountId: 'acct_incomplete',
  onboardingStatus: 'onboarding_in_progress',
  chargesEnabled: false,
  payoutsEnabled: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const READY_ACCOUNT: ProviderPayoutAccount = {
  id: 'acc-ready',
  providerUserId: 'craftsman-ops',
  stripeConnectAccountId: 'acct_ready',
  onboardingStatus: 'onboarding_complete',
  chargesEnabled: true,
  payoutsEnabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

async function createAcceptedOffer(conversationId = 'conv-ops-001') {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId,
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    price: '8.000 €',
    description: 'Full renovation work',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  return { offer: accepted, conversation: conv }
}

/**
 * Simulates the full customer funding flow:
 * deposit_required → deposit_paid → in_escrow
 * Also confirms funding on the escrow plan.
 */
async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Craftsman Job Operations + Funding Flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── Part A: Provider can send quote without Stripe Connect ────────────

  describe('1. provider can send quote without Stripe Connect', () => {
    it('canProviderSendQuote returns allowed for null account', () => {
      const decision = canProviderSendQuote(NO_STRIPE_ACCOUNT)
      expect(decision.allowed).toBe(true)
    })

    it('canProviderSendQuote returns allowed for incomplete account', () => {
      const decision = canProviderSendQuote(INCOMPLETE_ACCOUNT)
      expect(decision.allowed).toBe(true)
    })

    it('can create a quote offer without Stripe Connect', async () => {
      const conv = makeConversation('conv-quote-no-stripe')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '5.000 €',
        description: 'Work without Stripe setup',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('5.000 €')
    })
  })

  // ── Part B: Provider can create/send funding request without Stripe ───

  describe('2. provider can create/send funding request without Stripe Connect', () => {
    it('canProviderTriggerFundingStep returns allowed for null account', () => {
      const decision = canProviderTriggerFundingStep(NO_STRIPE_ACCOUNT)
      expect(decision.allowed).toBe(true)
    })

    it('canProviderTriggerFundingStep returns allowed for incomplete account', () => {
      const decision = canProviderTriggerFundingStep(INCOMPLETE_ACCOUNT)
      expect(decision.allowed).toBe(true)
    })

    it('provider can send funding request after offer acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-send')
      const job = getJobById(offer.createdJobId!)
      expect(job).toBeDefined()

      installSessionForJobOwner(job!)
      const result = await requestFundingWorkflow(job!.id)
      expect(result).toBeDefined()
      expect(result!.status).toBe('sent')
      expect(result!.amount).toBe(8000)
    })

    it('funding request is tied to escrow plan', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-tied')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)

      expect(fundingRequest).toBeDefined()
      expect(escrowPlan).toBeDefined()
      expect(fundingRequest!.escrowPlanId).toBe(escrowPlan!.id)
      expect(fundingRequest!.sourceOfferId).toBe(offer.id)
      expect(fundingRequest!.jobId).toBe(job.id)
    })
  })

  // ── Part C: Customer can reach correct funding flow ───────────────────

  describe('3. customer can reach the correct funding flow from the funding step card', () => {
    it('customerFundingEntryWorkflow connects to persisted funding request', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-entry')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Provider sends funding request first
      await requestFundingWorkflow(job.id)

      // Customer enters funding flow
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeTruthy()
      expect(result!.escrowPlanId).toBeTruthy()
      expect(result!.sourceOfferId).toBe(offer.id)
      expect(result!.amount).toBe(8000)
      expect(result!.status).toBe('funding_started')
    })

    it('customerFundingEntryWorkflow returns undefined without funding request', async () => {
      const { offer } = await createAcceptedOffer('conv-no-request')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // No funding request sent yet
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)
      expect(result).toBeUndefined()
    })

    it('funding entry validates offer linkage', async () => {
      const { offer } = await createAcceptedOffer('conv-linkage')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      // Verify the linkage chain is intact
      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const fundingRequest = getFundingRequestByJobId(job.id)!
      expect(fundingRequest.sourceOfferId).toBe(escrowPlan.sourceOfferId)
      expect(result!.sourceOfferId).toBe(offer.id)
    })
  })

  // ── Part D: Funding step tied to accepted quote/job/escrow plan ───────

  describe('4. funding step remains tied to accepted quote/job/escrow plan', () => {
    it('funding request amount matches escrow plan total', async () => {
      const { offer } = await createAcceptedOffer('conv-amount-match')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const result = await requestFundingWorkflow(job.id)
      const escrowPlan = getEscrowPlanByJobId(job.id)!

      expect(result!.amount).toBe(escrowPlan.totalAmount)
      expect(result!.amount).toBe(8000)
    })

    it('funding request links to correct customer and provider', async () => {
      const { offer } = await createAcceptedOffer('conv-identity')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)!

      expect(fundingRequest.customerUserId).toBe('customer-ops')
      expect(fundingRequest.providerUserId).toBe('craftsman-ops')
    })

    it('funding request has type full_escrow', async () => {
      const { offer } = await createAcceptedOffer('conv-type')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)!

      expect(fundingRequest.type).toBe('full_escrow')
    })
  })

  // ── Part E: work_started makes 25% tranche eligible ──────────────────

  describe('5. work_started persists and makes 25% tranche eligible', () => {
    it('startJobWorkflow triggers deposit_release tranche eligibility', async () => {
      const { offer } = await createAcceptedOffer('conv-work-start')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Fund the escrow (deposit_required → deposit_paid → in_escrow)
      await simulateCustomerFunding(job.id)

      // Start the job
      const started = await startJobWorkflow(job.id)
      expect(started).toBeDefined()
      expect(started!.status).toBe('in_progress')

      // Check that deposit tranche is eligible for release
      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const depositTranche = tranches.find(t => t.kind === 'deposit_release')!
      expect(depositTranche.status).toBe('eligible_for_release')
      expect(depositTranche.triggeredBy).toBe('provider')
    })

    it('final_release tranche remains funded (not eligible) after work start', async () => {
      const { offer } = await createAcceptedOffer('conv-final-not-eligible')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const finalTranche = tranches.find(t => t.kind === 'final_release')!
      expect(finalTranche.status).toBe('funded')
    })
  })

  // ── Part F: work_completed makes 75% tranche eligible ────────────────

  describe('6. work_completed persists and makes 75% tranche eligible', () => {
    it('markWorkCompleteWorkflow triggers final_release tranche eligibility', async () => {
      const { offer } = await createAcceptedOffer('conv-work-complete')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)
      await markWorkCompleteWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const finalTranche = tranches.find(t => t.kind === 'final_release')!
      expect(finalTranche.status).toBe('eligible_for_release')
      expect(finalTranche.triggeredBy).toBe('provider')
    })

    it('workCompletedAt timestamp is set on the job', async () => {
      const { offer } = await createAcceptedOffer('conv-wc-timestamp')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)
      await markWorkCompleteWorkflow(job.id)

      const updated = getJobById(job.id)!
      expect(updated.workCompletedAt).toBeDefined()
      expect(updated.workCompletedAt).toBeGreaterThan(0)
    })

    it('both tranches are eligible after full lifecycle', async () => {
      const { offer } = await createAcceptedOffer('conv-both-eligible')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)
      await markWorkCompleteWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const deposit = tranches.find(t => t.kind === 'deposit_release')!
      const final = tranches.find(t => t.kind === 'final_release')!

      expect(deposit.status).toBe('eligible_for_release')
      expect(final.status).toBe('eligible_for_release')
    })
  })

  // ── Part G: Payout/release blocked without payout readiness ───────────

  describe('7. payout/release remains blocked when payout readiness is incomplete', () => {
    it('canProviderReceivePayout blocked for null account', () => {
      const decision = canProviderReceivePayout(NO_STRIPE_ACCOUNT)
      expect(decision.allowed).toBe(false)
    })

    it('canCompleteRelease blocked for incomplete account', () => {
      const decision = canCompleteRelease(INCOMPLETE_ACCOUNT)
      expect(decision.allowed).toBe(false)
    })

    it('derivePaymentGatingSummary distinguishes funding vs payout', () => {
      const summary = derivePaymentGatingSummary(INCOMPLETE_ACCOUNT)
      expect(summary.fundingAllowed).toBe(true)
      expect(summary.payoutBlocked).toBe(true)
      expect(summary.releaseBlocked).toBe(true)
    })

    it('release allowed for ready account', () => {
      const decision = canCompleteRelease(READY_ACCOUNT)
      expect(decision.allowed).toBe(true)
    })

    it('releaseTranche blocked when provider not payout-ready', async () => {
      const { offer } = await createAcceptedOffer('conv-payout-block')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const depositTranche = tranches.find(t => t.kind === 'deposit_release')!

      const result = await releaseTranche(depositTranche.id, 'customer', {
        providerPayoutAccount: INCOMPLETE_ACCOUNT,
      })

      expect('error' in result).toBe(true)
    })
  })

  // ── Part H: No duplicate funding requests on repeated actions ────────

  describe('8. no duplicate funding requests on repeated actions', () => {
    it('requestFundingWorkflow is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-idempotent')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const result1 = await requestFundingWorkflow(job.id)
      const result2 = await requestFundingWorkflow(job.id)
      const result3 = await requestFundingWorkflow(job.id)

      expect(result1!.fundingRequestId).toBe(result2!.fundingRequestId)
      expect(result2!.fundingRequestId).toBe(result3!.fundingRequestId)

      const allRequests = getAllFundingRequests()
      const forJob = allRequests.filter(r => r.jobId === job.id)
      expect(forJob.length).toBe(1)
    })

    it('customerFundingEntryWorkflow is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-entry-idemp')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)

      installSessionForJobCustomer(job)
      const entry1 = await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      const entry2 = await customerFundingEntryWorkflow(job.id)

      expect(entry1!.fundingRequestId).toBe(entry2!.fundingRequestId)
      expect(entry1!.escrowPlanId).toBe(entry2!.escrowPlanId)
    })

    it('startJobWorkflow escrow trigger is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-start-idemp')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)

      await startJobWorkflow(job.id)
      // Second call is a no-op (job is already in_progress)
      const secondResult = await startJobWorkflow(job.id)
      expect(secondResult).toBeDefined()

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const depositTranche = tranches.find(t => t.kind === 'deposit_release')!
      expect(depositTranche.status).toBe('eligible_for_release')
    })
  })

  // ── Part I: Project/job/thread surfaces remain aligned ────────────────

  describe('9. project/job/thread surfaces remain aligned after reload/re-entry', () => {
    it('accepted offer creates escrow plan and job with correct linkage', async () => {
      const { offer } = await createAcceptedOffer('conv-aligned')
      const accepted = getOfferById(offer.id)!
      expect(accepted.status).toBe('accepted')

      const job = getJobById(accepted.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.sourceOfferId).toBe(offer.id)
      expect(job.proposalAcceptedAt).toBeDefined()

      const escrowPlan = getEscrowPlanByOfferId(offer.id)!
      expect(escrowPlan.jobId).toBe(job.id)
      expect(escrowPlan.totalAmount).toBe(8000)
    })

    it('customer next step shows escrow funding CTA after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-next-step')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const nextStep = deriveCustomerNextStep(job)
      expect(nextStep.label).toBe('Zahlung einzahlen')
      expect(nextStep.actionLabel).toBe('Jetzt einzahlen')
    })

    it('customer next step shows Work In Progress after job start', async () => {
      const { offer } = await createAcceptedOffer('conv-in-progress')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await simulateCustomerFunding(job.id)
      await startJobWorkflow(job.id)

      const updated = getJobById(job.id)!
      // Payment state is work_in_progress after start
      expect(updated.paymentState).toBe('work_in_progress')

      const nextStep = deriveCustomerNextStep(updated)
      expect(nextStep.label).toBe('Arbeit läuft')
    })

    it('funding request linked to escrow plan can be queried by plan id', async () => {
      const { offer } = await createAcceptedOffer('conv-plan-query')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const fromPlan = getFundingRequestByPlanId(escrowPlan.id)
      const fromJob = getFundingRequestByJobId(job.id)

      expect(fromPlan).toBeDefined()
      expect(fromJob).toBeDefined()
      expect(fromPlan!.id).toBe(fromJob!.id)
    })
  })

  // ── Part J: No regression to quote lifecycle ──────────────────────────

  describe('10. no regression to quote lifecycle', () => {
    it('offer status transitions are intact', async () => {
      const conv = makeConversation('conv-lifecycle')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '3.000 €',
        description: 'Lifecycle test',
      })
      expect(offer.status).toBe('pending')

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted.status).toBe('accepted')
    })

    it('accepting already accepted offer is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-re-accept')

      const reAccepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(reAccepted.status).toBe('accepted')
      expect(reAccepted.createdJobId).toBe(offer.createdJobId)
    })
  })

  // ── Part K: No regression to relationship-thread logic ────────────────

  describe('11. no regression to relationship-thread logic', () => {
    it('accepted offer links job to conversation', async () => {
      const { offer, conversation } = await createAcceptedOffer('conv-thread')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      expect(job.sourceConversationId).toBe(conversation.id)
    })

    it('funding request includes conversation linkage', async () => {
      const { offer, conversation } = await createAcceptedOffer('conv-fr-thread')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)!

      expect(fundingRequest.conversationId).toBe(conversation.id)
    })
  })

  // ── Part L: No regression to participant scoping ──────────────────────

  describe('12. no regression to participant scoping', () => {
    it('funding request preserves customer and provider identity', async () => {
      const { offer, conversation } = await createAcceptedOffer('conv-scope')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)!

      expect(fundingRequest.customerUserId).toBe(conversation.customerUserId)
      expect(fundingRequest.providerUserId).toBe(conversation.craftsmanUserId)
    })

    it('escrow plan preserves customer and provider identity', async () => {
      const { offer, conversation } = await createAcceptedOffer('conv-escrow-scope')
      const escrowPlan = getEscrowPlanByOfferId(offer.id)!

      expect(escrowPlan.customerUserId).toBe(conversation.customerUserId)
    })
  })

  // ── Additional: Full Happy Path ───────────────────────────────────────

  describe('Full operational happy path', () => {
    it('complete lifecycle: quote → accept → fund request → customer entry → fund → start → complete', async () => {
      // 1. Create and accept offer
      const { offer } = await createAcceptedOffer('conv-full-path')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.paymentState).toBe('deposit_required')

      // 2. Provider sends funding request (without Stripe Connect)
      const fundingResult = await requestFundingWorkflow(job.id)
      expect(fundingResult).toBeDefined()
      expect(fundingResult!.status).toBe('sent')
      expect(fundingResult!.amount).toBe(8000)

      // 3. Customer enters funding flow
      installSessionForJobCustomer(job)
      const entryResult = await customerFundingEntryWorkflow(job.id)
      expect(entryResult).toBeDefined()
      expect(entryResult!.amount).toBe(8000)

      // 4. Simulate customer funding (deposit_required → deposit_paid → in_escrow)
      await simulateCustomerFunding(job.id)

      // 5. Provider starts work (triggers 25% eligibility)
      installSessionForJobOwner(job)
      const started = await startJobWorkflow(job.id)
      expect(started!.status).toBe('in_progress')

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranchesAfterStart = getEscrowTranches(escrowPlan.id)
      const depositAfterStart = tranchesAfterStart.find(t => t.kind === 'deposit_release')!
      expect(depositAfterStart.status).toBe('eligible_for_release')

      // 6. Provider completes work (triggers 75% eligibility)
      await markWorkCompleteWorkflow(job.id)

      const tranchesAfterComplete = getEscrowTranches(escrowPlan.id)
      const finalAfterComplete = tranchesAfterComplete.find(t => t.kind === 'final_release')!
      expect(finalAfterComplete.status).toBe('eligible_for_release')

      // 7. Verify job state
      const completedJob = getJobById(job.id)!
      expect(completedJob.workCompletedAt).toBeDefined()
      expect(completedJob.status).toBe('waiting_payment')
    })

    it('requestFundingWorkflow returns undefined for job without accepted quote', async () => {
      const conv = makeConversation('conv-no-accept')
      addConversation(conv)

      const _offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '2.000 €',
        description: 'Not accepted',
      })

      // Try to request funding on a job that doesn't exist yet (offer not accepted)
      const result = await requestFundingWorkflow('nonexistent-job')
      expect(result).toBeUndefined()
    })

    it('full-upfront escrow semantics — customer funds 100%, not 25%', async () => {
      const { offer } = await createAcceptedOffer('conv-full-upfront')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const escrowPlan = getEscrowPlanByJobId(job.id)!
      expect(escrowPlan.fundingMode).toBe('full_upfront_escrow')
      expect(escrowPlan.totalAmount).toBe(8000)

      await requestFundingWorkflow(job.id)
      const fundingRequest = getFundingRequestByJobId(job.id)!
      expect(fundingRequest.type).toBe('full_escrow')
      // Customer funds 100% — not 25%
      expect(fundingRequest.amount).toBe(8000)
    })
  })
})
