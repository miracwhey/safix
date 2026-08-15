/**
 * Live Runtime Thread Send Repair — Tests
 *
 * Validates the actual live runtime send pipeline for project-send and
 * quote-send events.  These tests specifically cover the gaps between
 * the test model and the real runtime behavior:
 *
 *  1. Project send via workflow → immediate visibility in relationship thread
 *  2. Quote send via workflow → immediate visibility in relationship thread
 *  3. Duplicate offer guard uses canonical conversation ID
 *  4. Canonical routing for project and quote writes across duplicate conversations
 *  5. Post-send artifact refresh correctness
 *  6. Subscription-driven state refresh
 *  7. No regression to multi-send project history
 *  8. No regression to active project logic
 *  9. No regression to participant scoping
 * 10. No regression to reload/re-entry stability
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getMessageThreadById,
  getMessageThreads,
  getThreadArtifacts,
  subscribeMessages,
  subscribeThreadArtifacts,
  resolveCanonicalThreadId,
  sendProjectAttachmentToThread,
  setActiveThreadProject,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { createOfferWorkflow } from '../../src/lib/workflow/offerWorkflow'
import { sendProjectAttachmentWorkflow } from '../../src/lib/workflow'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-lrt-001'
const CRAFTSMAN_ID = 'craftsman-lrt-001'
const CRAFTSMAN_HANDLE = 'karl-hw'

const PROJECT_A = 'aaaa0001-1111-4aaa-aaaa-aaaaaaaaaaaa'
const PROJECT_B = 'bbbb0002-2222-4bbb-bbbb-bbbbbbbbbbbb'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-lrt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Lisa Kundin',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_ID,
    craftsmanName: 'Karl Handwerker',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Test Projekt',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Hamburg',
    timeLabel: 'Jetzt',
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-lrt-${Date.now()}`,
    title: 'Küchenrenovierung',
    category: 'Küche',
    description: 'Komplette Renovierung',
    location: 'Hamburg',
    status: 'request',
    source: 'builder',
    sourceJobId: '',
    customer: 'Kunde',
    craftsman: 'Handwerker',
    dateLabel: 'Offen',
    price: '',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedBudget: '2.000 – 5.000 €',
    requestedTiming: 'Innerhalb 4 Wochen',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Live Runtime Thread Send Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. PROJECT SEND → IMMEDIATE VISIBILITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('project send → immediate visibility in thread', () => {
    it('project artifact appears immediately after sendProjectAttachmentWorkflow', async () => {
      const threadId = 'conv-lrt-proj-imm'
      await addProject(seedProject({ id: PROJECT_A, title: 'Badezimmer' }))
      await addConversation(seedConversation({ id: threadId }))

      // BEFORE: no artifacts
      const before = getThreadArtifacts(threadId)
      expect(before.projectArtifacts).toHaveLength(0)

      // SEND
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // AFTER: artifact visible immediately
      const after = getThreadArtifacts(threadId)
      expect(after.projectArtifacts).toHaveLength(1)
      expect(after.projectArtifacts[0].snapshot?.title).toBe('Badezimmer')
      expect(after.projectArtifacts[0].createdAt).toBeGreaterThan(0)
    })

    it('project artifact visible via getMessageThreadById after send', async () => {
      const threadId = 'conv-lrt-proj-thread'
      await addProject(seedProject({ id: PROJECT_A, title: 'Fliesenlegen' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      // Thread messages should contain the notification message
      // and artifacts should contain the project card
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
    })

    it('subscription fires after project send', async () => {
      const threadId = 'conv-lrt-proj-sub'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      let artifactNotifyCount = 0
      let messageNotifyCount = 0
      const unsubArtifacts = subscribeThreadArtifacts(() => { artifactNotifyCount++ })
      const unsubMessages = subscribeMessages(() => { messageNotifyCount++ })

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Both subscriptions should have fired
      expect(artifactNotifyCount).toBeGreaterThanOrEqual(1)
      expect(messageNotifyCount).toBeGreaterThanOrEqual(1)

      unsubArtifacts()
      unsubMessages()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. QUOTE SEND → IMMEDIATE VISIBILITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('quote send → immediate visibility in thread', () => {
    it('offer artifact appears immediately after createOfferWorkflow', async () => {
      const threadId = 'conv-lrt-quote-imm'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      // BEFORE: no offer
      const before = getThreadArtifacts(threadId)
      expect(before.offerPaymentArtifact).toBeNull()

      // SEND
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '3.500 €',
        description: 'Badezimmer komplett',
      })

      // AFTER: offer visible immediately
      const after = getThreadArtifacts(threadId)
      expect(after.offerPaymentArtifact).not.toBeNull()
      expect(after.offerPaymentArtifact!.phase).toBe('sent')
      expect(after.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(3500))
      expect(after.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })

    it('subscription fires after quote send', async () => {
      const threadId = 'conv-lrt-quote-sub'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      let artifactNotifyCount = 0
      const unsub = subscribeThreadArtifacts(() => { artifactNotifyCount++ })

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.500 €',
      })

      expect(artifactNotifyCount).toBeGreaterThanOrEqual(1)
      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. DUPLICATE OFFER GUARD — CANONICAL ROUTING
  // ═══════════════════════════════════════════════════════════════════════

  describe('duplicate offer guard uses canonical conversation ID', () => {
    it('detects existing offer via canonical resolution', async () => {
      // Create two conversations for the same pair (duplicate)
      await addConversation(seedConversation({
        id: 'conv-lrt-dup-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-dup-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      // Send quote via the OLD (non-canonical) conversation
      await createOfferWorkflow({
        conversationId: 'conv-lrt-dup-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.000 €',
      })

      // Attempting to send ANOTHER quote via the OLD conversation should fail
      // because the guard now checks the CANONICAL conversation (conv-lrt-dup-new)
      await expect(
        createOfferWorkflow({
          conversationId: 'conv-lrt-dup-old',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '2.000 €',
        })
      ).rejects.toThrow('Active offer already exists')

      // Also fails when trying via the NEW (canonical) conversation directly
      await expect(
        createOfferWorkflow({
          conversationId: 'conv-lrt-dup-new',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '3.000 €',
        })
      ).rejects.toThrow('Active offer already exists')
    })

    it('offer written to canonical conversation is visible from both IDs', async () => {
      await addConversation(seedConversation({
        id: 'conv-lrt-vis-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-vis-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      // Send quote via old conversation ID
      const offer = await createOfferWorkflow({
        conversationId: 'conv-lrt-vis-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '4.500 €',
      })

      // Offer should be written to canonical (newer) conversation
      expect(offer.conversationId).toBe('conv-lrt-vis-new')

      // Visible from canonical thread
      const fromNew = getThreadArtifacts('conv-lrt-vis-new')
      expect(fromNew.offerPaymentArtifact).not.toBeNull()
      expect(fromNew.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(4500))

      // Also visible from old thread (via relationship group aggregation)
      const fromOld = getThreadArtifacts('conv-lrt-vis-old')
      expect(fromOld.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. CANONICAL ROUTING FOR PROJECT SENDS
  // ═══════════════════════════════════════════════════════════════════════

  describe('canonical routing for project sends', () => {
    it('project artifact written to canonical conversation', async () => {
      await addProject(seedProject({ id: PROJECT_A, title: 'Dachsanierung' }))
      await addConversation(seedConversation({
        id: 'conv-lrt-proj-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-proj-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      // Send via old conversation
      await sendProjectAttachmentWorkflow('conv-lrt-proj-old', PROJECT_A)

      // Visible from canonical thread
      const canonical = getThreadArtifacts('conv-lrt-proj-new')
      expect(canonical.projectArtifacts).toHaveLength(1)
      expect(canonical.projectArtifacts[0].snapshot?.title).toBe('Dachsanierung')

      // Also visible from old thread (via relationship group aggregation)
      const old = getThreadArtifacts('conv-lrt-proj-old')
      expect(old.projectArtifacts).toHaveLength(1)
    })

    it('sourceProjectId set on canonical conversation', async () => {
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: 'conv-lrt-src-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-src-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      await sendProjectAttachmentWorkflow('conv-lrt-src-old', PROJECT_A)

      // sourceProjectId should be stamped on the canonical conversation
      const canonical = getConversationById('conv-lrt-src-new')
      expect(canonical?.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. POST-SEND REFRESH — ARTIFACT STATE IMMEDIATELY CORRECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('post-send refresh correctness', () => {
    it('getThreadArtifacts reflects project immediately after send', async () => {
      const threadId = 'conv-lrt-refresh-proj'
      await addProject(seedProject({ id: PROJECT_A, title: 'Heizungswartung' }))
      await addConversation(seedConversation({ id: threadId }))

      // Verify before
      expect(getThreadArtifacts(threadId).projectArtifacts).toHaveLength(0)

      // Send and immediately verify
      await sendProjectAttachmentToThread(threadId, PROJECT_A)
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifact?.snapshot?.title).toBe('Heizungswartung')
    })

    it('getThreadArtifacts reflects quote immediately after send', async () => {
      const threadId = 'conv-lrt-refresh-quote'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      expect(getThreadArtifacts(threadId).offerPaymentArtifact).toBeNull()

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '800 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(800))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. SUBSCRIPTION-DRIVEN STATE UPDATE
  // ═══════════════════════════════════════════════════════════════════════

  describe('subscription-driven state updates', () => {
    it('artifact subscription fires for project artifact insert', async () => {
      const threadId = 'conv-lrt-sub-insert'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      const snapshots: number[] = []
      const unsub = subscribeThreadArtifacts(() => {
        snapshots.push(getThreadArtifacts(threadId).projectArtifacts.length)
      })

      await sendProjectAttachmentToThread(threadId, PROJECT_A)

      // At least one notification should have been fired with the new artifact
      expect(snapshots.some((count) => count >= 1)).toBe(true)
      unsub()
    })

    it('artifact subscription fires for offer artifact upsert', async () => {
      const threadId = 'conv-lrt-sub-upsert'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      const snapshots: boolean[] = []
      const unsub = subscribeThreadArtifacts(() => {
        const has = getThreadArtifacts(threadId).offerPaymentArtifact !== null
        snapshots.push(has)
      })

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.200 €',
      })

      expect(snapshots.some((has) => has)).toBe(true)
      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. MULTI-SEND PROJECT HISTORY REGRESSION
  // ═══════════════════════════════════════════════════════════════════════

  describe('no regression to multi-send project history', () => {
    it('multiple project sends produce multiple artifacts', async () => {
      const threadId = 'conv-lrt-multi'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      const titles = artifacts.projectArtifacts.map((a) => a.snapshot?.title)
      expect(titles).toContain('Küche')
      expect(titles).toContain('Bad')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. ACTIVE PROJECT LOGIC REGRESSION
  // ═══════════════════════════════════════════════════════════════════════

  describe('no regression to active project logic', () => {
    it('first project becomes active, second does not overwrite', async () => {
      const threadId = 'conv-lrt-active'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
    })

    it('explicit switch changes active project', async () => {
      const threadId = 'conv-lrt-switch'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      setActiveThreadProject(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. PARTICIPANT SCOPING REGRESSION
  // ═══════════════════════════════════════════════════════════════════════

  describe('no regression to participant scoping', () => {
    it('one inbox entry per relationship pair', async () => {
      await addConversation(seedConversation({
        id: 'conv-lrt-scope-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-scope-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      const threads = getMessageThreads()
      const pairThreads = threads.filter(
        (t) => t.customerUserId === CUSTOMER_ID && t.craftsmanHandle === CRAFTSMAN_HANDLE
      )
      expect(pairThreads).toHaveLength(1)
      expect(pairThreads[0].id).toBe('conv-lrt-scope-new')
    })

    it('resolveCanonicalThreadId redirects old to new', async () => {
      await addConversation(seedConversation({
        id: 'conv-lrt-canon-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-canon-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      expect(resolveCanonicalThreadId('conv-lrt-canon-old')).toBe('conv-lrt-canon-new')
      expect(resolveCanonicalThreadId('conv-lrt-canon-new')).toBe('conv-lrt-canon-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. RELOAD / RE-ENTRY STABILITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('no regression to reload/re-entry stability', () => {
    it('project artifact survives re-read', async () => {
      const threadId = 'conv-lrt-reload-proj'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Read 1
      const read1 = getThreadArtifacts(threadId)
      // Read 2 (simulates re-entry)
      const read2 = getThreadArtifacts(threadId)

      expect(read1.projectArtifacts).toHaveLength(1)
      expect(read2.projectArtifacts).toHaveLength(1)
      expect(read2.projectArtifacts[0].snapshot?.title).toBe('Küche')
    })

    it('offer artifact survives re-read', async () => {
      const threadId = 'conv-lrt-reload-offer'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '2.000 €',
      })

      // Read 1
      const read1 = getThreadArtifacts(threadId)
      // Read 2
      const read2 = getThreadArtifacts(threadId)

      expect(read1.offerPaymentArtifact).not.toBeNull()
      expect(read2.offerPaymentArtifact).not.toBeNull()
      expect(read2.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(2000))
    })

    it('both project and offer survive combined re-read', async () => {
      const threadId = 'conv-lrt-reload-both'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '5.000 €',
      })

      const read1 = getThreadArtifacts(threadId)
      const read2 = getThreadArtifacts(threadId)

      expect(read1.projectArtifacts).toHaveLength(1)
      expect(read1.offerPaymentArtifact).not.toBeNull()
      expect(read2.projectArtifacts).toHaveLength(1)
      expect(read2.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 11. COMBINED PROJECT + QUOTE IN SAME THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('combined project + quote in same thread', () => {
    it('project and quote coexist in same relationship thread', async () => {
      const threadId = 'conv-lrt-combined'
      await addProject(seedProject({ id: PROJECT_A, title: 'Heizungsanlage' }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      // Customer sends project
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Craftsman sends quote
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '8.000 €',
        description: 'Heizungsanlage Komplettsanierung',
      })

      const artifacts = getThreadArtifacts(threadId)

      // Project
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Heizungsanlage')

      // Quote
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(8000))
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')

      // Both have chronological timestamps
      expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })

    it('project + quote coexist across duplicate conversations', async () => {
      await addProject(seedProject({ id: PROJECT_A, title: 'Dach' }))
      await addConversation(seedConversation({
        id: 'conv-lrt-cx-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-lrt-cx-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      // Send project via old conversation
      await sendProjectAttachmentWorkflow('conv-lrt-cx-old', PROJECT_A)

      // Send quote via old conversation
      await createOfferWorkflow({
        conversationId: 'conv-lrt-cx-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '6.000 €',
      })

      // Both visible from canonical thread
      const fromNew = getThreadArtifacts('conv-lrt-cx-new')
      expect(fromNew.projectArtifacts).toHaveLength(1)
      expect(fromNew.offerPaymentArtifact).not.toBeNull()

      // Both visible from old thread (via group aggregation)
      const fromOld = getThreadArtifacts('conv-lrt-cx-old')
      expect(fromOld.projectArtifacts).toHaveLength(1)
      expect(fromOld.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 12. ERROR SURFACE CORRECTNESS
  // ═══════════════════════════════════════════════════════════════════════

  describe('meaningful error surfaces', () => {
    it('quote send with missing price gives clear error', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: 'some-conv',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '',
        })
      ).rejects.toThrow('Missing price')
    })

    it('quote send with missing conversationId gives clear error', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: '',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '100 €',
        })
      ).rejects.toThrow('Missing conversationId')
    })

    it('quote send with missing craftsmanUserId gives clear error', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: 'some-conv',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: '',
          price: '100 €',
        })
      ).rejects.toThrow('Missing craftsmanUserId')
    })

    it('quote send with missing customerUserId gives clear error', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: 'some-conv',
          customerUserId: '',
          craftsmanUserId: CRAFTSMAN_ID,
          price: '100 €',
        })
      ).rejects.toThrow('Missing customerUserId')
    })

    it('duplicate offer error is actionable', async () => {
      const threadId = 'conv-lrt-dup-err'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.000 €',
      })

      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '2.000 €',
        })
      ).rejects.toThrow('Active offer already exists')
    })
  })
})
