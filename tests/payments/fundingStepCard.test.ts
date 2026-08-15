/**
 * Funding Step Card + Customer Funding Flow Integration Tests
 *
 * Verifies the complete funding bridge:
 * 1. Provider sends funding step card → thread artifact + funding request
 * 2. Customer enters funding flow from persisted data
 * 3. Stripe funding initiation is tracked
 * 4. Server-side funding confirmation updates all surfaces
 * 5. Cross-surface state consistency
 * 6. Idempotency and retry safety
 * 7. Failure/cancel/expired handling
 * 8. No regression to existing flows
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the provider profile service to avoid real HTTP calls to the
// placeholder Supabase URL during tests.  acceptOfferWorkflow →
// resolveProviderId → getProviderProfile makes a network request that
// can be slow/timeout on CI runners with restricted DNS.
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  getFundingRequestById,
  getFundingRequestByJobId,
  markFundingStarted,
  markFundingInitiated,
  markFundingCompleted,
  markFundingFailed,
  markFundingCancelled,
  getAllFundingRequests,
  getFundingRequestStatusLabel,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
  getEscrowTranches,
  initiateFunding,
  failFunding,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  confirmFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-fsc-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-fsc',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-fsc',
    projectTitle: 'Funding Step Card Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

async function setupAcceptedQuote(convId: string) {
  const conv = makeConversation(convId)
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: 'customer-fsc',
    craftsmanUserId: 'craftsman-fsc',
    price: '5.000 €',
  })

  await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const acceptedOffer = getOfferById(offer.id)!
  const job = getJobById(acceptedOffer.createdJobId!)!
  const escrowPlan = getEscrowPlanByOfferId(offer.id)!

  // Default session = job owner. Tests that exercise customer-side workflows
  // (customerFundingEntry / confirmFunding / customerRelease) call
  // installSessionForJobCustomer(job) immediately before the workflow.
  installSessionForJobOwner(job)

  return { conv, offer: acceptedOffer, job, escrowPlan }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Step Card Integration', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('FIX 1 — Provider sends funding step card', () => {
    it('creates a funding request tied to the accepted quote', async () => {
      const { job, escrowPlan, offer } = await setupAcceptedQuote('conv-fsc-fix1a')

      const result = await requestFundingWorkflow(job.id)

      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')

      // Verify funding request is persisted
      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.sourceOfferId).toBe(offer.id)
      expect(fr!.jobId).toBe(job.id)
      expect(fr!.escrowPlanId).toBe(escrowPlan.id)
      expect(fr!.type).toBe('full_escrow')
      expect(fr!.amount).toBe(5000)
    })

    it('creates a funding step thread artifact', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-fix1b')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const artifacts = artifactRepo.getByConversationId(conv.id)
      const fundingArtifact = artifacts.find(a => a.artifactType === 'funding_step')

      expect(fundingArtifact).toBeDefined()
      expect(fundingArtifact!.fundingRequestId).toBeDefined()
      expect(fundingArtifact!.escrowPlanId).toBeDefined()
      expect(fundingArtifact!.jobId).toBe(job.id)
      expect(fundingArtifact!.phase).toBe('sent')
      expect(fundingArtifact!.snapshotPrice).toContain('5')
    })

    it('is idempotent: repeated calls do not create duplicates', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-fix1c')

      const first = await requestFundingWorkflow(job.id)
      const second = await requestFundingWorkflow(job.id)
      const third = await requestFundingWorkflow(job.id)

      expect(first!.fundingRequestId).toBe(second!.fundingRequestId)
      expect(second!.fundingRequestId).toBe(third!.fundingRequestId)
      expect(getAllFundingRequests()).toHaveLength(1)

      // Thread artifact is also idempotent
      const artifactRepo = getThreadArtifactRepository()
      const artifacts = artifactRepo.getByConversationId(conv.id)
      const fundingArtifacts = artifacts.filter(a => a.artifactType === 'funding_step')
      expect(fundingArtifacts).toHaveLength(1)
    })

    it('rejects funding request when no accepted quote exists', async () => {
      const result = await requestFundingWorkflow('nonexistent-job')
      expect(result).toBeUndefined()
    })
  })

  describe('FIX 2 — Customer funding flow from real data', () => {
    it('customer enters funding through the persisted funding request', async () => {
      const { job, escrowPlan, offer } = await setupAcceptedQuote('conv-fsc-fix2a')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeDefined()
      expect(result!.escrowPlanId).toBe(escrowPlan.id)
      expect(result!.sourceOfferId).toBe(offer.id)
      expect(result!.amount).toBe(5000)
      expect(result!.jobId).toBe(job.id)
      expect(result!.currency).toBe('EUR')
      expect(result!.status).toBe('funding_started')
    })

    it('rejects funding entry when no funding request exists', async () => {
      const result = await customerFundingEntryWorkflow('nonexistent-job')
      expect(result).toBeUndefined()
    })

    it('returns correct data for Stripe initiation', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix2c')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      expect(result!.customerUserId).toBe('customer-fsc')
      expect(result!.amount).toBe(5000)
      expect(result!.currency).toBe('EUR')
    })
  })

  describe('FIX 3 — Stripe funding foundation', () => {
    it('funding initiation stores external reference on escrow plan', async () => {
      const { job, escrowPlan } = await setupAcceptedQuote('conv-fsc-fix3a')

      await requestFundingWorkflow(job.id)

      // Simulate Stripe funding initiation
      await initiateFunding(escrowPlan.id, {
        externalFundingRef: 'pi_test_12345',
        fundingIdempotencyKey: 'idem_test_12345',
      })

      const updatedPlan = getEscrowPlanByJobId(job.id)
      expect(updatedPlan!.status).toBe('funding_initiated')
      expect(updatedPlan!.externalFundingRef).toBe('pi_test_12345')
      expect(updatedPlan!.fundingIdempotencyKey).toBe('idem_test_12345')
    })

    it('funding initiation stores external reference on funding request', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix3b')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      await markFundingInitiated(fr.id, {
        externalFundingRef: 'pi_test_67890',
        fundingIdempotencyKey: 'idem_test_67890',
      })

      const updatedFr = getFundingRequestById(fr.id)
      expect(updatedFr!.status).toBe('funding_initiated')
      expect(updatedFr!.externalFundingRef).toBe('pi_test_67890')
      expect(updatedFr!.fundingIdempotencyKey).toBe('idem_test_67890')
    })
  })

  describe('FIX 4 — Server-side funding truth', () => {
    it('confirmFundingWorkflow sets funded_in_escrow status', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix4a')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Simulate server-side confirmation
      installSessionForJobCustomer(job)
      const result = await confirmFundingWorkflow(job.id, {
        externalFundingRef: 'pi_confirmed_12345',
      })

      expect(result).toBeDefined()
      expect(result!.status).toBe('funded_in_escrow')

      // Verify escrow plan is funded
      const updatedPlan = getEscrowPlanByJobId(job.id)
      expect(updatedPlan!.status).toBe('funded_in_escrow')
      expect(updatedPlan!.externalFundingRef).toBe('pi_confirmed_12345')

      // Verify funding request is marked as funded
      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funded')
      expect(fr!.fundedAt).toBeDefined()
    })

    it('confirmFundingWorkflow transitions all tranches to funded', async () => {
      const { job, escrowPlan } = await setupAcceptedQuote('conv-fsc-fix4b')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const tranches = getEscrowTranches(escrowPlan.id)
      expect(tranches).toHaveLength(2)
      expect(tranches.every(t => t.status === 'funded')).toBe(true)
    })

    it('confirmFundingWorkflow is idempotent', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix4c')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      installSessionForJobCustomer(job)
      const first = await confirmFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const second = await confirmFundingWorkflow(job.id)

      expect(first!.status).toBe('funded_in_escrow')
      expect(second!.status).toBe('funded_in_escrow')
    })
  })

  describe('FIX 5 — Persistent funding state', () => {
    it('funding status survives simulated reload', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix5a')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      // Simulate reload: re-query
      const reloaded = getFundingRequestByJobId(job.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.id).toBe(fr.id)
      expect(reloaded!.status).toBe('sent')
    })

    it('funded status persists after confirmation', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix5b')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // Simulate reload
      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funded')

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.status).toBe('funded_in_escrow')
    })
  })

  describe('FIX 6 — Full-upfront escrow semantics', () => {
    it('funding amount equals the full accepted quote amount', async () => {
      const { job, escrowPlan } = await setupAcceptedQuote('conv-fsc-fix6a')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      expect(result!.amount).toBe(escrowPlan.totalAmount)
      expect(result!.amount).toBe(5000)
    })

    it('funding request type is full_escrow', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix6b')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.type).toBe('full_escrow')
    })

    it('escrow plan uses full_upfront_escrow funding mode', async () => {
      const { escrowPlan } = await setupAcceptedQuote('conv-fsc-fix6c')
      expect(escrowPlan.fundingMode).toBe('full_upfront_escrow')
    })

    it('25/75 are release tranches, not customer payment splits', async () => {
      const { escrowPlan } = await setupAcceptedQuote('conv-fsc-fix6d')

      const tranches = getEscrowTranches(escrowPlan.id)
      const deposit = tranches.find(t => t.kind === 'deposit_release')!
      const final = tranches.find(t => t.kind === 'final_release')!

      expect(deposit.percentage).toBe(25)
      expect(final.percentage).toBe(75)
      expect(deposit.amount + final.amount).toBe(5000)

      // Both are release triggers, not payment splits
      expect(deposit.releaseTrigger).toBe('work_started')
      expect(final.releaseTrigger).toBe('work_completed')
    })
  })

  describe('FIX 7 — Cross-surface alignment', () => {
    it('customer job stage shows funding_pending after funding request sent', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix7a')

      await requestFundingWorkflow(job.id)

      const { stage } = deriveCustomerJobStage(
        job.status,
        job.paymentState,
        job.proposalSentAt,
        job.proposalAcceptedAt,
        'sent'
      )
      expect(stage).toBe('funding_pending')
    })

    it('customer job stage shows funded_in_escrow after funding confirmed', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix7b')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const { stage } = deriveCustomerJobStage(
        job.status,
        'deposit_paid',
        job.proposalSentAt,
        job.proposalAcceptedAt,
        'funded'
      )
      expect(stage).toBe('funded_in_escrow')
    })

    it('customer next step shows Fund Escrow when funding is pending', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix7c')

      await requestFundingWorkflow(job.id)

      const nextStep = deriveCustomerNextStep(job, undefined, 'sent')
      expect(nextStep.label).toBe('Zahlung einzahlen')
      expect(nextStep.actionLabel).toBe('Jetzt einzahlen')
    })

    it('customer next step shows Escrow Funded after confirmation', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix7d')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // After confirmation, derive next step with deposit_paid payment state
      const updatedJob = { ...job, paymentState: 'deposit_paid' as const }
      const nextStep = deriveCustomerNextStep(updatedJob, undefined, 'funded')
      expect(nextStep.label).toBe('Zahlung abgesichert')
    })
  })

  describe('FIX 8 — Project/job progression alignment', () => {
    it('progression moves beyond inquiry after accepted quote + funding request', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix8a')

      const beforeFunding = deriveCustomerJobStage(
        job.status,
        job.paymentState,
        job.proposalSentAt,
        job.proposalAcceptedAt
      )
      // Before funding request: should be offer_accepted or beyond
      expect(beforeFunding.stage).not.toBe('inquiry_sent')
    })

    it('progression reflects funding states correctly in order', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix8b')

      // After acceptance
      const s1 = deriveCustomerJobStage(job.status, undefined, job.proposalSentAt, job.proposalAcceptedAt)
      expect(s1.stage).toBe('offer_accepted')

      // After funding request
      const s2 = deriveCustomerJobStage(job.status, undefined, job.proposalSentAt, job.proposalAcceptedAt, 'sent')
      expect(s2.stage).toBe('funding_pending')

      // After funding confirmed
      const s3 = deriveCustomerJobStage(job.status, 'deposit_paid', job.proposalSentAt, job.proposalAcceptedAt, 'funded')
      expect(s3.stage).toBe('funded_in_escrow')
    })
  })

  describe('FIX 10 — Idempotent retry-safe flow', () => {
    it('no duplicate funding requests on retry', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix10a')

      for (let i = 0; i < 5; i++) {
        await requestFundingWorkflow(job.id)
      }

      expect(getAllFundingRequests()).toHaveLength(1)
    })

    it('no duplicate thread artifacts on retry', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-fix10b')

      for (let i = 0; i < 5; i++) {
        await requestFundingWorkflow(job.id)
      }

      const artifactRepo = getThreadArtifactRepository()
      const artifacts = artifactRepo.getByConversationId(conv.id)
      const fundingArtifacts = artifacts.filter(a => a.artifactType === 'funding_step')
      expect(fundingArtifacts).toHaveLength(1)
    })

    it('no duplicate funding initiation on re-entry', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix10c')

      await requestFundingWorkflow(job.id)

      installSessionForJobCustomer(job)
      const first = await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      const second = await customerFundingEntryWorkflow(job.id)

      expect(first!.fundingRequestId).toBe(second!.fundingRequestId)
    })

    it('confirmFundingWorkflow is idempotent on repeated calls', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fix10d')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      for (let i = 0; i < 5; i++) {
        installSessionForJobCustomer(job)
        await confirmFundingWorkflow(job.id)
      }

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.status).toBe('funded_in_escrow')
    })
  })

  describe('Failure / Cancel / Expired state handling', () => {
    it('handles funding_failed state', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-fail1')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      await markFundingStarted(fr.id)
      await markFundingFailed(fr.id, 'Card declined')

      const updated = getFundingRequestById(fr.id)
      expect(updated!.status).toBe('funding_failed')
      expect(updated!.failureReason).toBe('Card declined')
    })

    it('handles funding_cancelled state', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-cancel1')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      await markFundingCancelled(fr.id)

      const updated = getFundingRequestById(fr.id)
      expect(updated!.status).toBe('cancelled')
    })

    it('cannot cancel already funded request', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-cancel2')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      await markFundingStarted(fr.id)
      await markFundingCompleted(fr.id)
      await markFundingCancelled(fr.id) // Should be no-op

      const updated = getFundingRequestById(fr.id)
      expect(updated!.status).toBe('funded')
    })

    it('escrow plan can recover from funding_failed', async () => {
      const { escrowPlan } = await setupAcceptedQuote('conv-fsc-fail2')

      await initiateFunding(escrowPlan.id)
      await failFunding(escrowPlan.id)

      const failed = getEscrowPlanByOfferId(escrowPlan.sourceOfferId)
      expect(failed!.status).toBe('funding_failed')

      // Can retry
      await initiateFunding(escrowPlan.id)
      const retried = getEscrowPlanByOfferId(escrowPlan.sourceOfferId)
      expect(retried!.status).toBe('funding_initiated')
    })

    it('status labels are correct for all funding states', () => {
      expect(getFundingRequestStatusLabel('created')).toBe('Erstellt')
      expect(getFundingRequestStatusLabel('sent')).toBe('Gesendet')
      expect(getFundingRequestStatusLabel('funding_started')).toBe('Einzahlung gestartet')
      expect(getFundingRequestStatusLabel('funding_initiated')).toBe('Einzahlung eingeleitet')
      expect(getFundingRequestStatusLabel('funded')).toBe('Finanziert')
      expect(getFundingRequestStatusLabel('funding_failed')).toBe('Einzahlung fehlgeschlagen')
      expect(getFundingRequestStatusLabel('expired')).toBe('Abgelaufen')
      expect(getFundingRequestStatusLabel('cancelled')).toBe('Storniert')
    })
  })

  describe('No regression to quote lifecycle', () => {
    it('quote accept/decline still works', async () => {
      const conv = makeConversation('conv-fsc-noreg1')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-fsc',
        craftsmanUserId: 'craftsman-fsc',
        price: '3.000 €',
      })

      expect(offer.status).toBe('pending')
      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()
    })
  })

  describe('No regression to escrow plan/tranche model', () => {
    it('escrow plan still creates correctly with 25/75 tranches', async () => {
      const { escrowPlan } = await setupAcceptedQuote('conv-fsc-noreg2')

      expect(escrowPlan.totalAmount).toBe(5000)
      expect(escrowPlan.fundingMode).toBe('full_upfront_escrow')
      expect(escrowPlan.releaseModel).toBe('start_25_completion_75')

      const tranches = getEscrowTranches(escrowPlan.id)
      expect(tranches).toHaveLength(2)
      expect(tranches.find(t => t.kind === 'deposit_release')!.amount).toBe(1250)
      expect(tranches.find(t => t.kind === 'final_release')!.amount).toBe(3750)
    })
  })

  describe('Funding step card artifact in thread', () => {
    it('funding artifact resolves to correct type and phase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-artifact1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('funding_step')
      expect(record!.phase).toBe('sent')
      expect(record!.fundingRequestId).toBeDefined()
      expect(record!.escrowPlanId).toBeDefined()
      expect(record!.jobId).toBe(job.id)
    })

    it('funding artifact has correct snapshot data for card rendering', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-artifact2')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record!.snapshotPrice).toBeDefined()
      expect(record!.snapshotPrice).toContain('5')
      expect(record!.snapshotPhaseLabel).toBe('Zahlung angefordert')
    })

    it('funding artifact carries customer and craftsman user IDs', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-artifact3')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record!.customerUserId).toBe('customer-fsc')
      expect(record!.craftsmanUserId).toBe('craftsman-fsc')
    })

    it('funding artifact provides route context via jobId for CTA navigation', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-fsc-artifact4')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      // CTA navigation uses job.projectId → /projects/{projectId}
      const linkedJob = getJobById(record!.jobId!)
      expect(linkedJob).toBeDefined()
      expect(linkedJob!.projectId).toBeDefined()
    })
  })

  describe('Customer funding entry data completeness', () => {
    it('customerFundingEntryWorkflow returns all data needed for Stripe initiation', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-entry1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      expect(result).toBeDefined()
      // All fields required by /api/initiate-funding
      expect(result!.fundingRequestId).toBeDefined()
      expect(result!.escrowPlanId).toBeDefined()
      expect(result!.jobId).toBe(job.id)
      expect(result!.amount).toBe(5000)
      expect(result!.currency).toBe('EUR')
      expect(result!.customerUserId).toBeDefined()
    })

    it('confirmFundingWorkflow updates escrow plan external reference', async () => {
      const { job } = await setupAcceptedQuote('conv-fsc-entry2')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      installSessionForJobCustomer(job)
      const result = await confirmFundingWorkflow(job.id, {
        externalFundingRef: 'pi_test_confirm_ref',
      })

      expect(result).toBeDefined()
      expect(result!.status).toBe('funded_in_escrow')

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.externalFundingRef).toBe('pi_test_confirm_ref')
    })
  })
})
