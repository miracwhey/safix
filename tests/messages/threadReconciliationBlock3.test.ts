/**
 * Thread Reconciliation Block 3 — Comprehensive Tests
 *
 * Validates the complete thread/chat reconciliation contract:
 *
 * 1. For one business context, only one primary active thread truth remains
 * 2. Superseded offer/KV/funding surfaces become passive or suppressed
 * 3. Historical thread surfaces do not compete with current active state
 * 4. Thread ordering/priority reflects current workflow truth
 * 5. Job/project detail surfaces resolve the real conversation when it exists
 * 6. False "no messages" / empty conversation states are eliminated
 * 7. Unrelated contexts in the same conversation/thread are not wrongly suppressed
 * 8. No regression to Blocks 1–2.1
 * 9. Build/lint/tests all pass
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import {
  getConversationMessagesForJob,
  getConversationLinkageStatus,
  getProjectConversationMessageCount,
} from '../../src/lib/workflow/messageWorkflow'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Conversation, Message } from '../../src/lib/messages/types'
import type { Job } from '../../src/lib/jobs/types'
import { FUNDING_ACTIVE_CTA_PHASES } from '../../src/lib/messages/threadArtifactTypes'

// ── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0
function generateId(): string {
  return `test-id-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`
}

function makeConversation(
  id: string,
  overrides: Partial<Conversation> = {}
): Conversation {
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
    projectTitle: 'Block 3 Reconciliation Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    messages: [],
    ...overrides,
  } as unknown as Conversation
}

function makeMessage(conversationId: string, text: string, sentAt?: number): Message {
  return {
    id: generateId(),
    conversationId,
    sender: 'user',
    text,
    createdAtLabel: 'Jetzt',
    sentAt: sentAt ?? Date.now(),
  } as unknown as Message
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    title: 'Test Auftrag',
    status: 'accepted',
    projectId: `project-${id}`,
    sourceConversationId: undefined,
    sourceOfferId: undefined,
    ...overrides,
  } as unknown as Job
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Thread Reconciliation — Block 3', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 0
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. ONE PRIMARY ACTIVE THREAD TRUTH per business context
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. One primary active truth per context', () => {
    it('funded: only funding card is active, offer is fully superseded', () => {
      const conv = makeConversation('conv-r1a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1a',
        artifactType: 'offer',
        offerId: 'offer-r1a',
        jobId: 'job-r1a',
        phase: 'payment_due',
        snapshotPrice: '2.500 €',
        createdAt: Date.now() - 5000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1a',
        artifactType: 'funding_step',
        jobId: 'job-r1a',
        fundingRequestId: 'fr-r1a',
        escrowPlanId: 'ep-r1a',
        phase: 'funded',
        snapshotPrice: '2.500 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r1a')

      // Only ONE primary active truth: the funded funding card
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
      // Offer is superseded — not shown in persistent context
      expect(artifacts.offerFundingSuperseded).toBe(true)
      // Offer phase is reconciled to accepted (historical, not payment_due)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('active CTA: only funding CTA is the persistent active surface', () => {
      const conv = makeConversation('conv-r1b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1b',
        artifactType: 'offer',
        offerId: 'offer-r1b',
        jobId: 'job-r1b',
        phase: 'payment_due',
        snapshotPrice: '1.800 €',
        createdAt: Date.now() - 3000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1b',
        artifactType: 'funding_step',
        jobId: 'job-r1b',
        fundingRequestId: 'fr-r1b',
        escrowPlanId: 'ep-r1b',
        phase: 'sent',
        snapshotPrice: '1.800 €',
        createdAt: Date.now() - 500,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r1b')

      // Funding is the active CTA
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      // Offer is superseded from persistent context
      expect(artifacts.offerFundingSuperseded).toBe(true)
      // Offer phase reconciled to accepted (not competing as payment CTA)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('terminal failure: offer retains active status, not superseded', () => {
      const conv = makeConversation('conv-r1c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1c',
        artifactType: 'offer',
        offerId: 'offer-r1c',
        jobId: 'job-r1c',
        phase: 'payment_due',
        snapshotPrice: '3.000 €',
        createdAt: Date.now() - 5000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r1c',
        artifactType: 'funding_step',
        jobId: 'job-r1c',
        fundingRequestId: 'fr-r1c',
        escrowPlanId: 'ep-r1c',
        phase: 'funding_failed',
        snapshotPrice: '3.000 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r1c')

      // Offer is NOT superseded — it is the active payment surface again
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      // Funding card still shows failure state
      expect(artifacts.fundingStepArtifact!.phase).toBe('funding_failed')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. SUPERSEDED SURFACES become passive correctly
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. Superseded surfaces become passive', () => {
    for (const phase of ['sent', 'funding_started', 'funding_initiated', 'funded'] as const) {
      it(`offer is superseded when funding is '${phase}' for same jobId`, () => {
        const conv = makeConversation(`conv-r2-${phase}`)
        setMessageRepository(new InMemoryMessageRepository([conv], []))

        const artifactRepo = new InMemoryThreadArtifactRepository()
        artifactRepo.upsert({
          id: generateId(),
          conversationId: `conv-r2-${phase}`,
          artifactType: 'offer',
          offerId: `offer-r2-${phase}`,
          jobId: 'job-r2',
          phase: 'payment_due',
          snapshotPrice: '1.000 €',
          createdAt: Date.now() - 2000,
        })
        artifactRepo.upsert({
          id: generateId(),
          conversationId: `conv-r2-${phase}`,
          artifactType: 'funding_step',
          jobId: 'job-r2',
          fundingRequestId: `fr-r2-${phase}`,
          escrowPlanId: `ep-r2-${phase}`,
          phase,
          snapshotPrice: '1.000 €',
          createdAt: Date.now() - 500,
        })
        setThreadArtifactRepository(artifactRepo)

        const artifacts = getThreadArtifacts(`conv-r2-${phase}`)

        expect(artifacts.offerFundingSuperseded).toBe(true)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      })
    }

    // Retryable failure: the SAME request can still be paid, so the offer
    // remains the active payment surface ('payment_due'), not superseded.
    it(`offer retains payment_due when funding is 'funding_failed' (retryable)`, () => {
      const conv = makeConversation('conv-r2f-funding_failed')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r2f-funding_failed',
        artifactType: 'offer',
        offerId: 'offer-r2f-funding_failed',
        jobId: 'job-r2f',
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        createdAt: Date.now() - 2000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r2f-funding_failed',
        artifactType: 'funding_step',
        jobId: 'job-r2f',
        fundingRequestId: 'fr-r2f-funding_failed',
        escrowPlanId: 'ep-r2f-funding_failed',
        phase: 'funding_failed',
        snapshotPrice: '1.000 €',
        createdAt: Date.now() - 500,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r2f-funding_failed')

      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    })

    // Terminal-dead failure: the request can NEVER be paid (a pay attempt
    // 409s), so the offer must NOT remain payable — it downgrades to
    // 'accepted' (passive). Still not superseded: the funding card carries
    // the dead state with no CTA. Mirrors the customer/HW twin selectors.
    for (const phase of ['cancelled', 'expired'] as const) {
      it(`offer downgrades to accepted when funding is '${phase}' (terminal-dead)`, () => {
        const conv = makeConversation(`conv-r2f-${phase}`)
        setMessageRepository(new InMemoryMessageRepository([conv], []))

        const artifactRepo = new InMemoryThreadArtifactRepository()
        artifactRepo.upsert({
          id: generateId(),
          conversationId: `conv-r2f-${phase}`,
          artifactType: 'offer',
          offerId: `offer-r2f-${phase}`,
          jobId: 'job-r2f',
          phase: 'payment_due',
          snapshotPrice: '1.000 €',
          createdAt: Date.now() - 2000,
        })
        artifactRepo.upsert({
          id: generateId(),
          conversationId: `conv-r2f-${phase}`,
          artifactType: 'funding_step',
          jobId: 'job-r2f',
          fundingRequestId: `fr-r2f-${phase}`,
          escrowPlanId: `ep-r2f-${phase}`,
          phase,
          snapshotPrice: '1.000 €',
          createdAt: Date.now() - 500,
        })
        setThreadArtifactRepository(artifactRepo)

        const artifacts = getThreadArtifacts(`conv-r2f-${phase}`)

        // Funding card carries the dead state — offer not suppressed from context
        expect(artifacts.offerFundingSuperseded).toBe(false)
        // Offer must NOT be presented as payable
        expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
        expect(artifacts.offerPaymentArtifact!.phase).not.toBe('payment_due')
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. HISTORICAL SURFACES do not compete with current active state
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. Historical surfaces are passive', () => {
    it('offer phase is always accepted (never payment_due) when funding is active or funded', () => {
      const conv = makeConversation('conv-r3a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r3a',
        artifactType: 'offer',
        offerId: 'offer-r3a',
        jobId: 'job-r3a',
        phase: 'payment_due',
        snapshotPrice: '5.000 €',
        createdAt: Date.now() - 10000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r3a',
        artifactType: 'funding_step',
        jobId: 'job-r3a',
        fundingRequestId: 'fr-r3a',
        escrowPlanId: 'ep-r3a',
        phase: 'funding_initiated',
        snapshotPrice: '5.000 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r3a')

      // The offer card never says 'payment_due' when a stronger surface exists
      expect(artifacts.offerPaymentArtifact!.phase).not.toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('offer data is preserved even when superseded (for timeline rendering)', () => {
      const conv = makeConversation('conv-r3b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r3b',
        artifactType: 'offer',
        offerId: 'offer-r3b',
        jobId: 'job-r3b',
        phase: 'payment_due',
        snapshotPrice: '7.500 €',
        snapshotSummary: 'Badezimmer komplett',
        createdAt: Date.now() - 8000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r3b',
        artifactType: 'funding_step',
        jobId: 'job-r3b',
        fundingRequestId: 'fr-r3b',
        escrowPlanId: 'ep-r3b',
        phase: 'funded',
        snapshotPrice: '7.500 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r3b')

      // Offer is superseded but data is preserved for timeline event rendering
      expect(artifacts.offerFundingSuperseded).toBe(true)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot?.price).toBe('7.500 €')
      expect(artifacts.offerPaymentArtifact!.snapshot?.summary).toBe('Badezimmer komplett')
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThan(
        artifacts.fundingStepArtifact!.createdAt
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. THREAD ORDERING reflects current workflow truth
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. Thread ordering correctness', () => {
    it('offer is chronologically before funding (preserves history)', () => {
      const offerTime = Date.now() - 10000
      const fundingTime = Date.now() - 2000

      const conv = makeConversation('conv-r4a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r4a',
        artifactType: 'offer',
        offerId: 'offer-r4a',
        jobId: 'job-r4a',
        phase: 'payment_due',
        snapshotPrice: '1.000 €',
        createdAt: offerTime,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r4a',
        artifactType: 'funding_step',
        jobId: 'job-r4a',
        fundingRequestId: 'fr-r4a',
        escrowPlanId: 'ep-r4a',
        phase: 'funded',
        snapshotPrice: '1.000 €',
        createdAt: fundingTime,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r4a')

      expect(artifacts.offerPaymentArtifact!.createdAt).toBe(offerTime)
      expect(artifacts.fundingStepArtifact!.createdAt).toBe(fundingTime)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThan(
        artifacts.fundingStepArtifact!.createdAt
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. CONVERSATION LINKAGE — job/project detail resolves real conversation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. Conversation linkage resolves real conversations', () => {
    it('getConversationMessagesForJob returns messages when sourceConversationId is set', () => {
      const conv = makeConversation('conv-r5a', {
        sourceProjectId: 'project-r5a',
      })
      const msg1 = makeMessage('conv-r5a', 'Hallo, ich brauche Hilfe', Date.now() - 5000)
      const msg2 = makeMessage('conv-r5a', 'Klar, wann passt es?', Date.now() - 3000)
      setMessageRepository(new InMemoryMessageRepository([conv], [msg1, msg2]))

      const job = makeJob('job-r5a', {
        sourceConversationId: 'conv-r5a',
        projectId: 'project-r5a',
      })
      setJobRepository(new InMemoryJobRepository([job]))

      const messages = getConversationMessagesForJob('job-r5a')

      expect(messages.length).toBe(2)
      expect(messages[0].text).toBe('Hallo, ich brauche Hilfe')
      expect(messages[1].text).toBe('Klar, wann passt es?')
    })

    it('getConversationMessagesForJob returns messages via projectId fallback', () => {
      const conv = makeConversation('conv-r5b', {
        projectId: 'project-r5b',
        sourceProjectId: 'project-r5b',
      })
      const msg = makeMessage('conv-r5b', 'Projekt angehängt', Date.now())
      setMessageRepository(new InMemoryMessageRepository([conv], [msg]))

      // Legacy job without sourceConversationId
      const job = makeJob('job-r5b', {
        projectId: 'project-r5b',
      })
      setJobRepository(new InMemoryJobRepository([job]))

      const messages = getConversationMessagesForJob('job-r5b')

      expect(messages.length).toBe(1)
      expect(messages[0].text).toBe('Projekt angehängt')
    })

    it('getConversationMessagesForJob returns empty array when job not found', () => {
      setJobRepository(new InMemoryJobRepository([]))
      const messages = getConversationMessagesForJob('nonexistent-job')
      expect(messages).toEqual([])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. FALSE EMPTY STATES eliminated via linkage status
  // ═══════════════════════════════════════════════════════════════════════════

  describe('6. False empty conversation states eliminated', () => {
    it('getConversationLinkageStatus returns linked when conversation exists', () => {
      const conv = makeConversation('conv-r6a')
      const msg = makeMessage('conv-r6a', 'Hallo!', Date.now())
      setMessageRepository(new InMemoryMessageRepository([conv], [msg]))

      const job = makeJob('job-r6a', {
        sourceConversationId: 'conv-r6a',
      })
      setJobRepository(new InMemoryJobRepository([job]))

      const status = getConversationLinkageStatus('job-r6a')
      expect(status).toBe('linked')
    })

    it('getConversationLinkageStatus returns not_linked when repos hydrated but no match', () => {
      setMessageRepository(new InMemoryMessageRepository([], []))
      const job = makeJob('job-r6b', {
        sourceConversationId: 'nonexistent-conv',
      })
      setJobRepository(new InMemoryJobRepository([job]))

      const status = getConversationLinkageStatus('job-r6b')
      // InMemory repos are always hydrated, so this is deterministic
      expect(status).toBe('not_linked')
    })

    it('getConversationLinkageStatus returns not_linked when job not found and repos hydrated', () => {
      setJobRepository(new InMemoryJobRepository([]))
      // InMemory repos are always hydrated
      const status = getConversationLinkageStatus('nonexistent-job')
      expect(status).toBe('not_linked')
    })

    it('getProjectConversationMessageCount returns correct count via sourceConversationId', () => {
      const conv = makeConversation('conv-r6d')
      const msg1 = makeMessage('conv-r6d', 'Msg 1', Date.now() - 2000)
      const msg2 = makeMessage('conv-r6d', 'Msg 2', Date.now() - 1000)
      const msg3 = makeMessage('conv-r6d', 'Msg 3', Date.now())
      setMessageRepository(new InMemoryMessageRepository([conv], [msg1, msg2, msg3]))

      const count = getProjectConversationMessageCount('project-r6d', 0, 'conv-r6d')
      expect(count).toBe(3)
    })

    it('getProjectConversationMessageCount returns fallback when no conversation found', () => {
      setMessageRepository(new InMemoryMessageRepository([], []))

      const count = getProjectConversationMessageCount('nonexistent-project', 5)
      expect(count).toBe(5) // falls back to denormalized count
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. UNRELATED CONTEXTS are not wrongly suppressed
  // ═══════════════════════════════════════════════════════════════════════════

  describe('7. Unrelated contexts not cross-suppressed', () => {
    it('offer for jobA is NOT superseded by funding for jobB', () => {
      const conv = makeConversation('conv-r7a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r7a',
        artifactType: 'offer',
        offerId: 'offer-r7a',
        jobId: 'job-r7a-alpha',
        phase: 'payment_due',
        snapshotPrice: '2.000 €',
        createdAt: Date.now() - 3000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r7a',
        artifactType: 'funding_step',
        jobId: 'job-r7a-beta', // DIFFERENT job!
        fundingRequestId: 'fr-r7a',
        escrowPlanId: 'ep-r7a',
        phase: 'funded',
        snapshotPrice: '3.000 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r7a')

      // Different jobIds → no cross-suppression
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('offer without jobId is not affected by any funding card', () => {
      const conv = makeConversation('conv-r7b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r7b',
        artifactType: 'offer',
        offerId: 'offer-r7b',
        // No jobId — pre-acceptance offer
        phase: 'sent',
        snapshotPrice: '500 €',
        createdAt: Date.now() - 3000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r7b',
        artifactType: 'funding_step',
        jobId: 'job-r7b',
        fundingRequestId: 'fr-r7b',
        escrowPlanId: 'ep-r7b',
        phase: 'funded',
        snapshotPrice: '500 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r7b')

      // No jobId on offer → cannot reconcile
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. NO REGRESSION to Blocks 1–2.1
  // ═══════════════════════════════════════════════════════════════════════════

  describe('8. No regression to prior blocks', () => {
    it('offer-only thread behaves unchanged', () => {
      const conv = makeConversation('conv-r8a')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r8a',
        artifactType: 'offer',
        offerId: 'offer-r8a',
        phase: 'sent',
        snapshotPrice: '800 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r8a')

      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('funding-only thread behaves unchanged', () => {
      const conv = makeConversation('conv-r8b')
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r8b',
        artifactType: 'funding_step',
        jobId: 'job-r8b',
        fundingRequestId: 'fr-r8b',
        escrowPlanId: 'ep-r8b',
        phase: 'sent',
        snapshotPrice: '1.500 €',
        createdAt: Date.now(),
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r8b')

      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('empty thread returns clean defaults', () => {
      const conv = makeConversation('conv-r8c')
      setMessageRepository(new InMemoryMessageRepository([conv], []))
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository())

      const artifacts = getThreadArtifacts('conv-r8c')

      expect(artifacts.projectArtifacts).toEqual([])
      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.fundingStepArtifact).toBeNull()
      expect(artifacts.offerFundingSuperseded).toBe(false)
      expect(artifacts.pendingProjectArtifact).toBe(false)
      expect(artifacts.pendingOfferArtifact).toBe(false)
      expect(artifacts.pendingFundingArtifact).toBe(false)
    })

    it('project artifacts are not affected by offer/funding reconciliation', () => {
      const conv = makeConversation('conv-r8d', { sourceProjectId: 'project-r8d' })
      setMessageRepository(new InMemoryMessageRepository([conv], []))

      const artifactRepo = new InMemoryThreadArtifactRepository()
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r8d',
        artifactType: 'project',
        projectId: 'project-r8d',
        snapshotTitle: 'Badezimmer Renovierung',
        snapshotStatus: 'request',
        createdAt: Date.now() - 10000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r8d',
        artifactType: 'offer',
        offerId: 'offer-r8d',
        jobId: 'job-r8d',
        phase: 'payment_due',
        snapshotPrice: '4.000 €',
        createdAt: Date.now() - 5000,
      })
      artifactRepo.upsert({
        id: generateId(),
        conversationId: 'conv-r8d',
        artifactType: 'funding_step',
        jobId: 'job-r8d',
        fundingRequestId: 'fr-r8d',
        escrowPlanId: 'ep-r8d',
        phase: 'funded',
        snapshotPrice: '4.000 €',
        createdAt: Date.now() - 1000,
      })
      setThreadArtifactRepository(artifactRepo)

      const artifacts = getThreadArtifacts('conv-r8d')

      // Project artifacts are completely unaffected
      expect(artifacts.projectArtifacts.length).toBe(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Badezimmer Renovierung')
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      // Offer/funding reconciliation works normally
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ACTIVE CTA PHASES exhaustive coverage
  // ═══════════════════════════════════════════════════════════════════════════

  describe('9. FUNDING_ACTIVE_CTA_PHASES set is correct', () => {
    it('contains exactly sent, funding_started, funding_initiated', () => {
      expect(FUNDING_ACTIVE_CTA_PHASES.has('sent')).toBe(true)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('funding_started')).toBe(true)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('funding_initiated')).toBe(true)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('funded')).toBe(false)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('funding_failed')).toBe(false)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('cancelled')).toBe(false)
      expect(FUNDING_ACTIVE_CTA_PHASES.has('expired')).toBe(false)
    })
  })
})
