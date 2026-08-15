/**
 * Final Funded-State Canonicalization Tests
 *
 * Validates:
 * 1. Strengthened funded dominance (both FundingRequest + EscrowPlan)
 * 2. Duplicate funded confirmation suppression (offer + funding_step)
 * 3. Snapshot fallback path applies funded dominance
 * 4. Thread-level funded display is singular and canonical
 * 5. Context-scoped: unrelated pending contexts still visible
 * 6. No regression to existing funded dominance behavior
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
  ensureFundingRequest,
  markFundingCompleted,
  markFundingRequestSent,
} from '../../src/lib/payments/fundingRequest'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { generateUUID } from '../../src/lib/shared/generateUUID'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-test',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-test',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-test',
    projectTitle: 'Test Project',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

function createFundedRequest(jobId: string, escrowPlanId = 'escrow-plan-1') {
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: escrowPlanId,
    jobId,
    offerId: 'offer-1',
    totalAmount: 1000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const request = ensureFundingRequest({
    sourceOfferId: 'offer-1',
    jobId,
    escrowPlanId,
    customerUserId: 'customer-test',
    providerUserId: 'craftsman-test',
    providerId: 'provider-test',
    amount: 1000,
  })
  markFundingRequestSent(request.id)
  markFundingCompleted(request.id)
  return request
}

function createEscrowOnlyFunded(jobId: string, escrowPlanId = 'escrow-plan-only-1') {
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: escrowPlanId,
    jobId,
    offerId: 'offer-eo-1',
    totalAmount: 1000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  // Funding request exists but NOT marked funded (simulates partial update)
  return ensureFundingRequest({
    sourceOfferId: 'offer-eo-1',
    jobId,
    escrowPlanId,
    customerUserId: 'customer-test',
    providerUserId: 'craftsman-test',
    providerId: 'provider-test',
    amount: 1000,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Final funded-state canonicalization', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Strengthened funded dominance (escrow plan fallback) ──────────

  describe('strengthened funded dominance', () => {
    it('detects funded via FundingRequest.status === funded', () => {
      createFundedRequest('job-1')
      expect(isFundingConfirmedForJob('job-1')).toBe(true)
    })

    it('detects funded via EscrowPlan.status === funded_in_escrow even when FundingRequest is not funded', () => {
      createEscrowOnlyFunded('job-2')
      // FundingRequest is still 'created' (not funded), but escrow plan is funded_in_escrow
      expect(isFundingConfirmedForJob('job-2')).toBe(true)
    })

    it('detects funded via EscrowPlan.status === partially_released', () => {
      const escrowRepo = getEscrowPlanRepository()
      escrowRepo.addPlan({
        id: 'escrow-partial',
        jobId: 'job-3',
        offerId: 'offer-3',
        totalAmount: 1000,
        currency: 'EUR',
        status: 'partially_released',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect(isFundingConfirmedForJob('job-3')).toBe(true)
    })

    it('detects funded via EscrowPlan.status === fully_released', () => {
      const escrowRepo = getEscrowPlanRepository()
      escrowRepo.addPlan({
        id: 'escrow-full',
        jobId: 'job-4',
        offerId: 'offer-4',
        totalAmount: 1000,
        currency: 'EUR',
        status: 'fully_released',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect(isFundingConfirmedForJob('job-4')).toBe(true)
    })

    it('returns false when escrow plan exists but is awaiting_customer_funding', () => {
      const escrowRepo = getEscrowPlanRepository()
      escrowRepo.addPlan({
        id: 'escrow-pending',
        jobId: 'job-5',
        offerId: 'offer-5',
        totalAmount: 1000,
        currency: 'EUR',
        status: 'awaiting_customer_funding',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect(isFundingConfirmedForJob('job-5')).toBe(false)
    })

    it('returns false when neither funding request nor escrow plan exist', () => {
      expect(isFundingConfirmedForJob('nonexistent')).toBe(false)
    })
  })

  // ── 2. Duplicate funded confirmation suppression ────────────────────

  describe('duplicate funded confirmation suppression in getThreadArtifacts', () => {
    it('reconciles offer payment_due to accepted when funding_step is funded for the same job', () => {
      const conv = makeConversation('conv-dup-1')
      const jobId = 'job-dup-1'
      const convId = conv.id

      // Set up repos with conversation
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Create offer artifact with payment_due phase
      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-dup-1',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
      })

      // Create funding_step artifact with funded phase
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        fundingRequestId: 'fr-dup-1',
        escrowPlanId: 'ep-dup-1',
        phase: 'funded',
        snapshotPrice: '1.000 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      // Create funded request for the job so dominance check passes
      createFundedRequest(jobId)

      const artifacts = getThreadArtifacts(convId)

      // Offer should be reconciled from payment_due to accepted
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')

      // Funding step should still show funded
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('reconciles offer phase to accepted when funding_step is in active CTA phase (sent)', () => {
      const conv = makeConversation('conv-dup-2')
      const jobId = 'job-dup-2'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-dup-2',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
      })

      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        fundingRequestId: 'fr-dup-2',
        escrowPlanId: 'ep-dup-2',
        phase: 'sent',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Block 3: when funding_step is in active CTA phase (sent) for the same
      // jobId, the offer card is downgraded from payment_due to accepted because
      // the funding step IS the payment action surface.
      // The offer is also superseded from persistent context — funding CTA is
      // the dominant surface.
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('does NOT reconcile offer phase when funding_step is in terminal failure phase', () => {
      const conv = makeConversation('conv-dup-2b')
      const jobId = 'job-dup-2b'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-dup-2b',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
      })

      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        fundingRequestId: 'fr-dup-2b',
        escrowPlanId: 'ep-dup-2b',
        phase: 'funding_failed',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Einzahlung fehlgeschlagen',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Terminal failure phase: offer retains payment_due because the funding
      // step is not active — the user may need to retry via a different path.
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('does NOT reconcile offer phase when job IDs differ', () => {
      const conv = makeConversation('conv-dup-3')
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-dup-3a',
        jobId: 'job-dup-3a',
        phase: 'payment_due',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
      })

      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId: 'job-dup-3b', // different job
        fundingRequestId: 'fr-dup-3b',
        escrowPlanId: 'ep-dup-3b',
        phase: 'funded',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Offer should still show payment_due (different job context)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })
  })

  // ── 3. Snapshot fallback applies funded dominance ───────────────────

  describe('snapshot fallback funded dominance', () => {
    it('suppresses payment_due phase in snapshot-only offer artifact when funding is confirmed', () => {
      const conv = makeConversation('conv-snap-1')
      const jobId = 'job-snap-1'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Create an offer artifact record with payment_due phase and snapshot
      // but NO matching offer entity in the store (snapshot-only path)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-snap-1',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      // Mark funding as confirmed for this job
      createFundedRequest(jobId)

      const artifacts = getThreadArtifacts(convId)

      // The snapshot-only artifact should have its phase overridden to accepted
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // Verify it is indeed a snapshot-based artifact (no offer entity)
      expect(artifacts.offerPaymentArtifact!.offer).toBeNull()
    })

    it('keeps payment_due phase in snapshot artifact when funding is NOT confirmed', () => {
      const conv = makeConversation('conv-snap-2')
      const jobId = 'job-snap-2'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-snap-2',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      // No funding request created — funding NOT confirmed

      const artifacts = getThreadArtifacts(convId)

      // payment_due should remain
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })
  })

  // ── 4. Context scoping — no accidental global suppression ───────────

  describe('context scoping', () => {
    it('funded job does not suppress offer phase for unrelated pending job', () => {
      const conv = makeConversation('conv-scope-1')
      const fundedJobId = 'job-scope-funded'
      const pendingJobId = 'job-scope-pending'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Only the offer is for the pending job, funding is for a different job
      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-scope-1',
        jobId: pendingJobId,
        phase: 'payment_due',
        snapshotPrice: '500 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      // Fund a different job
      createFundedRequest(fundedJobId)

      const artifacts = getThreadArtifacts(convId)

      // Offer should STILL show payment_due — different job context
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })
  })

  // ── 5. No regression ───────────────────────────────────────────────

  describe('no regression', () => {
    it('isFundingConfirmedForJob still works for standard funded request', () => {
      createFundedRequest('job-regress-1')
      expect(isFundingConfirmedForJob('job-regress-1')).toBe(true)
    })

    it('isFundingConfirmedForJob returns false for pending funding request without funded escrow', () => {
      ensureFundingRequest({
        sourceOfferId: 'offer-regress',
        jobId: 'job-regress-2',
        escrowPlanId: 'escrow-regress',
        customerUserId: 'customer-test',
        providerUserId: 'craftsman-test',
        providerId: 'provider-test',
        amount: 500,
      })
      expect(isFundingConfirmedForJob('job-regress-2')).toBe(false)
    })
  })
})
