/**
 * Thread Card Hierarchy Tests — Block 3
 *
 * Validates the canonical thread context key, active-card dominance,
 * duplicate/near-duplicate suppression, active vs historical separation,
 * ordering/prioritization, and safe context scoping.
 *
 * Canonical thread context key: jobId
 *   — links offer, funding request, escrow plan within one workflow context.
 *
 * Active-card dominance rule:
 *   1. Funding in active CTA phase (sent/funding_started/funding_initiated):
 *      offer card downgrades from payment_due → accepted (funding is the CTA).
 *   2. Funding in funded phase:
 *      offer card downgrades from payment_due → accepted AND is marked as
 *      superseded (offerFundingSuperseded = true) so the UI suppresses it
 *      from the persistent context area.
 *   3. Funding in a retryable failure phase (funding_failed):
 *      offer card retains payment_due — the same request can still be paid.
 *   4. Funding in a terminal-dead phase (cancelled/expired):
 *      offer card downgrades payment_due → accepted — the request can never be
 *      paid (a pay attempt 409s), so it must not be presented as payable.
 *   5. Different jobIds: no cross-suppression.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateUUID(): string {
  return `uuid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Test Kunde',
    customerAvatarUrl: '',
    customerUserId: `customer-${id}`,
    craftsmanName: 'Test Handwerker',
    craftsmanHandle: 'test-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: `craftsman-${id}`,
    projectTitle: 'Thread Hierarchy Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    messages: [],
  } as unknown as Conversation
}

function setupConversationWithOfferAndFunding(params: {
  convId: string
  jobId: string
  offerPhase?: string
  fundingPhase: string
  fundingJobId?: string
}) {
  const { convId, jobId, offerPhase = 'payment_due', fundingPhase, fundingJobId } = params
  const conv = makeConversation(convId)
  setMessageRepository(new InMemoryMessageRepository([conv], []))

  const artifactRepo = new InMemoryThreadArtifactRepository()
  artifactRepo.upsert({
    id: generateUUID(),
    conversationId: convId,
    artifactType: 'offer',
    offerId: `offer-${convId}`,
    jobId,
    phase: offerPhase,
    snapshotPrice: '1.000 €',
    snapshotPhaseLabel: 'Zahlung fällig',
    createdAt: Date.now() - 2000,
  })

  artifactRepo.upsert({
    id: generateUUID(),
    conversationId: convId,
    artifactType: 'funding_step',
    jobId: fundingJobId ?? jobId,
    fundingRequestId: `fr-${convId}`,
    escrowPlanId: `ep-${convId}`,
    phase: fundingPhase,
    snapshotPrice: '1.000 €',
    snapshotPhaseLabel: 'Zahlung',
    createdAt: Date.now() - 1000,
  })
  setThreadArtifactRepository(artifactRepo)

  return { conv }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Thread Card Hierarchy — Block 3', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUNDED CONTEXT: stale payment-due cards no longer remain active
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. Funded context suppresses stale payment-due', () => {
    it('offer phase downgrades from payment_due to accepted when funding is funded', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1a',
        jobId: 'job-h1a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h1a')

      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('offer phase downgrades from payment_due to accepted when funding is sent (active CTA)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1b',
        jobId: 'job-h1b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-h1b')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer phase downgrades when funding is funding_started', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1c',
        jobId: 'job-h1c',
        fundingPhase: 'funding_started',
      })

      const artifacts = getThreadArtifacts('conv-h1c')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer phase downgrades when funding is funding_initiated', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1d',
        jobId: 'job-h1d',
        fundingPhase: 'funding_initiated',
      })

      const artifacts = getThreadArtifacts('conv-h1d')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer retains payment_due when funding is failed (non-active phase)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1e',
        jobId: 'job-h1e',
        fundingPhase: 'funding_failed',
      })

      const artifacts = getThreadArtifacts('conv-h1e')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })

    it('offer downgrades to accepted when funding is cancelled (terminal-dead)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1f',
        jobId: 'job-h1f',
        fundingPhase: 'cancelled',
      })

      const artifacts = getThreadArtifacts('conv-h1f')

      // Terminal-dead funding can never be paid — the offer must not stay payable.
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer downgrades to accepted when funding is expired (terminal-dead)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h1g',
        jobId: 'job-h1g',
        fundingPhase: 'expired',
      })

      const artifacts = getThreadArtifacts('conv-h1g')

      // Terminal-dead funding can never be paid — the offer must not stay payable.
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. DUPLICATE FUNDED CONFIRMATIONS are suppressed
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. Duplicate funded confirmations suppressed', () => {
    it('offerFundingSuperseded is true when funding is funded for same jobId', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h2a',
        jobId: 'job-h2a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h2a')

      expect(artifacts.offerFundingSuperseded).toBe(true)
      // The offer card is superseded — the funding card is the primary confirmation
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('offerFundingSuperseded is true when funding is in active CTA phase', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h2b',
        jobId: 'job-h2b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-h2b')

      // Superseded — funding CTA is the dominant active surface;
      // offer is historical-only and suppressed from persistent context.
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('offerFundingSuperseded is false when no offer artifact', () => {
      const conv = makeConversation('conv-h2c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h2c',
        artifactType: 'funding_step',
        jobId: 'job-h2c',
        fundingRequestId: 'fr-h2c',
        escrowPlanId: 'ep-h2c',
        phase: 'funded',
        snapshotPrice: '1.000 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h2c')

      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. ONE PRIMARY ACTIVE CARD per canonical context
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. One primary active card per context', () => {
    it('when funding is funded: funding is primary, offer is superseded', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h3a',
        jobId: 'job-h3a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h3a')

      // Funding card is the primary active card
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      // Offer is superseded (will be suppressed from persistent context)
      expect(artifacts.offerFundingSuperseded).toBe(true)
      // Offer shows accepted, not payment_due
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('when funding is sent: funding is CTA, offer is superseded from persistent context', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h3b',
        jobId: 'job-h3b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-h3b')

      // Funding card is the active CTA
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      // Offer shows accepted (not competing as payment CTA)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // Superseded — funding CTA is the dominant surface, offer is historical
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('when only offer exists (no funding): offer is primary', () => {
      const conv = makeConversation('conv-h3c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h3c',
        artifactType: 'offer',
        offerId: 'offer-h3c',
        jobId: 'job-h3c',
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h3c')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. HISTORICAL CONTEXT is suppressed or downgraded when superseded
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. Historical context downgraded when superseded', () => {
    it('offer card shows accepted (not payment_due) when funding step is active', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h4a',
        jobId: 'job-h4a',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-h4a')

      // The old payment_due state is historical — replaced by accepted
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('non-payment_due offer phases are not affected by funding reconciliation', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h4b',
        jobId: 'job-h4b',
        offerPhase: 'accepted',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h4b')

      // Offer already accepted — no change needed
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      // But still superseded because funding is funded for same jobId
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('declined offer is not affected by funding reconciliation', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h4c',
        jobId: 'job-h4c',
        offerPhase: 'declined',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h4c')

      // Declined stays declined
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SAFE CONTEXT SCOPING: different jobs/contexts do not suppress each other
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. Safe context scoping by jobId', () => {
    it('offer retains payment_due when funding_step is for a different jobId', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h5a',
        jobId: 'job-h5a-offer',
        fundingPhase: 'funded',
        fundingJobId: 'job-h5a-funding', // different job!
      })

      const artifacts = getThreadArtifacts('conv-h5a')

      // Different jobIds: no cross-suppression
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('offerFundingSuperseded is false when jobIds differ', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h5b',
        jobId: 'job-h5b-offer',
        fundingPhase: 'funded',
        fundingJobId: 'job-h5b-funding',
      })

      const artifacts = getThreadArtifacts('conv-h5b')

      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('offer without jobId is not affected by funding reconciliation', () => {
      const conv = makeConversation('conv-h5c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h5c',
        artifactType: 'offer',
        offerId: 'offer-h5c',
        // No jobId — offer before acceptance
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        createdAt: Date.now() - 2000,
      })
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h5c',
        artifactType: 'funding_step',
        jobId: 'job-h5c',
        fundingRequestId: 'fr-h5c',
        escrowPlanId: 'ep-h5c',
        phase: 'funded',
        snapshotPrice: '1.000 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h5c')

      // No jobId on offer: cannot reconcile
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. ORDERING favors current active card over stale historical cards
  // ═══════════════════════════════════════════════════════════════════════════

  describe('6. Ordering and prioritization', () => {
    it('funding_step is returned alongside reconciled offer (both present)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h6a',
        jobId: 'job-h6a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h6a')

      // Both artifacts are returned (timeline needs both for history)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact).not.toBeNull()

      // Offer is older, funding is newer
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThan(
        artifacts.fundingStepArtifact!.createdAt
      )
    })

    it('artifacts maintain chronological order for timeline rendering', () => {
      const conv = makeConversation('conv-h6b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      const offerTime = Date.now() - 5000
      const fundingTime = Date.now() - 2000

      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h6b',
        artifactType: 'offer',
        offerId: 'offer-h6b',
        jobId: 'job-h6b',
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        createdAt: offerTime,
      })
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h6b',
        artifactType: 'funding_step',
        jobId: 'job-h6b',
        fundingRequestId: 'fr-h6b',
        escrowPlanId: 'ep-h6b',
        phase: 'sent',
        snapshotPrice: '1.000 €',
        createdAt: fundingTime,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h6b')

      // Offer created first, funding later
      expect(artifacts.offerPaymentArtifact!.createdAt).toBe(offerTime)
      expect(artifacts.fundingStepArtifact!.createdAt).toBe(fundingTime)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION to Block 2 lifecycle correctness
  // ═══════════════════════════════════════════════════════════════════════════

  describe('7. No regression to existing behavior', () => {
    it('offer-only thread (no funding) behaves unchanged', () => {
      const conv = makeConversation('conv-h7a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h7a',
        artifactType: 'offer',
        offerId: 'offer-h7a',
        phase: 'sent',
        snapshotPrice: '500 €',
        snapshotSummary: 'Badezimmer',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h7a')

      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('funding-only thread (no offer) behaves unchanged', () => {
      const conv = makeConversation('conv-h7b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateUUID(),
        conversationId: 'conv-h7b',
        artifactType: 'funding_step',
        jobId: 'job-h7b',
        fundingRequestId: 'fr-h7b',
        escrowPlanId: 'ep-h7b',
        phase: 'funded',
        snapshotPrice: '1.000 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-h7b')

      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('empty thread returns clean defaults', () => {
      const conv = makeConversation('conv-h7c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository())

      const artifacts = getThreadArtifacts('conv-h7c')

      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.projectArtifacts).toEqual([])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. NO REGRESSION to payment/funding flows
  // ═══════════════════════════════════════════════════════════════════════════

  describe('8. Payment and funding flow integrity', () => {
    it('funding_step artifact fields are fully preserved', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h8a',
        jobId: 'job-h8a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h8a')
      const funding = artifacts.fundingStepArtifact!

      expect(funding.jobId).toBe('job-h8a')
      expect(funding.fundingRequestId).toBe('fr-conv-h8a')
      expect(funding.escrowPlanId).toBe('ep-conv-h8a')
      expect(funding.phase).toBe('funded')
    })

    it('offer artifact fields are preserved even when reconciled', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h8b',
        jobId: 'job-h8b',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h8b')
      const offer = artifacts.offerPaymentArtifact!

      expect(offer.jobId).toBe('job-h8b')
      // Phase is reconciled but snapshot data is preserved
      expect(offer.phase).toBe('accepted')
      expect(offer.snapshot?.price).toBe('1.000 €')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ALL ACTIVE FUNDING PHASES tested
  // ═══════════════════════════════════════════════════════════════════════════

  describe('9. Comprehensive phase coverage', () => {
    const activeCTAPhases = ['sent', 'funding_started', 'funding_initiated']
    // Retryable: the same request can still be paid → offer stays payment_due.
    const retryableFailurePhases = ['funding_failed']
    // Terminal-dead: request can never be paid → offer downgrades to accepted.
    const terminalDeadPhases = ['cancelled', 'expired']

    for (const phase of activeCTAPhases) {
      it(`active CTA phase '${phase}': offer downgrades and superseded`, () => {
        const convId = `conv-h9-${phase}`
        setupConversationWithOfferAndFunding({
          convId,
          jobId: `job-h9-${phase}`,
          fundingPhase: phase,
        })

        const artifacts = getThreadArtifacts(convId)

        expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
        // Superseded: funding CTA is the dominant surface
        expect(artifacts.offerFundingSuperseded).toBe(true)
      })
    }

    for (const phase of retryableFailurePhases) {
      it(`retryable phase '${phase}': offer retains payment_due, not superseded`, () => {
        const convId = `conv-h9-${phase}`
        setupConversationWithOfferAndFunding({
          convId,
          jobId: `job-h9-${phase}`,
          fundingPhase: phase,
        })

        const artifacts = getThreadArtifacts(convId)

        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(artifacts.offerFundingSuperseded).toBe(false)
      })
    }

    for (const phase of terminalDeadPhases) {
      it(`terminal-dead phase '${phase}': offer downgrades to accepted, not superseded`, () => {
        const convId = `conv-h9-${phase}`
        setupConversationWithOfferAndFunding({
          convId,
          jobId: `job-h9-${phase}`,
          fundingPhase: phase,
        })

        const artifacts = getThreadArtifacts(convId)

        // Dead request can never be paid — offer must not stay payable.
        expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
        // Not superseded: funding card carries the dead state with no CTA.
        expect(artifacts.offerFundingSuperseded).toBe(false)
      })
    }

    it(`funded phase: offer downgrades AND superseded`, () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-h9-funded',
        jobId: 'job-h9-funded',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-h9-funded')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })
  })
})
