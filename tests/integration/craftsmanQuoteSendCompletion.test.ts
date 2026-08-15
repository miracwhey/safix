/**
 * Craftsman Quote Send Completion — End-to-End Tests
 *
 * Validates the full quote creation flow works end-to-end:
 *
 * 1. Craftsman can successfully send a quote in a pre-job thread
 * 2. Quote creation does NOT require an existing job
 * 3. Customer sees the quote card in the same thread
 * 4. Craftsman sees the quote card in the same thread
 * 5. Quote survives reload/re-entry
 * 6. No regression to project history, active project logic, or participant scoping
 *
 * Also tests input validation and error handling for the quote creation workflow.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOffersByConversationId } from '../../src/lib/offers/service'
import { getJobs } from '../../src/lib/jobs'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-qsc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-qsc-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-qsc-001',
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
    id: overrides.id ?? `proj-qsc-${Date.now()}`,
    title: 'Küche Sanierung',
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
    updatedAt: Date.now(),
    source: 'builder',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Craftsman Quote Send Completion — End-to-End', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. CRAFTSMAN CAN SUCCESSFULLY SEND A QUOTE IN A PRE-JOB THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Craftsman can successfully send a quote in a pre-job thread', () => {
    it('quote creation succeeds with valid inputs', async () => {
      const threadId = 'conv-qsc-success-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '2.500 €',
        description: 'Komplette Küchenmontage',
      })

      expect(offer).toBeDefined()
      expect(offer.id).toBeTruthy()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('2.500 €')
      expect(offer.conversationId).toBe(threadId)
      expect(offer.craftsmanUserId).toBe('craftsman-qsc-001')
      expect(offer.customerUserId).toBe('customer-qsc-001')
      expect(offer.sentAt).toBeGreaterThan(0)
    })

    it('offer is persisted in the offer repository', async () => {
      const threadId = 'conv-qsc-persist-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '3.000 €',
      })

      const offers = getOffersByConversationId(threadId)
      expect(offers).toHaveLength(1)
      expect(offers[0].price).toBe('3.000 €')
      expect(offers[0].status).toBe('pending')
    })

    it('offer artifact record is created', async () => {
      const threadId = 'conv-qsc-artifact-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '1.800 €',
        description: 'Sanitärarbeiten',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('offer')
      expect(record!.phase).toBe('sent')
      expect(record!.snapshotPrice).toBe(formatEuro(1800))
      expect(record!.snapshotSummary).toBe('Sanitärarbeiten')
      expect(record!.snapshotPhaseLabel).toBe('Verbindliches Angebot liegt vor')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. QUOTE CREATION DOES NOT REQUIRE AN EXISTING JOB
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Quote creation does not require an existing job', () => {
    it('quote succeeds when no jobs exist at all', async () => {
      const threadId = 'conv-qsc-nojob-001'
      await addConversation(seedConversation({ id: threadId }))

      // Verify no jobs exist
      expect(getJobs()).toHaveLength(0)

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '4.500 €',
      })

      expect(offer.status).toBe('pending')
      expect(offer.createdJobId).toBeUndefined()

      // Jobs still don't exist — job is created on acceptance, not quote
      expect(getJobs()).toHaveLength(0)
    })

    it('quote succeeds without sourceProjectId on conversation', async () => {
      const threadId = 'conv-qsc-nosource-001'
      await addConversation(seedConversation({
        id: threadId,
        // No sourceProjectId — pure inquiry thread
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '2.000 €',
        description: 'Malerarbeiten',
      })

      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('2.000 €')
    })

    it('quote artifact is created without a jobId', async () => {
      const threadId = 'conv-qsc-nojob-artifact-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '3.200 €',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.jobId).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. CUSTOMER SEES THE QUOTE CARD IN THE SAME THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Customer sees the quote card in the same thread', () => {
    it('getThreadArtifacts resolves offer artifact after quote send', async () => {
      const threadId = 'conv-qsc-customer-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '5.000 €',
        description: 'Fliesenarbeiten Bad',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
      expect(artifacts.offerPaymentArtifact!.offer).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer!.price).toBe('5.000 €')
    })

    it('quote artifact has snapshot data for immediate rendering', async () => {
      const threadId = 'conv-qsc-snapshot-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '1.200 €',
        description: 'Malerarbeiten Wohnzimmer',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.snapshotPrice).toBe(formatEuro(1200))
      expect(record!.snapshotSummary).toBe('Malerarbeiten Wohnzimmer')
      expect(record!.snapshotPhaseLabel).toBe('Verbindliches Angebot liegt vor')
    })

    it('quote artifact has createdAt for timeline interleaving', async () => {
      const threadId = 'conv-qsc-timeline-001'
      await addConversation(seedConversation({ id: threadId }))

      const before = Date.now()
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '1.000 €',
      })
      const after = Date.now()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThanOrEqual(before)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThanOrEqual(after)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. CRAFTSMAN SEES THE QUOTE CARD IN THE SAME THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Craftsman sees the quote card in the same thread', () => {
    it('artifact is visible with craftsman participant IDs', async () => {
      const threadId = 'conv-qsc-craftsman-001'
      await addConversation(seedConversation({
        id: threadId,
        craftsmanUserId: 'craftsman-view-001',
        customerUserId: 'customer-view-001',
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-view-001',
        craftsmanUserId: 'craftsman-view-001',
        price: '7.500 €',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.craftsmanUserId).toBe('craftsman-view-001')
      expect(record!.customerUserId).toBe('customer-view-001')
    })

    it('persistenceStatus is confirmed after successful creation', async () => {
      const threadId = 'conv-qsc-confirm-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '3.500 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. QUOTE SURVIVES RELOAD / RE-ENTRY
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Quote survives reload/re-entry', () => {
    it('repeated reads return consistent data', async () => {
      const threadId = 'conv-qsc-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '6.000 €',
        description: 'Heizungsinstallation',
      })

      // Multiple reads simulate re-entry
      const r1 = getThreadArtifacts(threadId)
      const r2 = getThreadArtifacts(threadId)
      const r3 = getThreadArtifacts(threadId)

      expect(r1.offerPaymentArtifact!.offer!.price).toBe('6.000 €')
      expect(r2.offerPaymentArtifact!.offer!.price).toBe('6.000 €')
      expect(r3.offerPaymentArtifact!.offer!.price).toBe('6.000 €')
    })

    it('artifact record is stable in the repository', async () => {
      const threadId = 'conv-qsc-stable-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '2.800 €',
      })

      const r1 = getThreadArtifactRecord(threadId, 'offer')
      const r2 = getThreadArtifactRecord(threadId, 'offer')
      expect(r1!.id).toBe(r2!.id)
      expect(r1!.offerId).toBe(r2!.offerId)
      expect(r1!.snapshotPrice).toBe(r2!.snapshotPrice)
    })

    it('snapshot provides fallback rendering without full offer entity', async () => {
      const threadId = 'conv-qsc-snapshot-fallback-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '4.400 €',
        description: 'Elektroarbeiten',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      // Snapshot fields are always persisted — card can render from snapshot alone
      expect(record!.snapshotPrice).toBe(formatEuro(4400))
      expect(record!.snapshotSummary).toBe('Elektroarbeiten')
      expect(record!.snapshotPhaseLabel).toBe('Verbindliches Angebot liegt vor')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. NO REGRESSION TO PROJECT HISTORY, ACTIVE PROJECT LOGIC,
  //    OR PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. No regression to existing systems', () => {
    it('project artifacts remain intact after quote creation', async () => {
      const projectId = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
      const threadId = 'conv-qsc-no-regress-001'
      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({ id: threadId }))

      // Attach a project first
      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
      })

      // Then send a quote
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '4.000 €',
      })

      // Both artifacts coexist
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer!.price).toBe('4.000 €')
    })

    it('no jobs are created during quote submission', async () => {
      const threadId = 'conv-qsc-no-job-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '2.200 €',
      })

      // Quote does not create jobs — that happens on acceptance
      expect(getJobs()).toHaveLength(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. INPUT VALIDATION AND ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Input validation and error handling', () => {
    it('rejects empty craftsmanUserId with specific error', async () => {
      const threadId = 'conv-qsc-val-craftsman-001'
      await addConversation(seedConversation({ id: threadId }))

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: 'customer-qsc-001',
          craftsmanUserId: '',
          price: '1.000 €',
        })
      ).rejects.toThrow('Missing craftsmanUserId')
    })

    it('rejects empty customerUserId with specific error', async () => {
      const threadId = 'conv-qsc-val-customer-001'
      await addConversation(seedConversation({ id: threadId }))

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: '',
          craftsmanUserId: 'craftsman-qsc-001',
          price: '1.000 €',
        })
      ).rejects.toThrow('Missing customerUserId')
    })

    it('rejects empty conversationId', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: '',
          customerUserId: 'customer-qsc-001',
          craftsmanUserId: 'craftsman-qsc-001',
          price: '1.000 €',
        })
      ).rejects.toThrow('Missing conversationId')
    })

    it('rejects empty price', async () => {
      const threadId = 'conv-qsc-val-price-001'
      await addConversation(seedConversation({ id: threadId }))

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: 'customer-qsc-001',
          craftsmanUserId: 'craftsman-qsc-001',
          price: '',
        })
      ).rejects.toThrow('Missing price')
    })

    it('rejects whitespace-only price', async () => {
      const threadId = 'conv-qsc-val-price-ws-001'
      await addConversation(seedConversation({ id: threadId }))

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: 'customer-qsc-001',
          craftsmanUserId: 'craftsman-qsc-001',
          price: '   ',
        })
      ).rejects.toThrow('Missing price')
    })

    it('prevents duplicate active offer for same conversation', async () => {
      const threadId = 'conv-qsc-dup-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-qsc-001',
        craftsmanUserId: 'craftsman-qsc-001',
        price: '1.500 €',
      })

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: 'customer-qsc-001',
          craftsmanUserId: 'craftsman-qsc-001',
          price: '2.000 €',
        })
      ).rejects.toThrow('Active offer already exists')
    })
  })
})
