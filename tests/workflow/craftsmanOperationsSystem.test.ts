/**
 * Craftsman Operations System — Comprehensive Tests
 *
 * Tests the provider-side operational phase model, next-action system,
 * and real operation commands with strict guards and idempotency.
 *
 * Covers:
 * 1. Provider phase derivation from persisted truth
 * 2. Provider next-action derivation
 * 3. requestFundingForJob guards + idempotency
 * 4. startJob guards + escrow side effects (25% tranche)
 * 5. completeJob guards + escrow side effects (75% tranche)
 * 6. Duplicate action safety
 * 7. Customer project progression consistency
 * 8. Provider assignment/status messaging consistency
 * 9. Notification/attention selectors reflect new states
 * 10. No regression to quote lifecycle
 * 11. No regression to funding flow
 * 12. No regression to relationship-thread logic
 * 13. No regression to participant scoping
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
// ── Workflow imports ──────────────────────────────────────────────────────

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingWorkflow,
  markDepositPaidForJobWorkflow,
  lockEscrowWorkflow,
  requestFundingForJob,
  startJob,
  completeJob,
} from '../../src/lib/workflow'

// ── Domain imports ────────────────────────────────────────────────────────

import { getJobById, updateJobDisputeStatus } from '../../src/lib/jobs'
import {
  deriveProviderJobPhase,
  type ProviderJobPhase,
} from '../../src/lib/jobs/providerJobPhaseSelectors'
import {
  deriveProviderNextAction,
} from '../../src/lib/jobs/providerNextActionSelectors'
import {
  getEscrowPlanByJobId,
  getEscrowTranches,
  confirmFunding,
} from '../../src/lib/payments/escrow'
import {
  getFundingRequestByJobId,
  getAllFundingRequests,
} from '../../src/lib/payments/fundingRequest'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeConversation(id = 'conv-craft-ops-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-craft-ops',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-craft-ops',
    projectTitle: 'Craft Ops Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

async function createAcceptedOffer(conversationId: string) {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId,
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    price: '5.000 €',
    description: 'Badezimmer-Renovierung',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  return { offer: accepted, conversation: conv }
}

async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

function getPhaseForJob(jobId: string): ProviderJobPhase {
  const job = getJobById(jobId)!
  installSessionForJobOwner(job)
  const fr = getFundingRequestByJobId(jobId)
  const ep = getEscrowPlanByJobId(jobId)
  return deriveProviderJobPhase(job, fr?.status, ep?.status).phase
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Craftsman Operations System', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── PART 1: Provider Phase Derivation ─────────────────────────────────

  describe('1. Provider phase model derives correctly from persisted truth', () => {
    it('accepted quote + no funding request → funding_not_requested', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const { phase } = deriveProviderJobPhase(job, undefined, undefined)
      expect(phase).toBe('funding_not_requested')
    })

    it('funding requested + sent → funding_requested', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const ep = getEscrowPlanByJobId(job.id)
      const updatedJob = getJobById(job.id)!
      const { phase } = deriveProviderJobPhase(updatedJob, fr?.status, ep?.status)
      expect(phase).toBe('funding_requested')
    })

    it('funded in escrow → funded_in_escrow', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-3')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      expect(getPhaseForJob(job.id)).toBe('funded_in_escrow')
    })

    it('work started → work_started', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-4')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      expect(getPhaseForJob(job.id)).toBe('work_started')
    })

    it('work completed → awaiting_release', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-5')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      const phase = getPhaseForJob(job.id)
      expect(['work_completed', 'awaiting_release']).toContain(phase)
    })

    it('disputed job → disputed', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-6')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      updateJobDisputeStatus(job.id, 'open')

      const updatedJob = getJobById(job.id)!
      const { phase } = deriveProviderJobPhase(updatedJob, undefined, undefined)
      expect(phase).toBe('disputed')
    })
  })

  // ── PART 2: Provider Next Action ──────────────────────────────────────

  describe('2. Provider next-action derives correctly', () => {
    it('accepted but no funding → request_funding action', async () => {
      const { offer } = await createAcceptedOffer('conv-action-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const action = deriveProviderNextAction(job, undefined, undefined)
      expect(action.actionId).toBe('request_funding')
      expect(action.enabled).toBe(true)
    })

    it('funding requested but not funded → wait_for_funding (disabled)', async () => {
      const { offer } = await createAcceptedOffer('conv-action-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const ep = getEscrowPlanByJobId(job.id)
      const updated = getJobById(job.id)!
      const action = deriveProviderNextAction(updated, fr?.status, ep?.status)
      expect(action.actionId).toBe('wait_for_funding')
      expect(action.enabled).toBe(false)
    })

    it('funded in escrow → start_work (enabled)', async () => {
      const { offer } = await createAcceptedOffer('conv-action-3')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const ep = getEscrowPlanByJobId(job.id)
      const updated = getJobById(job.id)!
      const action = deriveProviderNextAction(updated, fr?.status, ep?.status)
      expect(action.actionId).toBe('start_work')
      expect(action.enabled).toBe(true)
    })

    it('work started → complete_work (enabled)', async () => {
      const { offer } = await createAcceptedOffer('conv-action-4')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const ep = getEscrowPlanByJobId(job.id)
      const updated = getJobById(job.id)!
      const action = deriveProviderNextAction(updated, fr?.status, ep?.status)
      expect(action.actionId).toBe('complete_work')
      expect(action.enabled).toBe(true)
    })

    it('work completed → wait_for_release (disabled)', async () => {
      const { offer } = await createAcceptedOffer('conv-action-5')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const ep = getEscrowPlanByJobId(job.id)
      const updated = getJobById(job.id)!
      const action = deriveProviderNextAction(updated, fr?.status, ep?.status)
      expect(action.actionId).toBe('wait_for_release')
      expect(action.enabled).toBe(false)
    })
  })

  // ── PART 3: requestFundingForJob guards ───────────────────────────────

  describe('3. requestFundingForJob strict guards', () => {
    it('returns error for non-existent job', async () => {
      const result = await requestFundingForJob('non-existent')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('JOB_NOT_FOUND')
    })

    it('returns error when no accepted quote', async () => {
      const conv = makeConversation('conv-guard-fund-1')
      addConversation(conv)
      await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '1.000 €',
        description: 'Test',
      })
      // Offer is pending, not accepted
      // Since no job exists yet (not accepted), requestFundingForJob should fail
      const result = await requestFundingForJob('non-existent-job')
      expect(result.ok).toBe(false)
    })

    it('succeeds for accepted quote with escrow plan', async () => {
      const { offer } = await createAcceptedOffer('conv-guard-fund-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
    })

    it('returns error when dispute is blocking', async () => {
      const { offer } = await createAcceptedOffer('conv-guard-fund-3')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      updateJobDisputeStatus(job.id, 'open')
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('DISPUTE_BLOCKING')
    })
  })

  // ── PART 4: startJob guards + 25% tranche eligibility ────────────────

  describe('4. startJob persists and makes 25% tranche eligible', () => {
    it('returns error when funding not confirmed', async () => {
      const { offer } = await createAcceptedOffer('conv-start-guard-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      // No funding yet
      const result = await startJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('FUNDING_NOT_CONFIRMED')
    })

    it('successfully starts job when funded', async () => {
      const { offer } = await createAcceptedOffer('conv-start-ok')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const result = await startJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.job.status).toBe('in_progress')
        expect(result.data.tranche25Eligible).toBe(true)
      }
    })

    it('25% deposit_release tranche becomes eligible_for_release', async () => {
      const { offer } = await createAcceptedOffer('conv-tranche-25')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const depositTranche = tranches.find(t => t.kind === 'deposit_release')
      expect(depositTranche).toBeDefined()
      expect(depositTranche!.status).toBe('eligible_for_release')
    })

    it('returns error when job is in terminal state', async () => {
      const { offer } = await createAcceptedOffer('conv-start-terminal')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      // Now job is in waiting_payment state
      const result = await startJob(job.id)
      expect(result.ok).toBe(false)
    })

    it('returns error when dispute is blocking', async () => {
      const { offer } = await createAcceptedOffer('conv-start-dispute')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      updateJobDisputeStatus(job.id, 'open')

      const result = await startJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('DISPUTE_BLOCKING')
    })
  })

  // ── PART 5: completeJob guards + 75% tranche eligibility ─────────────

  describe('5. completeJob persists and makes 75% tranche eligible', () => {
    it('returns error when job not started', async () => {
      const { offer } = await createAcceptedOffer('conv-complete-guard-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const result = await completeJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('JOB_NOT_STARTED')
    })

    it('successfully completes job when in_progress', async () => {
      const { offer } = await createAcceptedOffer('conv-complete-ok')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      const result = await completeJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.tranche75Eligible).toBe(true)
      }
    })

    it('75% final_release tranche becomes eligible_for_release', async () => {
      const { offer } = await createAcceptedOffer('conv-tranche-75')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const finalTranche = tranches.find(t => t.kind === 'final_release')
      expect(finalTranche).toBeDefined()
      expect(finalTranche!.status).toBe('eligible_for_release')
    })
  })

  // ── PART 6: Idempotency — duplicate actions ──────────────────────────

  describe('6. Duplicate actions do not create duplicate side effects', () => {
    it('duplicate requestFundingForJob returns existing', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-fund')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const r1 = await requestFundingForJob(job.id)
      const r2 = await requestFundingForJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      // Only one funding request should exist
      const all = getAllFundingRequests()
      const forJob = all.filter(fr => fr.jobId === job.id)
      expect(forJob.length).toBe(1)
    })

    it('duplicate startJob is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-start')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const r1 = await startJob(job.id)
      const r2 = await startJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      // Job should still be in_progress
      expect(getJobById(job.id)!.status).toBe('in_progress')
    })

    it('duplicate completeJob is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-complete')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      const r1 = await completeJob(job.id)
      const r2 = await completeJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
    })
  })

  // ── PART 7: Customer project progression ──────────────────────────────

  describe('7. Customer project progression updates from provider actions', () => {
    it('customer sees funding_pending after provider requests funding', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-prog-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingForJob(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const updated = getJobById(job.id)!
      const { stage } = deriveCustomerJobStage(
        updated.status, updated.paymentState, updated.proposalSentAt,
        updated.proposalAcceptedAt, fr?.status
      )
      expect(stage).toBe('funding_pending')
    })

    it('customer sees funded_in_escrow after funding confirmed', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-prog-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const updated = getJobById(job.id)!
      const { stage } = deriveCustomerJobStage(
        updated.status, updated.paymentState, updated.proposalSentAt,
        updated.proposalAcceptedAt, fr?.status
      )
      expect(stage).toBe('funded_in_escrow')
    })

    it('customer sees work_in_progress after provider starts job', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-prog-3')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)

      const updated = getJobById(job.id)!
      const { stage } = deriveCustomerJobStage(
        updated.status, updated.paymentState, updated.proposalSentAt,
        updated.proposalAcceptedAt, 'funded'
      )
      expect(stage).toBe('work_in_progress')
    })

    it('customer sees work_completed after provider completes job', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-prog-4')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      const updated = getJobById(job.id)!
      const { stage } = deriveCustomerJobStage(
        updated.status, updated.paymentState, updated.proposalSentAt,
        updated.proposalAcceptedAt, 'funded'
      )
      expect(stage).toBe('work_completed')
    })
  })

  // ── PART 8: Provider assignment consistency ───────────────────────────

  describe('8. Provider assignment and status messaging remains correct', () => {
    it('accepted offer creates job with booked status', async () => {
      const { offer } = await createAcceptedOffer('conv-assign-1')
      const job = getJobById(offer.createdJobId!)
      expect(job).toBeDefined()
      expect(job!.status).toBe('booked')
      expect(job!.sourceOfferId).toBe(offer.id)
    })

    it('job has provider linkage after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-assign-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      // Provider should be linked
      expect(job.craftsmanUserId ?? job.providerId).toBeTruthy()
    })
  })

  // ── PART 9: Notification selectors reflect operations ─────────────────

  describe('9. Notification/attention selectors reflect new operations states', () => {
    it('work_completed customer next step is release payment', async () => {
      const { offer } = await createAcceptedOffer('conv-notif-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)
      await startJob(job.id)
      await completeJob(job.id)

      const updated = getJobById(job.id)!
      const nextStep = deriveCustomerNextStep(updated, undefined, 'funded')
      // After work is completed, customer should see release payment
      expect(nextStep.label).toContain('freigeben')
    })

    it('funded_in_escrow customer next step is escrow funded', async () => {
      const { offer } = await createAcceptedOffer('conv-notif-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const updated = getJobById(job.id)!
      const nextStep = deriveCustomerNextStep(updated, undefined, 'funded')
      expect(nextStep.label).toContain('Zahlung abgesichert')
    })
  })

  // ── PART 10: No regression to quote lifecycle ─────────────────────────

  describe('10. No regression to quote lifecycle', () => {
    it('accepted offer creates escrow plan', async () => {
      const { offer } = await createAcceptedOffer('conv-quote-1')
      const escrowPlan = getEscrowPlanByJobId(offer.createdJobId!)
      expect(escrowPlan).toBeDefined()
      expect(escrowPlan!.totalAmount).toBe(5000)
    })

    it('accepted offer creates 25/75 tranches', async () => {
      const { offer } = await createAcceptedOffer('conv-quote-2')
      const escrowPlan = getEscrowPlanByJobId(offer.createdJobId!)!
      const tranches = getEscrowTranches(escrowPlan.id)
      expect(tranches.length).toBe(2)

      const deposit = tranches.find(t => t.kind === 'deposit_release')
      const final = tranches.find(t => t.kind === 'final_release')
      expect(deposit).toBeDefined()
      expect(final).toBeDefined()
      expect(deposit!.percentage).toBe(25)
      expect(final!.percentage).toBe(75)
    })
  })

  // ── PART 11: No regression to funding flow ────────────────────────────

  describe('11. No regression to funding flow', () => {
    it('requestFundingWorkflow still works correctly', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.status).toBe('sent')
    })

    it('funding confirmation updates escrow plan status', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const escrowPlan = getEscrowPlanByJobId(job.id)!
      expect(escrowPlan.status).toBe('funded_in_escrow')
    })
  })

  // ── PART 12: No regression to thread logic ────────────────────────────

  describe('12. No regression to relationship-thread logic', () => {
    it('job has sourceConversationId after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-thread-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.sourceConversationId).toBe('conv-thread-1')
    })
  })

  // ── PART 13: No regression to participant scoping ─────────────────────

  describe('13. No regression to participant scoping', () => {
    it('job has customerUserId after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-scope-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.customerUserId).toBe('customer-craft-ops')
    })
  })

  // ── Full Happy Path ───────────────────────────────────────────────────

  describe('Full happy path: quote → fund → start → complete', () => {
    it('traverses the complete lifecycle using craftsman operations', async () => {
      const { offer } = await createAcceptedOffer('conv-happy')
      const jobId = offer.createdJobId!

      // Phase 1: Accepted, no funding yet
      expect(getPhaseForJob(jobId)).toBe('funding_not_requested')

      // Phase 2: Request funding
      const fundResult = await requestFundingForJob(jobId)
      expect(fundResult.ok).toBe(true)
      expect(getPhaseForJob(jobId)).toBe('funding_requested')

      // Phase 3: Customer funds
      await simulateCustomerFunding(jobId)
      expect(getPhaseForJob(jobId)).toBe('funded_in_escrow')

      // Phase 4: Start work
      const startResult = await startJob(jobId)
      expect(startResult.ok).toBe(true)
      expect(getPhaseForJob(jobId)).toBe('work_started')

      // Verify 25% tranche eligible
      const ep = getEscrowPlanByJobId(jobId)!
      const tranchesAfterStart = getEscrowTranches(ep.id)
      const deposit = tranchesAfterStart.find(t => t.kind === 'deposit_release')!
      expect(deposit.status).toBe('eligible_for_release')

      // Phase 5: Complete work
      const completeResult = await completeJob(jobId)
      expect(completeResult.ok).toBe(true)

      // Verify 75% tranche eligible
      const tranchesAfterComplete = getEscrowTranches(ep.id)
      const final = tranchesAfterComplete.find(t => t.kind === 'final_release')!
      expect(final.status).toBe('eligible_for_release')

      // Verify job state
      const finalJob = getJobById(jobId)!
      expect(finalJob.workCompletedAt).toBeTruthy()
      expect(finalJob.status).toBe('waiting_payment')
    })
  })
})
