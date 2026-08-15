/**
 * Source Offer Backfill + Accepted Job Linkage Repair Tests
 *
 * Validates:
 * 1. Accepted legacy job missing source_offer_id is safely backfilled/recovered
 * 2. Canonical mapping via offer.createdJobId works
 * 3. Ambiguous mapping (multiple offers) is rejected clearly
 * 4. Recovered jobs can continue to escrow plan recovery
 * 5. Recovered jobs can create/reuse funding request idempotently
 * 6. No duplicate plan/request/artifact creation on retries
 * 7. No regression to funding flow
 * 8. No regression to quote lifecycle
 * 9. No regression to relationship-thread logic
 * 10. acceptOfferWorkflow sets sourceOfferId on pre-existing jobs
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

import { getJobById, addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
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
import { getAcceptedOfferByJobId, getOfferById, addOffer } from '../../src/lib/offers'
import type { Offer } from '../../src/lib/offers'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-backfill',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-backfill',
    projectTitle: 'Backfill Test',
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

/**
 * Creates a pre-existing job (simulating inquiry conversion) and then
 * an offer that links to it — but the job's sourceOfferId is NOT set.
 * This simulates the legacy data gap.
 */
async function createLegacyJobWithMissingSourceOffer(conversationId: string) {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  // Create a job first (as if from inquiry conversion)
  const jobId = `legacy-job-${conversationId}`
  const job: Job = {
    id: jobId,
    projectId: `project-${conversationId}`,
    title: 'Legacy Auftrag',
    customer: conv.customerName,
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '5.000 €',
    description: 'Legacy job',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    sourceConversationId: conversationId,
    proposalSentAt: Date.now() - 10000,
    proposalAcceptedAt: Date.now() - 5000,
    // sourceOfferId intentionally missing — simulates legacy data gap
  }
  await addJob(job)

  // Create an accepted offer that links to this job via createdJobId
  const now = Date.now()
  const offer: Offer = {
    id: `offer-${conversationId}`,
    conversationId,
    customerUserId: conv.customerUserId,
    craftsmanUserId: conv.craftsmanUserId,
    price: '5.000 €',
    description: 'Badezimmer-Renovierung',
    status: 'accepted',
    createdAt: now - 10000,
    updatedAt: now - 5000,
    sentAt: now - 10000,
    acceptedAt: now - 5000,
    lockedAt: now - 5000,
    createdJobId: jobId,
  }
  await addOffer(offer)

  installSessionForJobOwner({ craftsmanUserId: conv.craftsmanUserId })
  return { job: getJobById(jobId)!, offer: getOfferById(offer.id)!, conversation: conv }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Source Offer Backfill + Accepted Job Linkage Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Legacy job missing sourceOfferId is recovered ─────────────────

  describe('1. accepted legacy job missing source_offer_id is safely backfilled', () => {
    it('recovers sourceOfferId from canonical accepted offer', async () => {
      const { job, offer } = await createLegacyJobWithMissingSourceOffer('conv-bf-1')
      expect(job.sourceOfferId).toBeUndefined()

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(5000)
        expect(result.data.fundingRequestId).toBeTruthy()
      }

      // sourceOfferId should now be persisted on the job
      const updatedJob = getJobById(job.id)!
      expect(updatedJob.sourceOfferId).toBe(offer.id)
    })

    it('requestFundingWorkflow also recovers sourceOfferId', async () => {
      const { job, offer } = await createLegacyJobWithMissingSourceOffer('conv-bf-1b')
      expect(job.sourceOfferId).toBeUndefined()

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)

      const updatedJob = getJobById(job.id)!
      expect(updatedJob.sourceOfferId).toBe(offer.id)
    })
  })

  // ── 2. Canonical mapping via createdJobId works ──────────────────────

  describe('2. canonical mapping via offer.createdJobId works', () => {
    it('getAcceptedOfferByJobId finds unique accepted offer', async () => {
      const { job, offer } = await createLegacyJobWithMissingSourceOffer('conv-bf-2')
      const found = getAcceptedOfferByJobId(job.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(offer.id)
      expect(found!.status).toBe('accepted')
      expect(found!.createdJobId).toBe(job.id)
    })

    it('returns undefined when no offer links to job', async () => {
      const conv = makeConversation('conv-bf-2b')
      addConversation(conv)
      const jobId = 'orphan-job-id'
      await addJob({
        id: jobId,
        projectId: 'p-orphan',
        title: 'Orphan',
        customer: 'Test',
        location: 'Berlin',
        dateLabel: '',
        status: 'booked',
        amount: '1.000 €',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: '',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        sourceConversationId: conv.id,
        proposalAcceptedAt: Date.now(),
      })
      expect(getAcceptedOfferByJobId(jobId)).toBeUndefined()
    })
  })

  // ── 3. Ambiguous mapping is rejected clearly ─────────────────────────

  describe('3. ambiguous mapping is rejected clearly', () => {
    it('returns undefined when multiple accepted offers point to same job', async () => {
      const { job } = await createLegacyJobWithMissingSourceOffer('conv-bf-3')

      // Add a second accepted offer pointing to the same job (ambiguous)
      const now = Date.now()
      await addOffer({
        id: 'offer-duplicate-bf-3',
        conversationId: 'conv-bf-3-dup',
        customerUserId: 'customer-backfill',
        craftsmanUserId: 'craftsman-backfill',
        price: '6.000 €',
        description: 'Duplicate offer',
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
        sentAt: now,
        acceptedAt: now,
        lockedAt: now,
        createdJobId: job.id,
      })

      // Canonical lookup should return undefined (ambiguous)
      expect(getAcceptedOfferByJobId(job.id)).toBeUndefined()

      // Recovery should fail with SOURCE_OFFER_MISSING (not auto-recover ambiguous)
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('SOURCE_OFFER_MISSING')
      }
    })
  })

  // ── 4. Recovered jobs continue to escrow plan recovery ───────────────

  describe('4. recovered jobs continue to escrow plan recovery', () => {
    it('creates escrow plan after sourceOfferId recovery', async () => {
      const { job, offer } = await createLegacyJobWithMissingSourceOffer('conv-bf-4')

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)

      const plan = getEscrowPlanByJobId(job.id) ?? getEscrowPlanByOfferId(offer.id)
      expect(plan).toBeDefined()
      expect(plan!.sourceOfferId).toBe(offer.id)
      expect(plan!.jobId).toBe(job.id)
      expect(plan!.totalAmount).toBe(5000)
    })
  })

  // ── 5. Recovered jobs create/reuse funding request idempotently ──────

  describe('5. recovered jobs create/reuse funding request idempotently', () => {
    it('creates funding request after recovery', async () => {
      const { job, offer } = await createLegacyJobWithMissingSourceOffer('conv-bf-5')

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.fundingRequestId).toBeTruthy()
        expect(result.data.status).toBe('sent')
        expect(result.data.amount).toBe(5000)
      }

      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.sourceOfferId).toBe(offer.id)
    })

    it('repeated calls return same funding request', async () => {
      const { job } = await createLegacyJobWithMissingSourceOffer('conv-bf-5b')

      const r1 = await requestFundingForJob(job.id)
      const r2 = await requestFundingForJob(job.id)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r1.data.fundingRequestId).toBe(r2.data.fundingRequestId)
      }
    })
  })

  // ── 6. No duplicate plan/request/artifact creation on retries ────────

  describe('6. no duplicate plan/request/artifact creation on retries', () => {
    it('three retries produce exactly one plan and one request', async () => {
      const { job } = await createLegacyJobWithMissingSourceOffer('conv-bf-6')

      await requestFundingForJob(job.id)
      await requestFundingForJob(job.id)
      await requestFundingForJob(job.id)

      const plans = getEscrowPlanRepository().getAllPlans().filter(p => p.jobId === job.id)
      const requests = getAllFundingRequests().filter(fr => fr.jobId === job.id)
      expect(plans).toHaveLength(1)
      expect(requests).toHaveLength(1)
    })

    it('thread artifact is created only once', async () => {
      const { job, conversation } = await createLegacyJobWithMissingSourceOffer('conv-bf-6b')

      await requestFundingForJob(job.id)
      await requestFundingForJob(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const artifacts = artifactRepo.getByConversationId(conversation.id)
        .filter(a => a.artifactType === 'funding_step')
      expect(artifacts).toHaveLength(1)
    })
  })

  // ── 7. No regression to funding flow ──────────────────────────────────

  describe('7. no regression to funding flow', () => {
    it('normal accepted job with sourceOfferId still works', async () => {
      const { offer } = await createAcceptedOffer('conv-bf-7')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.sourceOfferId).toBe(offer.id)

      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(5000)
      }
    })

    it('full chain integrity after normal acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-bf-7b')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      await requestFundingForJob(job.id)

      const plan = getEscrowPlanByJobId(job.id)!
      const fr = getFundingRequestByJobId(job.id)!
      expect(plan.sourceOfferId).toBe(offer.id)
      expect(fr.sourceOfferId).toBe(offer.id)
      expect(fr.escrowPlanId).toBe(plan.id)
    })
  })

  // ── 8. No regression to quote lifecycle ───────────────────────────────

  describe('8. no regression to quote lifecycle', () => {
    it('idempotent re-acceptance still returns same offer', async () => {
      const conv = makeConversation('conv-bf-8')
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

  // ── 9. No regression to relationship-thread logic ─────────────────────

  describe('9. no regression to relationship-thread logic', () => {
    it('recovered funding request includes conversation linkage', async () => {
      const { job, conversation } = await createLegacyJobWithMissingSourceOffer('conv-bf-9')

      await requestFundingForJob(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      expect(fr.conversationId).toBe(conversation.id)
    })
  })

  // ── 10. acceptOfferWorkflow sets sourceOfferId on pre-existing jobs ────

  describe('10. acceptOfferWorkflow sets sourceOfferId on pre-existing jobs', () => {
    it('pre-existing job gets sourceOfferId after offer acceptance', async () => {
      const conv = makeConversation('conv-bf-10')
      addConversation(conv)

      // Create a job first (simulating inquiry conversion)
      const jobId = 'pre-existing-job-10'
      await addJob({
        id: jobId,
        projectId: `project-${conv.id}`,
        title: 'Pre-existing Auftrag',
        customer: conv.customerName,
        location: 'Berlin',
        dateLabel: '',
        status: 'new',
        amount: '',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: '',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        sourceConversationId: conv.id,
        // No sourceOfferId
      })

      // Create and accept an offer
      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '4.000 €',
        description: 'Test',
      })

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted!.createdJobId).toBe(jobId)

      // The job should now have sourceOfferId set
      const updatedJob = getJobById(jobId)!
      expect(updatedJob.sourceOfferId).toBe(offer.id)
    })
  })
})
