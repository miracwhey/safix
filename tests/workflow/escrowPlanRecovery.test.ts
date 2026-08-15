/**
 * Escrow Plan Recovery + Funding Request Wiring Tests
 *
 * Validates the fixes for the accepted quote → escrow plan → funding request chain:
 *
 * 1. Accepted quote creates escrow plan successfully
 * 2. requestFundingForJob recovers escrow plan for valid accepted jobs
 * 3. Existing escrow plan is reused without duplication
 * 4. Existing funding request is reused without duplication
 * 5. Provider action produces a real customer-usable funding path/artifact
 * 6. Stale draft/proposal messaging not shown for accepted operable jobs
 * 7. No regression to funding flow
 * 8. No regression to quote lifecycle
 * 9. No regression to relationship-thread logic
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
// ── Workflow imports ──────────────────────────────────────────────────────

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingWorkflow,
  requestFundingForJob,
} from '../../src/lib/workflow'

// ── Domain imports ────────────────────────────────────────────────────────

import { getJobById } from '../../src/lib/jobs'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
  getEscrowTranches,
} from '../../src/lib/payments/escrow'
import {
  getEscrowPlanRepository,
} from '../../src/lib/payments/escrow/escrowRegistry'
import {
  getFundingRequestByJobId,
  getAllFundingRequests,
} from '../../src/lib/payments/fundingRequest'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { deriveProposalState } from '../../src/lib/jobs/proposalReadinessSelectors'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-recovery',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-recovery',
    projectTitle: 'Recovery Test',
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
  return { offer: accepted!, conversation: conv }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Escrow Plan Recovery + Funding Request Wiring', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Acceptance creates escrow plan ─────────────────────────────────

  describe('1. accepted quote creates escrow plan successfully', () => {
    it('escrow plan exists after offer acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-create-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const plan = getEscrowPlanByJobId(job.id)
      expect(plan).toBeDefined()
      expect(plan!.sourceOfferId).toBe(offer.id)
      expect(plan!.jobId).toBe(job.id)
      expect(plan!.totalAmount).toBe(5000)
      expect(plan!.status).toBe('awaiting_customer_funding')
    })

    it('escrow plan has 25/75 tranches', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-create-2')
      const plan = getEscrowPlanByJobId(offer.createdJobId!)!
      const tranches = getEscrowTranches(plan.id)
      expect(tranches).toHaveLength(2)
      const deposit = tranches.find(t => t.kind === 'deposit_release')
      const final = tranches.find(t => t.kind === 'final_release')
      expect(deposit!.percentage).toBe(25)
      expect(final!.percentage).toBe(75)
    })
  })

  // ── 2. Recovery when escrow plan is missing ───────────────────────────

  describe('2. requestFundingForJob recovers escrow plan for valid accepted jobs', () => {
    it('recovers escrow plan when plan was deleted but job has valid offer data', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-recover-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Verify plan exists after acceptance
      const planBefore = getEscrowPlanByJobId(job.id)
      expect(planBefore).toBeDefined()

      // Simulate the plan being lost (e.g. page reload with InMemory repo reset)
      const repo = getEscrowPlanRepository()
      const allPlans = repo.getAllPlans()
      for (const p of allPlans) {
        repo.updatePlan(p.id, () => ({ ...p, jobId: 'deleted-sentinel' } as typeof p))
      }

      // Plan is no longer findable by jobId
      expect(getEscrowPlanByJobId(job.id)).toBeUndefined()

      // requestFundingForJob should recover the plan via sourceOfferId fallback
      // or re-create it
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)

      // Escrow plan should now exist again
      const planAfter = getEscrowPlanByJobId(job.id)
        ?? getEscrowPlanByOfferId(job.sourceOfferId!)
      expect(planAfter).toBeDefined()
    })

    it('recovers sourceOfferId from canonical accepted offer when missing', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-recover-2')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Clear the escrow plan
      const repo = getEscrowPlanRepository()
      const allPlans = repo.getAllPlans()
      for (const p of allPlans) {
        repo.updatePlan(p.id, () => ({ ...p, jobId: 'x', sourceOfferId: 'x' } as typeof p))
      }

      // Remove sourceOfferId from job to simulate missing linkage
      const { setJobRepository } = await import('../../src/lib/jobs/repository/registry')
      const { InMemoryJobRepository } = await import('../../src/lib/jobs/repository/InMemoryJobRepository')
      const jobRepo = new InMemoryJobRepository([{
        ...job,
        sourceOfferId: undefined,
      }])
      setJobRepository(jobRepo)

      // Recovery should succeed via canonical accepted offer reverse lookup
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(5000)
      }

      // sourceOfferId should now be persisted on the job
      const updatedJob = getJobById(job.id)
      expect(updatedJob?.sourceOfferId).toBe(offer.id)
    })

    it('fails with SOURCE_OFFER_MISSING when no canonical offer exists', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-recover-2b')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Clear escrow plans
      const repo = getEscrowPlanRepository()
      const allPlans = repo.getAllPlans()
      for (const p of allPlans) {
        repo.updatePlan(p.id, () => ({ ...p, jobId: 'x', sourceOfferId: 'x' } as typeof p))
      }

      // Remove sourceOfferId from job AND remove the offer's createdJobId link
      const { setJobRepository } = await import('../../src/lib/jobs/repository/registry')
      const { InMemoryJobRepository } = await import('../../src/lib/jobs/repository/InMemoryJobRepository')
      setJobRepository(new InMemoryJobRepository([{
        ...job,
        sourceOfferId: undefined,
      }]))

      // Also clear the offer's createdJobId so canonical reverse lookup fails
      const { setOfferRepository } = await import('../../src/lib/offers/repository/registry')
      const { InMemoryOfferRepository } = await import('../../src/lib/offers/repository/InMemoryOfferRepository')
      setOfferRepository(new InMemoryOfferRepository([{
        ...offer,
        createdJobId: undefined,
      }]))

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('SOURCE_OFFER_MISSING')
      }
    })

    it('fails with precise error when customer userId is missing', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-recover-3')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Clear escrow plan
      const repo = getEscrowPlanRepository()
      const allPlans = repo.getAllPlans()
      for (const p of allPlans) {
        repo.updatePlan(p.id, () => ({ ...p, jobId: 'x', sourceOfferId: 'x' } as typeof p))
      }

      // Remove customerUserId
      const { setJobRepository } = await import('../../src/lib/jobs/repository/registry')
      const { InMemoryJobRepository } = await import('../../src/lib/jobs/repository/InMemoryJobRepository')
      setJobRepository(new InMemoryJobRepository([{
        ...job,
        customerUserId: undefined,
      }]))

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('ESCROW_RECOVERY_FAILED')
      }
    })
  })

  // ── 3. Existing plan reused without duplication ────────────────────────

  describe('3. existing escrow plan is reused without duplication', () => {
    it('does not create duplicate plan on retry', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-reuse-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const r1 = await requestFundingForJob(job.id)
      const r2 = await requestFundingForJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      // Only one escrow plan should exist for this job
      const allPlans = getEscrowPlanRepository().getAllPlans()
      const forJob = allPlans.filter(p => p.jobId === job.id)
      expect(forJob).toHaveLength(1)
    })
  })

  // ── 4. Existing funding request reused without duplication ─────────────

  describe('4. existing funding request is reused without duplication', () => {
    it('does not create duplicate funding request on retry', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-fr-reuse-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingForJob(job.id)
      await requestFundingForJob(job.id)
      await requestFundingForJob(job.id)

      const all = getAllFundingRequests()
      const forJob = all.filter(fr => fr.jobId === job.id)
      expect(forJob).toHaveLength(1)
    })
  })

  // ── 5. Provider action produces customer-usable funding path ──────────

  describe('5. provider action produces real customer-usable funding path/artifact', () => {
    it('funding request is created with correct linkage', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-path-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)

      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.sourceOfferId).toBe(offer.id)
      expect(fr!.jobId).toBe(job.id)
      expect(fr!.escrowPlanId).toBeTruthy()
      expect(fr!.status).toBe('sent')
      expect(fr!.amount).toBe(5000)
    })

    it('thread funding artifact is created', async () => {
      const { offer, conversation } = await createAcceptedOffer('conv-rec-path-2')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingForJob(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const artifact = artifactRepo.getByConversationAndType(
        conversation.id,
        'funding_step'
      )
      expect(artifact).toBeDefined()
    })
  })

  // ── 6. Stale draft messaging not shown for accepted jobs ──────────────

  describe('6. stale draft/proposal messaging not shown for accepted operable jobs', () => {
    it('deriveProposalState returns accepted for accepted job', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-stale-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const state = deriveProposalState(job)
      expect(state.state).toBe('accepted')
      expect(state.tone).toBe('green')
    })

    it('accepted job has booked status (not new)', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-stale-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      // Accepted jobs are booked, not new — so draft-only UI is hidden
      expect(job.status).toBe('booked')
      expect(job.status).not.toBe('new')
    })
  })

  // ── 7. requestFundingWorkflow also recovers ───────────────────────────

  describe('7. requestFundingWorkflow recovers escrow plan', () => {
    it('recovers plan and creates funding request', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-wf-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Corrupt the plan linkage
      const repo = getEscrowPlanRepository()
      const plan = getEscrowPlanByJobId(job.id)!
      repo.updatePlan(plan.id, (p) => ({ ...p, jobId: 'corrupted-job-id' }))
      expect(getEscrowPlanByJobId(job.id)).toBeUndefined()

      // requestFundingWorkflow should still recover via sourceOfferId
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeTruthy()
      expect(result!.amount).toBe(5000)
    })
  })

  // ── 8. No regression to quote lifecycle ────────────────────────────────

  describe('8. no regression to quote lifecycle', () => {
    it('idempotent re-acceptance returns same offer', async () => {
      const conv = makeConversation('conv-rec-noreg-1')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '3.000 €',
        description: 'Test',
      })

      const a1 = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      const a2 = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(a1!.id).toBe(a2!.id)
      expect(a1!.createdJobId).toBe(a2!.createdJobId)
    })
  })

  // ── 9. No regression: full funding flow ────────────────────────────────

  describe('9. full funding flow works end to end', () => {
    it('accepted → fund → funding request sent', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-e2e-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.status).toBe('sent')
        expect(result.data.amount).toBe(5000)
      }

      // Verify chain integrity
      const plan = getEscrowPlanByJobId(job.id)
      const fr = getFundingRequestByJobId(job.id)
      expect(plan).toBeDefined()
      expect(fr).toBeDefined()
      expect(fr!.escrowPlanId).toBe(plan!.id)
      expect(fr!.sourceOfferId).toBe(offer.id)
    })
  })

  // ── 10. Idempotency across reloads ─────────────────────────────────────

  describe('10. idempotency across multiple calls', () => {
    it('three successive requestFundingForJob calls produce exactly one plan and one request', async () => {
      const { offer } = await createAcceptedOffer('conv-rec-idem-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const r1 = await requestFundingForJob(job.id)
      const r2 = await requestFundingForJob(job.id)
      const r3 = await requestFundingForJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      expect(r3.ok).toBe(true)

      const plans = getEscrowPlanRepository().getAllPlans().filter(p => p.jobId === job.id)
      const requests = getAllFundingRequests().filter(fr => fr.jobId === job.id)
      expect(plans).toHaveLength(1)
      expect(requests).toHaveLength(1)
    })
  })
})
