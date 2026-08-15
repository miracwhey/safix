/**
 * Block 5A — Canonical Payment Projection Truth + Thread Artifact Reconciliation
 *
 * Tests the specific failure classes identified in the Block 5A package:
 *
 * 1. Funded fundingRequest / funded escrowPlan no longer leaves payment_due /
 *    sent as active visible truth
 * 2. Thread artifact projections are reconciled or overridden correctly after
 *    funding confirmation
 * 3. Payment-required projections disappear for the funded context
 * 4. Snapshot price formatting is consistent across artifact types
 * 5. Already-paid contexts do not still present as unpaid on
 *    customer/provider payment surfaces
 * 6. Unrelated unpaid contexts are unaffected
 * 7. No regression to Blocks 1–4
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
  getFundingRequestByJobId,
} from '../../src/lib/payments/fundingRequest'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { generateUUID } from '../../src/lib/shared/generateUUID'
import { formatEuro, formatOfferPrice } from '../../src/lib/shared/formatters'
import { deriveCustomerDepositAction } from '../../src/lib/jobs/customerDepositSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import type { Conversation } from '../../src/lib/messages/types'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
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
    ...overrides,
  } as unknown as Conversation
}

async function createFundedContext(jobId: string, escrowPlanId?: string) {
  const planId = escrowPlanId ?? `escrow-${jobId}`
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: planId,
    jobId,
    offerId: `offer-${jobId}`,
    totalAmount: 1000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const request = await ensureFundingRequest({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    escrowPlanId: planId,
    customerUserId: 'customer-test',
    providerUserId: 'craftsman-test',
    providerId: 'provider-test',
    amount: 1000,
  })
  await markFundingRequestSent(request.id)
  await markFundingCompleted(request.id)
  return { request, escrowPlanId: planId }
}

async function createPendingContext(jobId: string, escrowPlanId?: string) {
  const planId = escrowPlanId ?? `escrow-pending-${jobId}`
  const escrowRepo = getEscrowPlanRepository()
  escrowRepo.addPlan({
    id: planId,
    jobId,
    offerId: `offer-${jobId}`,
    totalAmount: 2000,
    currency: 'EUR',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const request = await ensureFundingRequest({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    escrowPlanId: planId,
    customerUserId: 'customer-test',
    providerUserId: 'craftsman-test',
    providerId: 'provider-test',
    amount: 2000,
  })
  await markFundingRequestSent(request.id)
  return { request, escrowPlanId: planId }
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    status: 'new',
    customerUserId: 'customer-test',
    craftsmanUserId: 'craftsman-test',
    paymentState: 'deposit_required',
    projectId: `project-${id}`,
    proposalSentAt: Date.now() - 10000,
    proposalAcceptedAt: Date.now() - 5000,
    ...overrides,
  } as Job
}

function makePayment(jobId: string, overrides: Partial<Payment> = {}): Payment {
  return {
    id: `payment-${jobId}`,
    jobId,
    state: 'deposit_required',
    amounts: { totalAmount: 1000, depositAmount: 1000, depositPercent: 100 },
    ...overrides,
  } as Payment
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Block 5A — Canonical Payment Projection Truth', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Funded truth stops stale payment_due / sent from surviving
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. funded truth dominates stale artifact phases', () => {
    it('funding_step snapshot shows funded when canonical funded truth exists (entity not loaded)', async () => {
      const convId = 'conv-funded-snap'
      const jobId = 'job-funded-snap'
      const fundedCtx = await createFundedContext(jobId)

      // Set up conversation + artifact with stale 'sent' phase (as if created before funding)
      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Create a funding_step artifact record with stale 'sent' phase
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        fundingRequestId: fundedCtx.request.id,
        escrowPlanId: fundedCtx.escrowPlanId,
        jobId,
        phase: 'sent',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      // Key assertion: phase must be 'funded', not stale 'sent'
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('offer payment_due is reconciled to accepted when funding is confirmed', async () => {
      const convId = 'conv-offer-recon'
      const jobId = 'job-offer-recon'
      await createFundedContext(jobId)

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Create offer artifact with stale payment_due phase
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: `offer-${jobId}`,
        jobId,
        phase: 'payment_due',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      // Create matching funding_step artifact
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        fundingRequestId: getFundingRequestByJobId(jobId)!.id,
        escrowPlanId: `escrow-${jobId}`,
        jobId,
        phase: 'sent',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // Offer must be downgraded from payment_due → accepted
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // Funding step must show funded
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      // Offer superseded by funded funding step
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Thread artifact projections reconciled after funding confirmation
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. thread artifact reconciliation after funding', () => {
    it('funding_step preserves terminal non-success phases (failed/cancelled/expired)', () => {
      const convId = 'conv-terminal'
      const jobId = 'job-terminal'

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // No funded context — just a failed funding step
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        phase: 'funding_failed',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Einzahlung fehlgeschlagen',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // Terminal failure phase must be preserved, not overridden to 'funded'
      expect(artifacts.fundingStepArtifact!.phase).toBe('funding_failed')
    })

    it('funding_step phase remains sent when no funded truth exists', async () => {
      const convId = 'conv-pending'
      const jobId = 'job-pending'
      await createPendingContext(jobId)

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Artifact with sent phase, no funded truth for this job
      // (pending context has escrow status = 'pending', not funded)
      // But the funding request IS sent, so entity will override
      const fr = getFundingRequestByJobId(jobId)!
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        fundingRequestId: fr.id,
        jobId,
        phase: 'sent',
        snapshotPrice: formatEuro(2000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // Should remain 'sent' since funding is not confirmed
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      expect(isFundingConfirmedForJob(jobId)).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Payment-required projections disappear for funded context
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. payment-required projections disappear for funded context', () => {
    it('customerDepositAction returns deposit_paid when funding is confirmed', async () => {
      const jobId = 'job-deposit-funded'
      await createFundedContext(jobId)

      const job = makeJob(jobId)
      const payment = makePayment(jobId)

      const vm = deriveCustomerDepositAction(job, payment, 'funded')
      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('deposit_paid')
      expect(vm!.customerActionRequired).toBe(false)
    })

    it('customerNextStep shows funded_in_escrow when funding is confirmed', async () => {
      const jobId = 'job-next-funded'
      await createFundedContext(jobId)

      const job = makeJob(jobId)
      const payment = makePayment(jobId)

      const step = deriveCustomerNextStep(job, payment, 'funded', 'funded_in_escrow')
      expect(step.label).toBe('Zahlung abgesichert')
      expect(step.actionRoute).toBeUndefined()
      expect(step.actionLabel).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Snapshot price formatting is consistent
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. snapshot price formatting consistency', () => {
    it('formatOfferPrice produces canonical format for numeric input', () => {
      expect(formatOfferPrice(1000)).toBe(formatEuro(1000))
      expect(formatOfferPrice(2500)).toBe(formatEuro(2500))
    })

    it('formatOfferPrice produces canonical format for string input', () => {
      // All common input formats produce the same canonical output
      const expected = formatEuro(1000)
      expect(formatOfferPrice('1000')).toBe(expected)
      expect(formatOfferPrice('1.000')).toBe(expected)
    })

    it('formatOfferPrice produces canonical format for German-formatted string', () => {
      const expected = formatEuro(2300)
      expect(formatOfferPrice('2.300')).toBe(expected)
    })

    it('offer and funding_step artifacts now both use canonical format', () => {
      // Funding step always used formatEuro — verify
      const fundingAmount = formatEuro(1000)
      // Offer now uses formatOfferPrice which produces the same canonical format
      const offerAmount = formatOfferPrice(1000)
      expect(offerAmount).toBe(fundingAmount)

      // String input also produces canonical format
      const offerAmountStr = formatOfferPrice('1000')
      expect(offerAmountStr).toBe(fundingAmount)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Already-paid contexts do not present as unpaid
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. already-paid context does not present as unpaid', () => {
    it('deposit_required job with funded FundingRequest shows deposit_paid', async () => {
      const jobId = 'job-already-paid'
      await createFundedContext(jobId)

      const job = makeJob(jobId)
      const payment = makePayment(jobId)

      const vm = deriveCustomerDepositAction(job, payment, 'funded')
      expect(vm).not.toBeNull()
      expect(vm!.phase).toBe('deposit_paid')
      expect(vm!.customerActionRequired).toBe(false)
    })

    it('offer artifact in funded thread shows accepted not payment_due', async () => {
      const convId = 'conv-no-splitbrain'
      const jobId = 'job-no-splitbrain'
      await createFundedContext(jobId)

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Offer artifact with stale payment_due
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: `offer-${jobId}`,
        jobId,
        phase: 'payment_due',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      })

      // Funding step artifact with stale sent
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        fundingRequestId: getFundingRequestByJobId(jobId)!.id,
        escrowPlanId: `escrow-${jobId}`,
        jobId,
        phase: 'sent',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // No payment_due should survive
      expect(artifacts.offerPaymentArtifact!.phase).not.toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // Funding shows funded, not sent
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      // Offer suppressed by funded funding step
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Unrelated unpaid contexts are unaffected
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. unrelated unpaid contexts are unaffected', () => {
    it('unfunded job keeps payment_due when no funding step exists', () => {
      const convId = 'conv-unfunded'
      const jobId = 'job-unfunded'

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Offer with payment_due and no funding step → payment_due survives
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-unfunded',
        jobId,
        phase: 'payment_due',
        snapshotPrice: formatEuro(500),
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // Payment_due remains when no funding step and no funded truth
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(isFundingConfirmedForJob(jobId)).toBe(false)
    })

    it('unfunded job with funding step sent: offer reconciled to accepted (funding card is payment surface)', () => {
      const convId = 'conv-unfunded-fs'
      const jobId = 'job-unfunded-fs'

      const msgRepo = new InMemoryMessageRepository([makeConversation(convId)], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Offer + funding_step for same job: offer is downgraded to accepted
      // because the funding step card is now the payment action surface
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'offer',
        offerId: 'offer-unfunded-fs',
        jobId,
        phase: 'payment_due',
        snapshotPrice: formatEuro(500),
        snapshotPhaseLabel: 'Zahlung fällig',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convId,
        artifactType: 'funding_step',
        jobId,
        phase: 'sent',
        snapshotPrice: formatEuro(500),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(convId)
      // Offer downgraded because funding_step 'sent' is active CTA for same job
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // Funding step stays sent (no funded truth)
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      // Not funded
      expect(isFundingConfirmedForJob(jobId)).toBe(false)
    })

    it('funded job A does not suppress unfunded job B artifacts', async () => {
      const convIdA = 'conv-job-a'
      const convIdB = 'conv-job-b'
      const jobIdA = 'job-funded-a'
      const jobIdB = 'job-unfunded-b'

      await createFundedContext(jobIdA)

      const msgRepo = new InMemoryMessageRepository([
        makeConversation(convIdA),
        makeConversation(convIdB, { craftsmanHandle: 'other-craftsman', craftsmanUserId: 'craftsman-other' }),
      ], [])
      setMessageRepository(msgRepo)
      const artifactRepo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(artifactRepo)

      // Funded job A: should show funded
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convIdA,
        artifactType: 'funding_step',
        fundingRequestId: getFundingRequestByJobId(jobIdA)!.id,
        escrowPlanId: `escrow-${jobIdA}`,
        jobId: jobIdA,
        phase: 'sent',
        snapshotPrice: formatEuro(1000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      // Unfunded job B: should remain sent
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: convIdB,
        artifactType: 'funding_step',
        jobId: jobIdB,
        phase: 'sent',
        snapshotPrice: formatEuro(2000),
        snapshotPhaseLabel: 'Zahlung angefordert',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifactsA = getThreadArtifacts(convIdA)
      const artifactsB = getThreadArtifacts(convIdB)

      // Job A: funded
      expect(artifactsA.fundingStepArtifact!.phase).toBe('funded')
      // Job B: still sent (unfunded)
      expect(artifactsB.fundingStepArtifact!.phase).toBe('sent')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. No regression to Blocks 1–4
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. no regression to existing funded dominance', () => {
    it('isFundingConfirmedForJob correctly detects funded via FundingRequest', async () => {
      await createFundedContext('job-regr-1')
      expect(isFundingConfirmedForJob('job-regr-1')).toBe(true)
    })

    it('isFundingConfirmedForJob returns false for unknown job', () => {
      expect(isFundingConfirmedForJob('job-does-not-exist')).toBe(false)
    })

    it('isFundingConfirmedForJob detects funded via EscrowPlan alone', () => {
      const escrowRepo = getEscrowPlanRepository()
      escrowRepo.addPlan({
        id: 'escrow-only-regr',
        jobId: 'job-regr-escrow',
        offerId: 'offer-regr',
        totalAmount: 1000,
        currency: 'EUR',
        status: 'funded_in_escrow',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect(isFundingConfirmedForJob('job-regr-escrow')).toBe(true)
    })
  })
})
