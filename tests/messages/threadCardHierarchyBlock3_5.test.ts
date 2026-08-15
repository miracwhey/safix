/**
 * Thread Card Hierarchy Tests — Block 3.5
 *
 * Final narrow cleanup before Block 4. Validates:
 *
 * 1. Non-artifact near-duplicate suppression:
 *    QuoteSendEventCard in the timeline receives `superseded` flag when
 *    the funding step has superseded the offer for the same context.
 *
 * 2. Superseded muting (live stream): when funding is in active CTA / funded
 *    phase for the same canonical context (jobId), the offer card stays in the
 *    chronological stream but is muted via the `superseded` flag. (The old
 *    persistent ThreadArtifactCards top-layer is no longer mounted — its
 *    suppression/reorder behavior is not part of the live screen anymore.)
 *
 * 3. Terminal failure behavior:
 *    When funding is funding_failed (retryable), the offer retains payment_due.
 *    When funding is cancelled/expired (terminal-dead), the offer downgrades to
 *    accepted — the request can never be paid, so it must not stay payable.
 *
 * 4. Safe context scoping:
 *    Different jobIds are never cross-suppressed or cross-reordered.
 *
 * 5. No regression to Block 3 reconciliation.
 */

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'
import type { OfferPaymentArtifact } from '../../src/lib/messages/threadArtifactTypes'
import QuoteSendEventCard from '../../src/components/messages/QuoteSendEventCard'

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
    projectTitle: 'Block 3.5 Test',
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

function renderQuoteCard(artifact: OfferPaymentArtifact, superseded = false) {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(QuoteSendEventCard, {
        artifact,
        timeLabel: 'Gerade eben',
        role: 'customer',
        superseded,
      })
    )
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Thread Card Hierarchy — Block 3.5', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. NON-ARTIFACT NEAR-DUPLICATE SUPPRESSION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. QuoteSendEventCard visual downgrade when superseded', () => {
    it('uses muted/slate styling when superseded=true', () => {
      const artifact: OfferPaymentArtifact = {
        kind: 'offer_payment',
        phase: 'accepted',
        offer: null,
        snapshot: { price: '1.000 €', summary: 'Test', phaseLabel: 'Angenommen', offerId: 'offer-1' },
        jobId: 'job-1',
        paymentState: null,
        documentType: 'binding_offer',
        persistenceStatus: 'confirmed',
        createdAt: Date.now(),
      }

      const html = renderQuoteCard(artifact, true)

      // Superseded: status pill muted to the slate "expired" tone, NOT the
      // active emerald tone (V5 unified shell — no left-border tints anymore).
      expect(html).toContain('text-slate-500')
      expect(html).toContain('ring-slate-200')
      expect(html).not.toContain('text-emerald-700')
      expect(html).not.toContain('bg-emerald-50')
    })

    it('uses active emerald styling when NOT superseded (accepted)', () => {
      const artifact: OfferPaymentArtifact = {
        kind: 'offer_payment',
        phase: 'accepted',
        offer: null,
        snapshot: { price: '1.000 €', summary: 'Test', phaseLabel: 'Angenommen', offerId: 'offer-2' },
        jobId: 'job-2',
        paymentState: null,
        documentType: 'binding_offer',
        persistenceStatus: 'confirmed',
        createdAt: Date.now(),
      }

      const html = renderQuoteCard(artifact, false)

      // Active (accepted): emerald status pill (V5 unified shell).
      expect(html).toContain('bg-emerald-50')
      expect(html).toContain('text-emerald-700')
    })

    it('still renders card content when superseded (historical context preserved)', () => {
      const artifact: OfferPaymentArtifact = {
        kind: 'offer_payment',
        phase: 'accepted',
        offer: null,
        snapshot: { price: '1.000 €', summary: 'Komplettrenovierung', phaseLabel: 'Angenommen', offerId: 'offer-3' },
        jobId: 'job-3',
        paymentState: null,
        documentType: 'binding_offer',
        persistenceStatus: 'confirmed',
        createdAt: Date.now(),
      }

      const html = renderQuoteCard(artifact, true)

      // Content still renders (historical context preserved). No price in the
      // stream (decision 1) — the title + testid carry the context.
      expect(html).toContain('Komplettrenovierung')
      expect(html).toContain('quote-send-event')
    })

    it('phase badge uses muted styling when superseded', () => {
      const artifact: OfferPaymentArtifact = {
        kind: 'offer_payment',
        phase: 'accepted',
        offer: null,
        snapshot: { price: '1.000 €', phaseLabel: 'Angenommen', offerId: 'offer-4' },
        jobId: 'job-4',
        paymentState: null,
        documentType: 'binding_offer',
        persistenceStatus: 'confirmed',
        createdAt: Date.now(),
      }

      const html = renderQuoteCard(artifact, true)

      // Badge uses muted styling
      expect(html).toContain('text-slate-500')
      expect(html).not.toContain('text-emerald-700')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. offerFundingSuperseded FLAG CORRECTNESS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. offerFundingSuperseded flag propagates correctly', () => {
    it('is true when funding is funded for same jobId', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-2a',
        jobId: 'job-35-2a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-35-2a')

      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('is true when funding is in active CTA phase', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-2b',
        jobId: 'job-35-2b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-35-2b')

      // Active CTA funding supersedes offer from persistent context
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('is false when funding is in terminal failure', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-2c',
        jobId: 'job-35-2c',
        fundingPhase: 'funding_failed',
      })

      const artifacts = getThreadArtifacts('conv-35-2c')

      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('is false when jobIds differ', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-2d',
        jobId: 'job-35-2d-offer',
        fundingPhase: 'funded',
        fundingJobId: 'job-35-2d-funding',
      })

      const artifacts = getThreadArtifacts('conv-35-2d')

      expect(artifacts.offerFundingSuperseded).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. EXACTLY ONE PRIMARY ACTIVE STATE PER CONTEXT
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. One primary active state per canonical context', () => {
    it('funded: funding card is the only active persistent context card', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-4a',
        jobId: 'job-35-4a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-35-4a')

      // Funding is primary active
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      // Offer is superseded (not shown in persistent context)
      expect(artifacts.offerFundingSuperseded).toBe(true)
      // Offer phase is reconciled to accepted (not payment_due)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('active CTA: funding card is primary, offer is superseded', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-4b',
        jobId: 'job-35-4b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-35-4b')

      // Funding is the active CTA
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      // Offer is superseded (hidden from persistent context) and downgraded to accepted
      expect(artifacts.offerFundingSuperseded).toBe(true)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. TERMINAL FAILURE BEHAVIOR PRESERVED
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. Terminal failure behavior', () => {
    // Retryable: the same request can still be paid → offer stays payment_due.
    const retryablePhases = ['funding_failed'] as const
    // Terminal-dead: request can never be paid → offer downgrades to accepted.
    const terminalDeadPhases = ['cancelled', 'expired'] as const

    for (const phase of retryablePhases) {
      it(`offer retains payment_due when funding is ${phase} (retryable)`, () => {
        setupConversationWithOfferAndFunding({
          convId: `conv-35-5-${phase}`,
          jobId: `job-35-5-${phase}`,
          fundingPhase: phase,
        })

        const artifacts = getThreadArtifacts(`conv-35-5-${phase}`)

        // Offer stays active with payment_due
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        // Not superseded
        expect(artifacts.offerFundingSuperseded).toBe(false)
      })
    }

    for (const phase of terminalDeadPhases) {
      it(`offer downgrades to accepted when funding is ${phase} (terminal-dead)`, () => {
        setupConversationWithOfferAndFunding({
          convId: `conv-35-5-${phase}`,
          jobId: `job-35-5-${phase}`,
          fundingPhase: phase,
        })

        const artifacts = getThreadArtifacts(`conv-35-5-${phase}`)

        // Dead request can never be paid — offer must not stay payable
        expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
        // Not superseded: funding card carries the dead state with no CTA
        expect(artifacts.offerFundingSuperseded).toBe(false)
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SAFE CONTEXT SCOPING — different contexts remain independent
  // ═══════════════════════════════════════════════════════════════════════════

  describe('6. Safe context scoping by jobId', () => {
    it('funded context A does not suppress pending context B (different jobIds)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-6a',
        jobId: 'job-35-6a-offer',
        fundingPhase: 'funded',
        fundingJobId: 'job-35-6a-funding',
      })

      const artifacts = getThreadArtifacts('conv-35-6a')

      // Different jobIds: offer retains its own state
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerFundingSuperseded).toBe(false)
      // Funding shows its own state
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION TO BLOCK 3 RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('7. No regression to Block 3 offer/funding reconciliation', () => {
    it('offer phase downgraded from payment_due to accepted when funding is funded', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-7a',
        jobId: 'job-35-7a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-35-7a')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer phase downgraded when funding is sent (active CTA)', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-7b',
        jobId: 'job-35-7b',
        fundingPhase: 'sent',
      })

      const artifacts = getThreadArtifacts('conv-35-7b')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('empty thread returns clean defaults', () => {
      const conv = makeConversation('conv-35-7c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository())

      const artifacts = getThreadArtifacts('conv-35-7c')

      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. TIMESTAMP ORDERING PRESERVED
  // ═══════════════════════════════════════════════════════════════════════════

  describe('8. Timeline ordering correctness', () => {
    it('offer artifact is always chronologically before funding artifact', () => {
      setupConversationWithOfferAndFunding({
        convId: 'conv-35-8a',
        jobId: 'job-35-8a',
        fundingPhase: 'funded',
      })

      const artifacts = getThreadArtifacts('conv-35-8a')

      // Offer was created before funding
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThan(
        artifacts.fundingStepArtifact!.createdAt
      )
    })
  })
})
