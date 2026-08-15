/**
 * Legacy Funding Artifact Guard — Missing jobId
 *
 * Validates that legacy funding_step artifacts without a jobId on the
 * persisted record still participate correctly in:
 *   1. Funded dominance — jobId derived from the resolved FundingRequest
 *   2. Duplicate suppression — reconciliation in getThreadArtifacts() still
 *      downgrades offer payment_due to accepted when the funding_step is funded
 *   3. No regression — modern artifacts with jobId are completely unaffected
 *
 * Root cause: ThreadArtifactRecord.jobId is optional.  Legacy DB rows
 * created before the job_id column was added may lack it.  Without jobId,
 * the reconciliation check in getThreadArtifacts() cannot match the
 * funding_step to the offer, causing a contradictory payment_due + funded
 * projection.
 *
 * Guard: resolveFundingStepArtifact() now derives jobId from the resolved
 * FundingRequest entity when the artifact record itself has no jobId.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
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

async function createFundedRequest(
  jobId: string,
  escrowPlanId = `escrow-${jobId}`,
  offerId = `offer-${jobId}`,
) {
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: escrowPlanId,
    jobId,
    offerId,
    totalAmount: 1000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const request = await ensureFundingRequest({
    sourceOfferId: offerId,
    jobId,
    escrowPlanId,
    customerUserId: 'customer-test',
    providerUserId: 'craftsman-test',
    providerId: 'provider-test',
    amount: 1000,
  })
  await markFundingRequestSent(request.id)
  await markFundingCompleted(request.id)
  return request
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Legacy funding artifact guard — missing jobId', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. jobId derived from FundingRequest for legacy artifact ─────────

  describe('jobId derivation from FundingRequest', () => {
    it('funding_step artifact without jobId derives it from the resolved FundingRequest', async () => {
      const conv = makeConversation('conv-legacy-1')
      const jobId = 'job-legacy-1'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Create a funded request so the FundingRequest entity has a jobId
      const fundingRequest = await createFundedRequest(jobId)

      // Create a legacy funding_step artifact WITHOUT jobId but WITH fundingRequestId
      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        // jobId intentionally omitted — legacy artifact
        fundingRequestId: fundingRequest.id,
        escrowPlanId: `escrow-${jobId}`,
        phase: 'funded',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      expect(artifacts.fundingStepArtifact).not.toBeNull()
      // The jobId should be derived from the FundingRequest, not empty
      expect(artifacts.fundingStepArtifact!.jobId).toBe(jobId)
    })
  })

  // ── 2. Duplicate suppression works for legacy artifact without jobId ──

  describe('duplicate suppression with legacy funding_step missing jobId', () => {
    it('reconciles offer payment_due to accepted when legacy funding_step (no jobId) is funded', async () => {
      const conv = makeConversation('conv-legacy-dup-1')
      const jobId = 'job-legacy-dup-1'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Create a funded request (canonical funded truth)
      const fundingRequest = await createFundedRequest(jobId)

      const artifactRepo = new InMemoryThreadArtifactRepository()

      // Offer artifact WITH jobId and payment_due phase
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-legacy-dup-1',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })

      // Legacy funding_step artifact WITHOUT jobId but WITH fundingRequestId
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        // jobId intentionally omitted — legacy artifact
        fundingRequestId: fundingRequest.id,
        escrowPlanId: `escrow-${jobId}`,
        phase: 'funded',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Offer MUST be reconciled to 'accepted' — not contradictory 'payment_due'
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')

      // Funding step still shows funded
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })
  })

  // ── 3. No regression — modern artifacts with jobId still work ─────────

  describe('no regression to modern artifacts', () => {
    it('modern funding_step with explicit jobId is unaffected by the guard', async () => {
      const conv = makeConversation('conv-modern-1')
      const jobId = 'job-modern-1'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const fundingRequest = await createFundedRequest(jobId)

      const artifactRepo = new InMemoryThreadArtifactRepository()

      // Offer artifact with payment_due
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-modern-1',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })

      // Modern funding_step WITH jobId
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        fundingRequestId: fundingRequest.id,
        escrowPlanId: `escrow-${jobId}`,
        phase: 'funded',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Reconciliation still works with explicit jobId
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.jobId).toBe(jobId)
    })

    it('context scoping still prevents cross-job suppression', async () => {
      const conv = makeConversation('conv-scope-legacy-1')
      const fundedJobId = 'job-funded-scope'
      const pendingJobId = 'job-pending-scope'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      // Fund job A
      await createFundedRequest(fundedJobId)

      const artifactRepo = new InMemoryThreadArtifactRepository()

      // Offer for the PENDING job (different from funded job)
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-scope-pending',
        jobId: pendingJobId,
        phase: 'payment_due',
        snapshotPrice: '500,00 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })

      // Funding step for the FUNDED job
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId: fundedJobId,
        fundingRequestId: 'fr-scope-funded',
        escrowPlanId: `escrow-${fundedJobId}`,
        phase: 'funded',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Offer for pending job must STILL show payment_due — different job context
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })
  })

  // ── 4. Edge case: legacy artifact with neither jobId nor fundingRequestId ─

  describe('extreme legacy — no jobId and no fundingRequestId', () => {
    it('funding_step with only snapshot data renders but with empty jobId', () => {
      const conv = makeConversation('conv-extreme-1')
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        // No jobId, no fundingRequestId — truly legacy
        phase: 'funded',
        snapshotPrice: '1.000,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Should still render from snapshot, but jobId is empty (no derivation source)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.jobId).toBe('')
    })

    it('does NOT reconcile offer when extreme legacy funding_step has empty jobId', () => {
      const conv = makeConversation('conv-extreme-2')
      const jobId = 'job-extreme-2'
      const convId = conv.id

      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()

      // Offer with a real jobId
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-extreme-2',
        jobId,
        phase: 'payment_due',
        snapshotPrice: '500,00 €',
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })

      // Extreme legacy funding_step — no jobId, no fundingRequestId
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        phase: 'funded',
        snapshotPrice: '500,00 €',
        snapshotPhaseLabel: 'Zahlung bestätigt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts(convId)

      // Offer should NOT be reconciled — no matching jobId possible
      // This is correct: without any identity, we cannot confirm same context
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })
  })
})
