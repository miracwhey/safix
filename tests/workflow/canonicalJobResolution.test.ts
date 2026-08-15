/**
 * Canonical Accepted Job Resolution + Duplicate Job Suppression Tests
 *
 * Validates the complete fix for the duplicate-job split-brain problem:
 *
 * 1. Duplicate-job scenario resolves to canonical accepted job
 * 2. Stale duplicate job is suppressed from accepted-order operations
 * 3. Canonical accepted job seeds/reuses escrow plan correctly
 * 4. Canonical accepted job seeds/reuses funding request correctly
 * 5. No duplicate plan/request/artifact creation on retries
 * 6. No regression to normal acceptance flow
 * 7. No regression to funding flow
 * 8. No regression to relationship-thread logic
 * 9. No regression to participant scoping
 * 10. Acceptance flow duplicate prevention
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'

// ── Workflow imports ──────────────────────────────────────────────────────

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingForJob,
} from '../../src/lib/workflow'

// ── Domain imports ────────────────────────────────────────────────────────

import {
  addJob,
  getJobById,
  getJobs,
  getActiveJobs,
  filterSupersededJobs,
  isSupersededByCanonicalJob,
  resolveCanonicalJob,
  findCanonicalOverride,
} from '../../src/lib/jobs'
import {
  getEscrowPlanByJobId,
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
import type { Job } from '../../src/lib/jobs/types'
import { findCanonicalJobForConversation } from '../../src/lib/messages/threadArtifactSelectors'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeConversation(id: string, overrides?: Partial<Conversation>): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-canonical',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-canonical',
    projectTitle: 'Canonical Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
    ...overrides,
  }
}

function makeStaleJob(id: string, conversationId: string, projectId: string): Job {
  return {
    id,
    projectId,
    title: 'Stale inquiry job',
    customer: 'Anna Kundin',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '5.000 \u20ac',
    description: 'Old inquiry-converted job',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-canonical',
    customerUserId: 'customer-canonical',
    sourceConversationId: conversationId,
    // No sourceOfferId \u2014 this is the stale duplicate
    proposalAcceptedAt: Date.now() - 10000,
  }
}

/**
 * Sets up the real-world duplicate job scenario:
 *
 * 1. Customer starts conv1 (old conversation) -> inquiry conversion creates
 *    a stale job linked to conv1
 * 2. Customer starts conv2 (new conversation, same pair) -> craftsman creates
 *    offer in conv2 -> customer accepts -> acceptOfferWorkflow creates a NEW
 *    canonical job linked to conv2 (since the stale job is on conv1,
 *    findJobForConversation won't find it when searching by conv2)
 *
 * Result: two booked jobs for the same customer <-> craftsman pair, only
 * the canonical one has sourceOfferId.
 */
async function setupDuplicateJobScenario(suffix: string) {
  // Old conversation + stale job
  const conv1 = makeConversation(`conv-old-${suffix}`, {
    createdAt: Date.now() - 20000,
  })
  addConversation(conv1)

  const staleJob = makeStaleJob(
    `stale-job-${suffix}`,
    conv1.id,
    conv1.projectId!
  )
  await addJob(staleJob)

  // New conversation (same customer <-> craftsman pair, different conversation ID)
  const conv2 = makeConversation(`conv-new-${suffix}`, {
    createdAt: Date.now(),
    projectId: `project-new-${suffix}`,
  })
  addConversation(conv2)

  // Create and accept offer in the new conversation
  const offer = await createOfferWorkflow({
    conversationId: conv2.id,
    craftsmanUserId: conv2.craftsmanUserId,
    customerUserId: conv2.customerUserId,
    price: '5.000 \u20ac',
    description: 'Badezimmer-Renovierung',
  })
  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const canonicalJob = getJobById(accepted!.createdJobId!)!
  const staleJobAfter = getJobById(staleJob.id)!

  // Verify we actually have two separate jobs
  expect(canonicalJob.id).not.toBe(staleJobAfter.id)
  expect(canonicalJob.sourceOfferId).toBeTruthy()
  expect(staleJobAfter.sourceOfferId).toBeFalsy()

  installSessionForJobOwner(canonicalJob)
  return { conv1, conv2, offer: accepted!, canonicalJob, staleJob: staleJobAfter }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Canonical Accepted Job Resolution + Duplicate Job Suppression', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Duplicate-job scenario resolves to canonical accepted job ─────

  describe('1. duplicate-job scenario resolves to canonical accepted job', () => {
    it('resolveCanonicalJob picks the job with sourceOfferId', () => {
      const stale: Job = makeStaleJob('stale-1', 'conv-1', 'project-1')
      const canonical: Job = {
        ...makeStaleJob('canonical-1', 'conv-1', 'project-1'),
        sourceOfferId: 'offer-1',
      }
      const result = resolveCanonicalJob([stale, canonical])
      expect(result?.id).toBe('canonical-1')
    })

    it('resolveCanonicalJob returns single job when no duplicates', () => {
      const job: Job = makeStaleJob('single-1', 'conv-2', 'project-2')
      const result = resolveCanonicalJob([job])
      expect(result?.id).toBe(job.id)
    })

    it('resolveCanonicalJob returns undefined for empty array', () => {
      expect(resolveCanonicalJob([])).toBeUndefined()
    })
  })

  // ── 2. Stale duplicate job is suppressed from accepted-order operations ─

  describe('2. stale duplicate is suppressed from operational flows', () => {
    it('isSupersededByCanonicalJob returns true for stale duplicate', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('sup-1')
      const allJobs = getJobs()

      // Stale job is superseded (no sourceOfferId, same customer/craftsman pair)
      expect(isSupersededByCanonicalJob(staleJob, allJobs)).toBe(true)

      // Canonical job is NOT superseded (has sourceOfferId)
      expect(isSupersededByCanonicalJob(canonicalJob, allJobs)).toBe(false)
    })

    it('filterSupersededJobs removes stale duplicates from active list', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('sup-2')
      const allJobs = getJobs()

      const filtered = filterSupersededJobs(allJobs)
      const filteredIds = filtered.map((j) => j.id)

      expect(filteredIds).toContain(canonicalJob.id)
      expect(filteredIds).not.toContain(staleJob.id)
    })

    it('getActiveJobs excludes stale duplicates', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('sup-3')
      const active = getActiveJobs()
      const activeIds = active.map((j) => j.id)

      expect(activeIds).toContain(canonicalJob.id)
      expect(activeIds).not.toContain(staleJob.id)
    })
  })

  // ── 3. Canonical accepted job seeds/reuses escrow plan correctly ──────

  describe('3. canonical accepted job seeds escrow plan correctly', () => {
    it('escrow plan is on the canonical job after acceptance', async () => {
      const { canonicalJob, offer } = await setupDuplicateJobScenario('esc-1')

      const plan = getEscrowPlanByJobId(canonicalJob.id)
      expect(plan).toBeDefined()
      expect(plan!.sourceOfferId).toBe(offer.id)
      expect(plan!.jobId).toBe(canonicalJob.id)
    })

    it('stale duplicate has no escrow plan', async () => {
      const { staleJob } = await setupDuplicateJobScenario('esc-2')

      const plan = getEscrowPlanByJobId(staleJob.id)
      expect(plan).toBeUndefined()
    })
  })

  // ── 4. Canonical accepted job seeds/reuses funding request correctly ──

  describe('4. canonical accepted job seeds funding request correctly', () => {
    it('requestFundingForJob on canonical job succeeds', async () => {
      const { canonicalJob } = await setupDuplicateJobScenario('fund-1')

      const result = await requestFundingForJob(canonicalJob.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(5000)
      }
    })

    it('requestFundingForJob on stale duplicate redirects to canonical job', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('fund-2')

      // Calling funding on the stale job should redirect to the canonical one
      const result = await requestFundingForJob(staleJob.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(5000)
      }

      // Funding request should be on the canonical job
      const frCanonical = getFundingRequestByJobId(canonicalJob.id)
      expect(frCanonical).toBeDefined()
    })
  })

  // ── 5. No duplicate plan/request/artifact creation on retries ─────────

  describe('5. no duplicate artifacts on retries', () => {
    it('repeated requestFundingForJob on canonical job creates exactly one plan and request', async () => {
      const { canonicalJob } = await setupDuplicateJobScenario('idem-1')

      await requestFundingForJob(canonicalJob.id)
      await requestFundingForJob(canonicalJob.id)
      await requestFundingForJob(canonicalJob.id)

      const plans = getEscrowPlanRepository().getAllPlans().filter(p => p.jobId === canonicalJob.id)
      const requests = getAllFundingRequests().filter(fr => fr.jobId === canonicalJob.id)
      expect(plans).toHaveLength(1)
      expect(requests).toHaveLength(1)
    })

    it('repeated requestFundingForJob on stale duplicate creates exactly one plan and request on canonical', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('idem-2')

      await requestFundingForJob(staleJob.id)
      await requestFundingForJob(staleJob.id)

      const plans = getEscrowPlanRepository().getAllPlans().filter(p => p.jobId === canonicalJob.id)
      const requests = getAllFundingRequests().filter(fr => fr.jobId === canonicalJob.id)
      expect(plans).toHaveLength(1)
      expect(requests).toHaveLength(1)

      // No funding request on the stale job
      expect(getFundingRequestByJobId(staleJob.id)).toBeUndefined()
    })
  })

  // ── 6. No regression to normal acceptance flow ────────────────────────

  describe('6. no regression to normal acceptance flow', () => {
    it('normal acceptance without pre-existing job works as before', async () => {
      const conv = makeConversation('normal-1')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '3.000 \u20ac',
        description: 'Normal flow',
      })

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted).toBeDefined()
      expect(accepted!.createdJobId).toBeTruthy()

      const job = getJobById(accepted!.createdJobId!)!
      expect(job.sourceOfferId).toBe(offer.id)
      expect(job.status).toBe('booked')

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan).toBeDefined()
      expect(plan!.totalAmount).toBe(3000)
    })

    it('idempotent re-acceptance returns same offer/job', async () => {
      const conv = makeConversation('normal-2')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '4.000 \u20ac',
        description: 'Test',
      })

      const a1 = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      const a2 = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(a1!.id).toBe(a2!.id)
      expect(a1!.createdJobId).toBe(a2!.createdJobId)
    })
  })

  // ── 7. No regression to funding flow ──────────────────────────────────

  describe('7. no regression to funding flow', () => {
    it('normal funding flow still works', async () => {
      const conv = makeConversation('fund-normal-1')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '6.000 \u20ac',
        description: 'Funding test',
      })

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      const job = getJobById(accepted!.createdJobId!)!

      installSessionForJobOwner(job)
      const result = await requestFundingForJob(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.amount).toBe(6000)
        expect(result.data.status).toBe('sent')
      }
    })
  })

  // ── 8. No regression to relationship-thread logic ─────────────────────

  describe('8. no regression to relationship-thread logic', () => {
    it('findCanonicalJobForConversation resolves correctly with single job', async () => {
      const conv = makeConversation('thread-1')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '2.000 \u20ac',
        description: 'Thread test',
      })

      await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      const allJobs = getJobs()

      const result = findCanonicalJobForConversation(conv, allJobs)
      expect(result).toBeDefined()
      expect(result!.canonical).toBe(true)
      expect(result!.job.sourceOfferId).toBeTruthy()
    })

    it('findCanonicalJobForConversation prefers canonical accepted job over stale duplicate', async () => {
      const { conv2, canonicalJob, staleJob } = await setupDuplicateJobScenario('thread-2')
      const allJobs = getJobs()

      // When resolving from the new conversation (where the offer lives),
      // the canonical job should win
      const result = findCanonicalJobForConversation(conv2, allJobs)
      expect(result).toBeDefined()
      expect(result!.job.id).toBe(canonicalJob.id)
      expect(result!.job.id).not.toBe(staleJob.id)
    })
  })

  // ── 9. findCanonicalOverride redirect ─────────────────────────────────

  describe('9. findCanonicalOverride redirects stale jobs', () => {
    it('returns canonical job for stale duplicate', async () => {
      const { staleJob, canonicalJob } = await setupDuplicateJobScenario('override-1')
      const allJobs = getJobs()

      const override = findCanonicalOverride(staleJob.id, allJobs)
      expect(override).toBeDefined()
      expect(override!.id).toBe(canonicalJob.id)
    })

    it('returns undefined for already-canonical job', async () => {
      const { canonicalJob } = await setupDuplicateJobScenario('override-2')
      const allJobs = getJobs()

      const override = findCanonicalOverride(canonicalJob.id, allJobs)
      expect(override).toBeUndefined()
    })

    it('returns undefined when no duplicates exist', async () => {
      const conv = makeConversation('override-3')
      addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '1.000 \u20ac',
        description: 'Single job test',
      })

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      const allJobs = getJobs()

      const override = findCanonicalOverride(accepted!.createdJobId!, allJobs)
      expect(override).toBeUndefined()
    })
  })

  // ── 10. Acceptance flow duplicate prevention ──────────────────────────

  describe('10. acceptance flow duplicate prevention', () => {
    it('acceptance reuses existing job with sourceConversationId matching', async () => {
      const conv = makeConversation('reuse-1')
      addConversation(conv)

      // Pre-create a job for the conversation (simulating inquiry conversion)
      const existingJob: Job = {
        id: 'existing-job-reuse-1',
        projectId: conv.projectId!,
        title: 'Existing inquiry job',
        customer: 'Anna Kundin',
        location: 'Berlin',
        dateLabel: 'Termin offen',
        status: 'new',
        amount: '',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: 'Noch keine Dokumentation',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        craftsmanUserId: 'craftsman-canonical',
        customerUserId: 'customer-canonical',
        sourceConversationId: conv.id,
      }
      await addJob(existingJob)

      // Create and accept offer
      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '3.000 \u20ac',
        description: 'Reuse test',
      })

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

      // The accepted job should be the EXISTING one (reused, not duplicated)
      expect(accepted!.createdJobId).toBe('existing-job-reuse-1')

      // The existing job now has sourceOfferId set
      const updatedJob = getJobById('existing-job-reuse-1')!
      expect(updatedJob.sourceOfferId).toBe(offer.id)
      expect(updatedJob.proposalAcceptedAt).toBeTruthy()
    })
  })
})
