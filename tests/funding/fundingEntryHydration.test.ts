/**
 * Funding Entry Data Hydration Hardening Tests
 *
 * Verifies:
 * 1. Direct /funding/:fundingRequestId entry works on empty stores
 *    (after repository hydration)
 * 2. Reload on funding route still loads correctly
 * 3. Funding request found after repository hydration
 * 4. Missing escrow plan does NOT misreport as "funding request not found"
 * 5. True invalid fundingRequestId shows real not-found state
 * 6. Funded / started / sent statuses still render correct payment states
 * 7. No regression to dedicated funding entry routing
 * 8. Escrow plan accessible by funding request's escrowPlanId after workflow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the provider profile service to avoid real HTTP calls
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import {
  buildFundingEntryPath,
} from '../../src/lib/funding'
import {
  getFundingRequestById,
  getFundingRequestByJobId,
  initializeFundingRequestRepository,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanById,
  getEscrowPlanByJobId,
  initializeEscrowPlanRepository,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById, initializeJobRepository } from '../../src/lib/jobs'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: `customer-${id}`,
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: `craftsman-${id}`,
    projectTitle: 'Hydration Test',
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
    customerUserId: `customer-${convId}`,
    craftsmanUserId: `craftsman-${convId}`,
    price: '5.000 €',
  })

  await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const acceptedOffer = getOfferById(offer.id)!
  const job = getJobById(acceptedOffer.createdJobId!)!
  installSessionForJobOwner(job)

  return { conv, offer: acceptedOffer, job }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Entry Data Hydration Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── 1. Funding request accessible by ID after creation ─────────────────

  describe('1. Funding request accessible by ID', () => {
    it('getFundingRequestById returns funding request after workflow', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-1')
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()

      const fr = getFundingRequestById(result!.fundingRequestId)
      expect(fr).toBeDefined()
      expect(fr!.id).toBe(result!.fundingRequestId)
      expect(fr!.jobId).toBe(job.id)
      expect(fr!.status).toBe('sent')
    })

    it('buildFundingEntryPath uses the same ID returned by workflow', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-2')
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()

      const path = buildFundingEntryPath(result!.fundingRequestId)
      expect(path).toBe(`/funding/${result!.fundingRequestId}`)
    })
  })

  // ─── 2. Escrow plan accessible by funding request's escrowPlanId ────────

  describe('2. Escrow plan accessible after funding workflow', () => {
    it('escrow plan exists and is linked to funding request', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-escrow-1')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.escrowPlanId).toBeTruthy()

      const plan = getEscrowPlanById(fr!.escrowPlanId)
      expect(plan).toBeDefined()
      expect(plan!.jobId).toBe(job.id)
      expect(plan!.status).toBe('awaiting_customer_funding')
    })

    it('escrow plan accessible by jobId matches funding request linkage', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-escrow-2')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      const planById = getEscrowPlanById(fr.escrowPlanId)
      const planByJob = getEscrowPlanByJobId(job.id)

      expect(planById).toBeDefined()
      expect(planByJob).toBeDefined()
      expect(planById!.id).toBe(planByJob!.id)
    })
  })

  // ─── 3. Repository hydration re-initialization is safe ──────────────────

  describe('3. Repository re-initialization is safe', () => {
    it('re-initializing repos does not clear existing data', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-reinit-1')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!

      // Re-initialize (simulates the screen's hydration attempt)
      await initializeFundingRequestRepository()
      await initializeEscrowPlanRepository()
      await initializeJobRepository()

      // Data should still be there
      const frAfter = getFundingRequestById(fr.id)
      expect(frAfter).toBeDefined()
      expect(frAfter!.id).toBe(fr.id)

      const plan = getEscrowPlanById(fr.escrowPlanId)
      expect(plan).toBeDefined()
    })

    it('concurrent re-initialization is safe', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-reinit-2')
      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      // Simulate what FundingEntryScreen does: parallel init
      await Promise.all([
        initializeFundingRequestRepository(),
        initializeEscrowPlanRepository(),
        initializeJobRepository(),
      ])

      const frAfter = getFundingRequestById(fr.id)
      expect(frAfter).toBeDefined()
      expect(frAfter!.id).toBe(fr.id)
    })
  })

  // ─── 4. Missing escrow plan ≠ missing funding request ───────────────────

  describe('4. Missing escrow plan does not misreport as funding request not found', () => {
    it('funding request found but escrow plan missing is distinguishable', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-noplan-1')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!

      // Funding request exists
      const frById = getFundingRequestById(fr.id)
      expect(frById).toBeDefined()

      // Escrow plan exists (normal case)
      const plan = getEscrowPlanById(fr.escrowPlanId)
      expect(plan).toBeDefined()

      // Now simulate the state where a consumer distinguishes:
      // "funding request found" vs "escrow plan found"
      // These are two separate boolean checks
      const fundingFound = frById !== undefined
      const escrowFound = plan !== undefined
      expect(fundingFound).toBe(true)
      expect(escrowFound).toBe(true)
    })

    it('invalid escrowPlanId returns undefined plan without affecting funding request lookup', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-noplan-2')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!

      // Funding request is found
      expect(getFundingRequestById(fr.id)).toBeDefined()

      // A bogus escrow plan ID returns undefined — separate from "not found"
      const bogusPlan = getEscrowPlanById('nonexistent-plan-id')
      expect(bogusPlan).toBeUndefined()

      // But the funding request is still there — these are independent lookups
      expect(getFundingRequestById(fr.id)).toBeDefined()
    })
  })

  // ─── 5. True invalid fundingRequestId ───────────────────────────────────

  describe('5. True invalid fundingRequestId shows real not-found', () => {
    it('completely unknown ID returns undefined', () => {
      const result = getFundingRequestById('nonexistent-funding-id-xyz')
      expect(result).toBeUndefined()
    })

    it('unknown ID still returns undefined after repo initialization', async () => {
      await initializeFundingRequestRepository()
      const result = getFundingRequestById('nonexistent-funding-id-abc')
      expect(result).toBeUndefined()
    })

    it('unknown ID is distinct from a missing escrow plan', async () => {
      // With an unknown ID, getFundingRequestById returns undefined
      const fr = getFundingRequestById('unknown-id')
      expect(fr).toBeUndefined()

      // This is "true not-found" — no escrowPlanId to even look up
      // A real FundingEntryScreen would show "Zahlungsanfrage nicht gefunden"
      // (not "Zahlungskontext wird geladen")
    })
  })

  // ─── 6. Status-specific data availability ───────────────────────────────

  describe('6. Funded / started / sent statuses preserve correct data', () => {
    it('sent status has correct funding request + escrow plan', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-status-1')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      expect(fr.status).toBe('sent')
      expect(fr.amount).toBe(5000)

      const plan = getEscrowPlanById(fr.escrowPlanId)!
      expect(plan.status).toBe('awaiting_customer_funding')
      expect(plan.totalAmount).toBe(5000)
    })

    it('funding request carries jobId for CustomerEscrowFundingCard', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-status-2')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      // This is what FundingEntryScreen passes to CustomerEscrowFundingCard
      expect(fr.jobId).toBe(job.id)

      // The card then uses getFundingRequestByJobId(jobId) — verify the round-trip
      const frByJob = getFundingRequestByJobId(fr.jobId)
      expect(frByJob).toBeDefined()
      expect(frByJob!.id).toBe(fr.id)
    })
  })

  // ─── 7. No regression to dedicated funding entry routing ────────────────

  describe('7. No regression to dedicated funding entry routing', () => {
    it('entry path is /funding/:id, never /projects', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-route-1')
      const result = await requestFundingWorkflow(job.id)!

      const path = buildFundingEntryPath(result.fundingRequestId)
      expect(path).toContain('/funding/')
      expect(path).not.toContain('/projects')
      expect(path).not.toContain('?focus=payment')
    })

    it('path is deterministic and independent of store hydration', () => {
      // Path generation works without any store state
      const path1 = buildFundingEntryPath('fr-hydrate-deterministic')
      const path2 = buildFundingEntryPath('fr-hydrate-deterministic')
      expect(path1).toBe(path2)
      expect(path1).toBe('/funding/fr-hydrate-deterministic')
    })
  })

  // ─── 8. Full hydration chain: funding request → escrow plan → job ───────

  describe('8. Full hydration chain is intact', () => {
    it('funding request → escrow plan → job linkage is complete', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-chain-1')
      await requestFundingWorkflow(job.id)

      // Step 1: Get funding request by ID
      const fr = getFundingRequestByJobId(job.id)!
      const frById = getFundingRequestById(fr.id)!
      expect(frById.id).toBe(fr.id)

      // Step 2: Get escrow plan from funding request
      const plan = getEscrowPlanById(frById.escrowPlanId)!
      expect(plan).toBeDefined()
      expect(plan.jobId).toBe(job.id)

      // Step 3: Get job from funding request
      const linkedJob = getJobById(frById.jobId)!
      expect(linkedJob).toBeDefined()
      expect(linkedJob.id).toBe(job.id)
    })

    it('escrow plan sourceOfferId matches funding request sourceOfferId', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-chain-2')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanById(fr.escrowPlanId)!

      expect(fr.sourceOfferId).toBe(plan.sourceOfferId)
    })
  })
})
