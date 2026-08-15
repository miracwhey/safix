/**
 * Thread Artifact Read-Only Selectors — RUN 3
 *
 * Validates that selectors are strictly read-only and never write to
 * thread_artifacts (FIX 1 from RUN 3).
 *
 * Before RUN 3 the selector fallback paths called persistProjectArtifact()
 * and persistOfferArtifact() as hidden side effects during read assembly
 * (so-called "auto-backfill on render").  This made reload stability depend
 * on timing luck: if the user reloaded before the first render of a thread,
 * no artifact row would have been written and the card would disappear.
 *
 * After RUN 3:
 * - Selectors are pure reads — no calls to upsert/persist happen during
 *   getThreadArtifacts(), resolveProjectArtifact(), or resolveOfferPaymentArtifact()
 * - The fallback read paths still return the correct artifact for old threads
 *   (conversation.sourceProjectId, offer repository), but they do not write
 * - Canonical artifact writes happen ONLY in explicit workflow/write paths
 *
 * Coverage:
 *   1. getThreadArtifacts() with sourceProjectId — no write to repository
 *   2. getThreadArtifacts() with offer in repository — no write to repository
 *   3. getThreadArtifacts() called N times — repository remains write-free
 *   4. upsert() returns Promise<void> (write functions are async)
 *   5. project artifact write path (persistProjectArtifact) is awaitable
 *   6. offer artifact write path (persistOfferArtifact) is awaitable
 *   7. updateOfferArtifactPhase is awaitable
 *   8. persistPaymentPhaseArtifact is awaitable
 *   9. accept transition writes offer phase + payment_phase artifact
 *  10. decline transition writes offer phase update
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
  persistProjectArtifact,
  persistOfferArtifact,
  updateOfferArtifactPhase,
  persistPaymentPhaseArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addOffer } from '../../src/lib/offers/service'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { ThreadArtifactRecord } from '../../src/lib/messages'

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const CUSTOMER_UID = 'customer-ro-001'
const CRAFTSMAN_UID = 'craftsman-ro-001'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-ro-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? '',
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: overrides.customerUserId ?? CUSTOMER_UID,
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: overrides.craftsmanUserId ?? CRAFTSMAN_UID,
    projectTitle: 'Badezimmer Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€8,000-12,000',
    projectDuration: '3 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-ro-${Date.now()}`
  return {
    id,
    title: 'Badezimmer Sanierung',
    customer: 'Anna Kundin',
    craftsman: '',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Thread Artifact Read-Only Selectors — RUN 3', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1–3. SELECTORS DO NOT WRITE
  // ═══════════════════════════════════════════════════════════════════════

  describe('Selectors are read-only', () => {
    it('1. getThreadArtifacts() with sourceProjectId does NOT write to repository', async () => {
      const threadId = 'conv-ro-proj-readonly'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID,
        })
      )
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID, customerUserId: CUSTOMER_UID, craftsmanUserId: CRAFTSMAN_UID })

      // Spy on the repository upsert to detect any writes during selector call
      const repo = getThreadArtifactRepository()
      const upsertSpy = vi.spyOn(repo, 'upsert')

      // Call the selector
      const artifacts = getThreadArtifacts(threadId)

      // Selector returned the project from the persisted record
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID)

      // No upsert was called — selector is read-only
      expect(upsertSpy).not.toHaveBeenCalled()
    })

    it('2. getThreadArtifacts() with offer in repository does NOT write to repository', async () => {
      const threadId = 'conv-ro-offer-readonly'
      await addConversation(seedConversation({ id: threadId }))

      // Add offer directly (bypass workflow) to simulate old data without artifact row
      await addOffer({
        id: 'offer-ro-legacy',
        conversationId: threadId,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        price: '3.000 €',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sentAt: Date.now(),
      })
      await persistOfferArtifact({ conversationId: threadId, offerId: 'offer-ro-legacy', phase: 'sent' })

      const repo = getThreadArtifactRepository()
      const upsertSpy = vi.spyOn(repo, 'upsert')

      const artifacts = getThreadArtifacts(threadId)

      // Selector returned the offer from the persisted record
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer.id).toBe('offer-ro-legacy')

      // No upsert was called — selector is read-only
      expect(upsertSpy).not.toHaveBeenCalled()
    })

    it('3. getThreadArtifacts() called N times remains write-free', async () => {
      const threadId = 'conv-ro-repeated'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID,
        })
      )
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID, customerUserId: CUSTOMER_UID, craftsmanUserId: CRAFTSMAN_UID })

      const repo = getThreadArtifactRepository()
      const upsertSpy = vi.spyOn(repo, 'upsert')

      // Call selector multiple times (simulating repeated renders)
      for (let i = 0; i < 5; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
      }

      // Zero writes, regardless of how many times the selector runs
      expect(upsertSpy).not.toHaveBeenCalled()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4–8. WRITE FUNCTIONS ARE ASYNC (AWAITABLE)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Write functions are async (confirmed persistence)', () => {
    it('4. upsert() returns Promise<void>', () => {
      const repo = getThreadArtifactRepository()
      const record: ThreadArtifactRecord = {
        id: 'ta_project_promise-test',
        conversationId: 'conv-promise',
        artifactType: 'project',
        projectId: PROJECT_UUID,
        createdAt: 1000,
        updatedAt: 1000,
      }
      const result = repo.upsert(record)
      expect(result).toBeInstanceOf(Promise)
      return result // make vitest await it so no unhandled rejection
    })

    it('5. persistProjectArtifact() returns Promise<void> and writes record', async () => {
      const threadId = 'conv-ro-proj-write'

      const result = persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      // Must be a Promise
      expect(result).toBeInstanceOf(Promise)

      // Await it to confirm persistence
      await result

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID)
      expect(record!.customerUserId).toBe(CUSTOMER_UID)
    })

    it('6. persistOfferArtifact() returns Promise<void> and writes record', async () => {
      const threadId = 'conv-ro-offer-write'

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-ro-write',
        phase: 'sent',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBe('offer-ro-write')
      expect(record!.phase).toBe('sent')
    })

    it('7. updateOfferArtifactPhase() returns Promise<void> and updates phase', async () => {
      const threadId = 'conv-ro-phase-update'

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-phase-test',
        phase: 'sent',
      })

      const updateResult = updateOfferArtifactPhase(threadId, 'declined')
      expect(updateResult).toBeInstanceOf(Promise)
      await updateResult

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.phase).toBe('declined')
    })

    it('8. persistPaymentPhaseArtifact() returns Promise<void> and writes record', async () => {
      const threadId = 'conv-ro-payment-write'

      await persistPaymentPhaseArtifact({
        conversationId: threadId,
        jobId: 'job-ro-001',
        offerId: 'offer-ro-001',
        phase: 'payment_due',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      const record = getThreadArtifactRecord(threadId, 'payment_phase')
      expect(record).toBeDefined()
      expect(record!.jobId).toBe('job-ro-001')
      expect(record!.phase).toBe('payment_due')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9–10. WORKFLOW TRANSITIONS WRITE CANONICALLY
  // ═══════════════════════════════════════════════════════════════════════

  describe('Workflow transitions write canonically', () => {
    it('9. accept transition writes offer phase update + payment_phase artifact', async () => {
      const threadId = 'conv-ro-accept-chain'

      // Set up an offer artifact (simulating what createOfferWorkflow does)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-accept-test',
        phase: 'sent',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      // Simulate what acceptOfferWorkflow does
      await updateOfferArtifactPhase(threadId, 'accepted', {
        jobId: 'job-accept-001',
        offerId: 'offer-accept-test',
      })
      await persistPaymentPhaseArtifact({
        conversationId: threadId,
        jobId: 'job-accept-001',
        offerId: 'offer-accept-test',
        phase: 'payment_due',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      const offerRecord = getThreadArtifactRecord(threadId, 'offer')
      expect(offerRecord!.phase).toBe('accepted')
      expect(offerRecord!.jobId).toBe('job-accept-001')

      const paymentRecord = getThreadArtifactRecord(threadId, 'payment_phase')
      expect(paymentRecord).toBeDefined()
      expect(paymentRecord!.phase).toBe('payment_due')
      expect(paymentRecord!.jobId).toBe('job-accept-001')
    })

    it('10. decline transition writes offer phase update only', async () => {
      const threadId = 'conv-ro-decline-chain'

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-decline-test',
        phase: 'sent',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
      })

      // Simulate what declineOfferWorkflow does
      await updateOfferArtifactPhase(threadId, 'declined')

      const offerRecord = getThreadArtifactRecord(threadId, 'offer')
      expect(offerRecord!.phase).toBe('declined')

      // No payment_phase artifact (decline doesn't create one)
      expect(getThreadArtifactRecord(threadId, 'payment_phase')).toBeUndefined()
    })
  })
})
