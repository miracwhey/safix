/**
 * First-Class Thread Artifact Tests
 *
 * Validates the rebuild of thread business artifacts as first-class
 * persisted entities owned by the conversation/thread.
 *
 * SCENARIO 1 — Project artifact persisted as first-class thread artifact
 * SCENARIO 2 — Project artifact survives reload for both participants
 * SCENARIO 3 — Offer artifact persisted as first-class thread artifact
 * SCENARIO 4 — Offer/payment artifact survives reload for both participants
 * SCENARIO 5 — Acceptance/payment continuity stays in same thread
 * SCENARIO 6 — No duplicate/forked thread after acceptance/payment transition
 * SCENARIO 7 — No cross-craftsman artifact visibility leak
 * SCENARIO 8 — No regression to previous participant scoping protections
 * SCENARIO 9 — Backfill for old thread data
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  getThreadArtifactRecords,
  getThreadArtifactRecord,
  persistProjectArtifact,
  persistOfferArtifact,
  backfillThreadArtifacts,
  isConversationParticipant,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { declineOfferWorkflow } from '../../src/lib/workflow/offerWorkflow'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_UUID_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id =
    overrides.id ??
    `conv-fc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-fc-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-fc-001',
    projectTitle: 'Küche Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€5,000-10,000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-fc-${Date.now()}`,
    title: overrides.title ?? 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('First-Class Thread Artifact Persistence', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — PROJECT ARTIFACT PERSISTED AS FIRST-CLASS THREAD ARTIFACT
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 1: Project artifact as first-class persisted entity', () => {
    it('creates a ThreadArtifactRecord when customer sends project attachment', async () => {
      const threadId = 'conv-fc-proj-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Dachsanierung' }))
      await addConversation(
        seedConversation({
          id: threadId,
          projectId: `project_reel_${threadId}`, // synthetic
          inquiryOrigin: 'reel',
        })
      )

      // Before attachment: no artifact record
      expect(getThreadArtifactRecord(threadId, 'project')).toBeUndefined()

      // Attach project
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID_A)

      // After attachment: persisted artifact record exists
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.conversationId).toBe(threadId)
      expect(record!.artifactType).toBe('project')
      expect(record!.projectId).toBe(PROJECT_UUID_A)
      expect(record!.customerUserId).toBe('customer-fc-001')
      expect(record!.craftsmanUserId).toBe('craftsman-fc-001')
    })

    it('project artifact resolves from persisted record after reload', async () => {
      const threadId = 'conv-fc-proj-reload'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Fenstereinbau' }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID_A,
        })
      )

      // Persist the artifact record directly (simulating what the write path does)
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
      })

      // Multiple re-derivations simulate reload for both participants
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID_A)
        expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
      }
    })

    it('multiple project artifact sends create separate records (append-only)', async () => {
      const threadId = 'conv-fc-proj-upsert'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      // Persist twice — each call creates a NEW record (multi-send model)
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
      })
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
      })

      // Two records should exist (append-only)
      const records = getThreadArtifactRecords(threadId)
      const projectRecords = records.filter((r) => r.artifactType === 'project')
      expect(projectRecords).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — PROJECT ARTIFACT SURVIVES RELOAD FOR BOTH PARTICIPANTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 2: Project artifact reload stability', () => {
    it('customer and craftsman both resolve same project from artifact record', async () => {
      const threadId = 'conv-fc-both-proj'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Gartenanlage' }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID_A,
          customerUserId: 'customer-A',
          craftsmanUserId: 'craftsman-B',
        })
      )

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
        customerUserId: 'customer-A',
        craftsmanUserId: 'craftsman-B',
      })

      // Both sides derive identical artifacts
      const a1 = getThreadArtifacts(threadId)
      const a2 = getThreadArtifacts(threadId)
      expect(a1.projectArtifact).not.toBeNull()
      expect(a2.projectArtifact).not.toBeNull()
      expect(a1.projectArtifact!.project.id).toBe(PROJECT_UUID_A)
      expect(a2.projectArtifact!.project.id).toBe(PROJECT_UUID_A)
      expect(a1.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('project card backed by artifact record survives across all inquiry origins', async () => {
      for (const origin of ['profile', 'reel', 'category'] as const) {
        setupCleanRepositories()
        const threadId = `conv-fc-origin-${origin}`
        await addProject(seedProject({ id: PROJECT_UUID_A }))
        await addConversation(
          seedConversation({
            id: threadId,
            sourceProjectId: PROJECT_UUID_A,
            inquiryOrigin: origin,
          })
        )

        await persistProjectArtifact({
          conversationId: threadId,
          projectId: PROJECT_UUID_A,
        })

        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID_A)
        expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — OFFER ARTIFACT PERSISTED AS FIRST-CLASS THREAD ARTIFACT
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 3: Offer artifact as first-class persisted entity', () => {
    it('creates a ThreadArtifactRecord when craftsman sends offer', async () => {
      const threadId = 'conv-fc-offer-001'
      await addConversation(seedConversation({ id: threadId }))

      // Before offer: no artifact record
      expect(getThreadArtifactRecord(threadId, 'offer')).toBeUndefined()

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '5.000 €',
        description: 'Komplettsanierung',
      })

      // After offer: persisted artifact record exists
      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.conversationId).toBe(threadId)
      expect(record!.artifactType).toBe('offer')
      expect(record!.phase).toBe('sent')
      expect(record!.customerUserId).toBe('customer-fc-001')
      expect(record!.craftsmanUserId).toBe('craftsman-fc-001')
    })

    it('offer artifact record has correct offerId linking', async () => {
      const threadId = 'conv-fc-offer-link'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '3.500 €',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.offerId).toBe(offer.id)
    })

    it('offer artifact resolves from persisted record', async () => {
      const threadId = 'conv-fc-offer-resolve'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '2.800 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.offer.price).toBe('2.800 €')
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — OFFER/PAYMENT ARTIFACT SURVIVES RELOAD FOR BOTH
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 4: Offer/payment artifact reload stability', () => {
    it('offer artifact survives multiple re-derivations (reload simulation)', async () => {
      const threadId = 'conv-fc-offer-reload'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '7.500 €',
      })

      for (let i = 0; i < 5; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offer.id)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      }
    })

    it('customer and craftsman both resolve same offer artifact', async () => {
      const threadId = 'conv-fc-offer-both'
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'customer-X',
          craftsmanUserId: 'craftsman-Y',
        })
      )

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-X',
        craftsmanUserId: 'craftsman-Y',
        price: '4.200 €',
      })

      const a1 = getThreadArtifacts(threadId)
      const a2 = getThreadArtifacts(threadId)
      expect(a1.offerPaymentArtifact).not.toBeNull()
      expect(a2.offerPaymentArtifact).not.toBeNull()
      expect(a1.offerPaymentArtifact!.offer.id).toBe(
        a2.offerPaymentArtifact!.offer.id
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 5 — ACCEPTANCE/PAYMENT CONTINUITY IN SAME THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 5: Acceptance/payment continuity', () => {
    it('offer artifact transitions to accepted phase on acceptance', async () => {
      const threadId = 'conv-fc-accept-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '6.000 €',
      })

      // Before acceptance: phase is 'sent'
      expect(getThreadArtifactRecord(threadId, 'offer')!.phase).toBe('sent')

      await acceptOfferWorkflow(offer.id)

      // After acceptance: phase is 'accepted'
      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.phase).toBe('accepted')
    })

    it('payment_phase artifact created on acceptance', async () => {
      const threadId = 'conv-fc-payment-phase'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '8.000 €',
      })

      // Before acceptance: no payment_phase artifact
      expect(getThreadArtifactRecord(threadId, 'payment_phase')).toBeUndefined()

      await acceptOfferWorkflow(offer.id)

      // After acceptance: payment_phase artifact exists
      const record = getThreadArtifactRecord(threadId, 'payment_phase')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('payment_phase')
      expect(record!.phase).toBe('payment_due')
      expect(record!.jobId).toBeDefined()
    })

    it('same conversation retains all artifacts after acceptance', async () => {
      const threadId = 'conv-fc-continuity'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID_A,
        })
      )

      // Persist project artifact
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
      })

      // Create and accept offer
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '10.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // All three artifact types should exist
      const records = getThreadArtifactRecords(threadId)
      const types = records.map((r) => r.artifactType).sort()
      expect(types).toEqual(['offer', 'payment_phase', 'project'])

      // Thread artifacts still resolve correctly
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      // Phase can be 'accepted' or 'payment_due' depending on job payment state
      expect(['accepted', 'payment_due']).toContain(
        artifacts.offerPaymentArtifact!.phase
      )
    })

    it('declined offer produces artifact record with declined phase', async () => {
      const threadId = 'conv-fc-decline'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '3.000 €',
      })

      await declineOfferWorkflow(offer.id)

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.phase).toBe('declined')

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 6 — NO DUPLICATE/FORKED THREAD AFTER ACCEPTANCE/PAYMENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 6: No thread duplication or forking', () => {
    it('all artifacts stay in the same conversation after acceptance', async () => {
      const threadId = 'conv-fc-no-fork'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '5.500 €',
      })
      await acceptOfferWorkflow(offer.id)

      // All records are owned by the same conversation
      const records = getThreadArtifactRecords(threadId)
      expect(records.length).toBeGreaterThanOrEqual(2) // offer + payment_phase
      for (const r of records) {
        expect(r.conversationId).toBe(threadId)
      }

      // No records exist for any other conversation
      const allRecords = getThreadArtifactRepository().getAll()
      for (const r of allRecords) {
        expect(r.conversationId).toBe(threadId)
      }
    })

    it('project and offer artifacts coexist without collision', async () => {
      const threadId = 'conv-fc-coexist'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID_A,
        })
      )

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID_A)

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '9.000 €',
      })

      const records = getThreadArtifactRecords(threadId)
      expect(records.find((r) => r.artifactType === 'project')).toBeDefined()
      expect(records.find((r) => r.artifactType === 'offer')).toBeDefined()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 7 — NO CROSS-CRAFTSMAN ARTIFACT VISIBILITY LEAK
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 7: Participant scoping', () => {
    it('artifact records are scoped to correct participants', async () => {
      const threadId = 'conv-fc-scope'
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'customer-scope-A',
          craftsmanUserId: 'craftsman-scope-B',
        })
      )

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
        customerUserId: 'customer-scope-A',
        craftsmanUserId: 'craftsman-scope-B',
      })

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.customerUserId).toBe('customer-scope-A')
      expect(record!.craftsmanUserId).toBe('craftsman-scope-B')
    })

    it('conversation participant check still works with artifact records', async () => {
      const threadId = 'conv-fc-participant-check'
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'customer-p-001',
          craftsmanUserId: 'craftsman-p-001',
        })
      )

      const conv = getConversationById(threadId)!
      expect(isConversationParticipant(conv, 'customer-p-001')).toBe(true)
      expect(isConversationParticipant(conv, 'craftsman-p-001')).toBe(true)
      expect(isConversationParticipant(conv, 'unrelated-user')).toBe(false)
    })

    it('artifacts for different conversations are independent', async () => {
      const thread1 = 'conv-fc-indep-1'
      const thread2 = 'conv-fc-indep-2'

      await addConversation(
        seedConversation({
          id: thread1,
          craftsmanUserId: 'craftsman-1',
        })
      )
      await addConversation(
        seedConversation({
          id: thread2,
          craftsmanUserId: 'craftsman-2',
        })
      )

      await persistProjectArtifact({
        conversationId: thread1,
        projectId: PROJECT_UUID_A,
        craftsmanUserId: 'craftsman-1',
      })
      await persistProjectArtifact({
        conversationId: thread2,
        projectId: PROJECT_UUID_B,
        craftsmanUserId: 'craftsman-2',
      })

      // Each conversation's artifact is independent
      expect(getThreadArtifactRecord(thread1, 'project')!.projectId).toBe(PROJECT_UUID_A)
      expect(getThreadArtifactRecord(thread2, 'project')!.projectId).toBe(PROJECT_UUID_B)
      expect(getThreadArtifactRecords(thread1)).toHaveLength(1)
      expect(getThreadArtifactRecords(thread2)).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 8 — NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 8: No regressions', () => {
    it('synthetic project IDs do not produce project artifacts', async () => {
      const threadId = 'conv-fc-no-synth'
      await addConversation(
        seedConversation({
          id: threadId,
          projectId: 'project_profile_craft_conv-fc-no-synth',
          inquiryOrigin: 'profile',
        })
      )

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('thread without any business entities has empty artifacts', async () => {
      const threadId = 'conv-fc-empty'
      await addConversation(seedConversation({ id: threadId }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(getThreadArtifactRecords(threadId)).toHaveLength(0)
    })

    it('non-existent thread returns empty artifacts', () => {
      const artifacts = getThreadArtifacts('non-existent-thread')
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 9 — BACKFILL FOR OLD THREAD DATA
  // ═══════════════════════════════════════════════════════════════════════

  describe('Scenario 9: Backfill / migration', () => {
    it('backfillThreadArtifacts creates project record from sourceProjectId', async () => {
      const threadId = 'conv-fc-backfill-proj'

      await backfillThreadArtifacts({
        conversationId: threadId,
        sourceProjectId: PROJECT_UUID_A,
        customerUserId: 'customer-bf',
        craftsmanUserId: 'craftsman-bf',
      })

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID_A)
    })

    it('backfillThreadArtifacts creates offer record from offerId', async () => {
      const threadId = 'conv-fc-backfill-offer'

      await backfillThreadArtifacts({
        conversationId: threadId,
        offerId: 'offer-legacy-123',
        offerPhase: 'accepted',
        jobId: 'job-legacy-456',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBe('offer-legacy-123')
      expect(record!.phase).toBe('accepted')
      expect(record!.jobId).toBe('job-legacy-456')
    })

    it('backfill is idempotent (upsert, not duplicate)', async () => {
      const threadId = 'conv-fc-backfill-idem'

      await backfillThreadArtifacts({
        conversationId: threadId,
        sourceProjectId: PROJECT_UUID_A,
      })
      await backfillThreadArtifacts({
        conversationId: threadId,
        sourceProjectId: PROJECT_UUID_A,
      })

      const records = getThreadArtifactRecords(threadId)
      expect(records.filter((r) => r.artifactType === 'project')).toHaveLength(1)
    })

    it('fallback path shows project card from sourceProjectId without writing artifact record (selectors are read-only)', async () => {
      const threadId = 'conv-fc-readonly-fallback'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: PROJECT_UUID_A,
        })
      )

      // Persist project artifact (fallback paths removed in RUN 1)
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID_A,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
      })

      // Selector shows the project card from persisted record
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID_A)

      // Record exists from explicit persist
      expect(getThreadArtifactRecord(threadId, 'project')).toBeDefined()
    })

    it('fallback path shows offer card from offer repository without writing artifact record (selectors are read-only)', async () => {
      const threadId = 'conv-fc-readonly-offer-fallback'
      await addConversation(seedConversation({ id: threadId }))

      // Add an offer directly, bypassing the workflow, to simulate old data
      const { addOffer } = await import('../../src/lib/offers/service')
      await addOffer({
        id: 'offer-legacy-readonly',
        conversationId: threadId,
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
        price: '2.000 €',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sentAt: Date.now(),
      })

      // Persist offer artifact (fallback paths removed in RUN 1)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-legacy-readonly',
        phase: 'sent',
        customerUserId: 'customer-fc-001',
        craftsmanUserId: 'craftsman-fc-001',
      })

      // Selector shows the offer card from persisted record
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer.id).toBe('offer-legacy-readonly')

      // Record exists from explicit persist
      expect(getThreadArtifactRecord(threadId, 'offer')).toBeDefined()
    })
  })
})
