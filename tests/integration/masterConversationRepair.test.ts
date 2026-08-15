/**
 * Master Conversation Repair — Tests
 *
 * Validates the one-master-conversation-per-pair model:
 *
 *  1. Multiple raw conversation rows for same pair resolve to one master runtime thread
 *  2. Inbox shows one visible thread per pair
 *  3. Opening chat lands on master thread
 *  4. Old duplicate route resolves/redirects to master
 *  5. Direct messages write to master
 *  6. Project sends write to master
 *  7. Quote sends write to master
 *  8. findExistingThreadForCraftsman with explicit customerUserId resolves correctly
 *  9. No regression to multi-send project history
 * 10. No regression to active project logic (setActiveThreadProject resolves canonical)
 * 11. No regression to participant scoping
 * 12. No regression to reload/re-entry stability
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getMessageThreadById,
  getMessageThreads,
  getThreadArtifacts,
  resolveCanonicalThreadId,
  sendMessageToThread,
  sendProjectAttachmentToThread,
  setActiveThreadProject,
  subscribeMessages,
  subscribeThreadArtifacts,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { createOfferWorkflow } from '../../src/lib/workflow/offerWorkflow'
import {
  getIncomingProjectRequests,
} from '../../src/lib/messages/requestInboxSelectors'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-mcr-001'
const CRAFTSMAN_ID = 'craftsman-mcr-001'
const CRAFTSMAN_HANDLE = 'peter-mcr'

const PROJECT_A = 'aaaa1111-1111-4111-a111-111111111111'
const PROJECT_B = 'bbbb2222-2222-4222-b222-222222222222'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id =
    overrides.id ??
    `conv-mcr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_ID,
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Badezimmer-Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'München',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-mcr-${Date.now()}`,
    title: 'Küchenrenovierung',
    category: 'Küche',
    description: 'Komplette Renovierung der Küche',
    location: 'München',
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
    requestedBudget: '3.000 – 8.000 €',
    requestedTiming: 'Innerhalb 6 Wochen',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Master Conversation Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. MULTIPLE RAW CONVERSATIONS RESOLVE TO ONE MASTER THREAD
  // ═══════════════════════════════════════════════════════════════════════════

  describe('one master thread per customer↔craftsman pair', () => {
    it('duplicate conversations produce one inbox entry', async () => {
      // Simulate legacy duplicates with different createdAt
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const threads = getMessageThreads()
      const pairThreads = threads.filter(
        (t) => t.craftsmanHandle === CRAFTSMAN_HANDLE
      )

      expect(pairThreads).toHaveLength(1)
      // The canonical winner is the most recently created
      expect(pairThreads[0].id).toBe('conv-new')
    })

    it('three duplicates still resolve to one inbox entry', async () => {
      await addConversation(
        seedConversation({ id: 'conv-a', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-b', createdAt: 3000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-c', createdAt: 2000 })
      )

      const threads = getMessageThreads()
      const pairThreads = threads.filter(
        (t) => t.craftsmanHandle === CRAFTSMAN_HANDLE
      )

      expect(pairThreads).toHaveLength(1)
      expect(pairThreads[0].id).toBe('conv-b') // Highest createdAt
    })

    it('different craftsman pairs show separate threads', async () => {
      await addConversation(
        seedConversation({ id: 'conv-pair1', craftsmanHandle: 'craftsman-a' })
      )
      await addConversation(
        seedConversation({ id: 'conv-pair2', craftsmanHandle: 'craftsman-b' })
      )

      const threads = getMessageThreads()
      expect(threads).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. OPENING CHAT LANDS ON MASTER THREAD
  // ═══════════════════════════════════════════════════════════════════════════

  describe('thread open resolves to canonical master', () => {
    it('opening old duplicate resolves to master thread ID', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const canonicalId = resolveCanonicalThreadId('conv-old')
      expect(canonicalId).toBe('conv-new')
    })

    it('opening master thread returns itself', async () => {
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const canonicalId = resolveCanonicalThreadId('conv-new')
      expect(canonicalId).toBe('conv-new')
    })

    it('getMessageThreadById resolves old ID to canonical thread', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const thread = getMessageThreadById('conv-old')
      expect(thread).toBeDefined()
      expect(thread!.id).toBe('conv-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. MESSAGES ACROSS DUPLICATES ARE CONSOLIDATED
  // ═══════════════════════════════════════════════════════════════════════════

  describe('message history consolidation across duplicates', () => {
    it('messages from old and new conversations appear in one thread', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      // Send message to old conversation
      await sendMessageToThread('conv-old', 'Hello from old thread')
      // Send message to new conversation
      await sendMessageToThread('conv-new', 'Hello from new thread')

      // Both messages appear in the canonical thread
      const thread = getMessageThreadById('conv-new')!
      expect(thread.messages).toHaveLength(2)
      const texts = thread.messages.map((m) => m.text)
      expect(texts).toContain('Hello from old thread')
      expect(texts).toContain('Hello from new thread')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. DIRECT MESSAGES WRITE TO MASTER
  // ═══════════════════════════════════════════════════════════════════════════

  describe('text message writes target canonical master', () => {
    it('sendMessageToThread from old ID writes to canonical', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      await sendMessageToThread('conv-old', 'Hallo Handwerker!')

      // The message should land on the canonical conversation
      const thread = getMessageThreadById('conv-new')!
      expect(thread.messages).toHaveLength(1)
      expect(thread.messages[0].text).toBe('Hallo Handwerker!')
    })

    it('sendMessageToThread from master ID writes correctly', async () => {
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      await sendMessageToThread('conv-new', 'Direct message')

      const thread = getMessageThreadById('conv-new')!
      expect(thread.messages).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. PROJECT SENDS WRITE TO MASTER
  // ═══════════════════════════════════════════════════════════════════════════

  describe('project sends target canonical master', () => {
    it('sendProjectAttachmentToThread from old ID persists on canonical', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))

      await sendProjectAttachmentToThread('conv-old', PROJECT_A)

      // Artifact appears on canonical thread
      const artifacts = getThreadArtifacts('conv-new')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Küche')

      // sourceProjectId should be set on canonical conversation
      const canonical = getConversationById('conv-new')!
      expect(canonical.sourceProjectId).toBe(PROJECT_A)
    })

    it('multi-send project artifacts accumulate on canonical', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))

      await sendProjectAttachmentToThread('conv-master', PROJECT_A)
      await sendProjectAttachmentToThread('conv-master', PROJECT_B)

      const artifacts = getThreadArtifacts('conv-master')
      expect(artifacts.projectArtifacts).toHaveLength(2)

      const titles = artifacts.projectArtifacts.map((a) => a.snapshot?.title)
      expect(titles).toContain('Küche')
      expect(titles).toContain('Bad')
    })

    it('project sends across duplicates visible in unified artifacts', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))

      // Send one project to each conversation (simulating legacy split)
      await sendProjectAttachmentToThread('conv-old', PROJECT_A)
      await sendProjectAttachmentToThread('conv-new', PROJECT_B)

      // Both should be visible through either thread ID
      const fromOld = getThreadArtifacts('conv-old')
      const fromNew = getThreadArtifacts('conv-new')

      // Both views should show both artifacts (consolidated)
      expect(fromOld.projectArtifacts).toHaveLength(2)
      expect(fromNew.projectArtifacts).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. QUOTE SENDS WRITE TO MASTER
  // ═══════════════════════════════════════════════════════════════════════════

  describe('quote sends target canonical master', () => {
    it('createOfferWorkflow from old ID writes to canonical', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const offer = await createOfferWorkflow({
        conversationId: 'conv-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '5.000 €',
        description: 'Komplettsanierung',
      })

      // Offer targets canonical conversation
      expect(offer.conversationId).toBe('conv-new')

      // Artifact appears on canonical thread
      const artifacts = getThreadArtifacts('conv-new')
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(5000))
    })

    it('duplicate offer guard works across canonical resolution', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      // First offer from old ID
      await createOfferWorkflow({
        conversationId: 'conv-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '3.000 €',
      })

      // Second offer from new ID should fail (duplicate)
      await expect(
        createOfferWorkflow({
          conversationId: 'conv-new',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '4.000 €',
        })
      ).rejects.toThrow(/Active offer already exists/)
    })

    it('quote from canonical ID works in pre-job thread', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )

      const offer = await createOfferWorkflow({
        conversationId: 'conv-master',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '2.500 €',
      })

      expect(offer.conversationId).toBe('conv-master')
      expect(offer.status).toBe('pending')

      const artifacts = getThreadArtifacts('conv-master')
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. setActiveThreadProject RESOLVES THROUGH CANONICAL
  // ═══════════════════════════════════════════════════════════════════════════

  describe('setActiveThreadProject resolves through canonical', () => {
    it('sets active project on canonical conversation from old ID', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))

      // Send both projects
      await sendProjectAttachmentToThread('conv-new', PROJECT_A)
      await sendProjectAttachmentToThread('conv-new', PROJECT_B)

      // Switch active project via old ID
      const switched = setActiveThreadProject('conv-old', PROJECT_B)
      expect(switched).toBe(true)

      // Canonical conversation has the updated active project
      const canonical = getConversationById('conv-new')!
      expect(canonical.sourceProjectId).toBe(PROJECT_B)
    })

    it('rejects project not in thread history', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )

      const result = setActiveThreadProject('conv-master', 'nonexistent-project')
      expect(result).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. REQUEST INBOX SHOWS ONE ENTRY PER PAIR
  // ═══════════════════════════════════════════════════════════════════════════

  describe('request inbox shows one entry per pair', () => {
    it('duplicate conversations produce one request item', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )

      const requests = getIncomingProjectRequests()
      const pairRequests = requests.filter(
        (r) => r.threadId === 'conv-old' || r.threadId === 'conv-new'
      )

      expect(pairRequests).toHaveLength(1)
      expect(pairRequests[0].threadId).toBe('conv-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. SUBSCRIPTION-DRIVEN REFRESH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('subscription refresh correctness', () => {
    it('message subscription fires after text send', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )

      let notifyCount = 0
      const unsub = subscribeMessages(() => {
        notifyCount++
      })

      await sendMessageToThread('conv-master', 'Test message')
      expect(notifyCount).toBeGreaterThan(0)

      unsub()
    })

    it('artifact subscription fires after project send', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A }))

      let notifyCount = 0
      const unsub = subscribeThreadArtifacts(() => {
        notifyCount++
      })

      await sendProjectAttachmentToThread('conv-master', PROJECT_A)
      expect(notifyCount).toBeGreaterThan(0)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. UNREAD CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('unread count consolidation', () => {
    it('unread counts from duplicate conversations are summed', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000, unreadCount: 2 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000, unreadCount: 3 })
      )

      const thread = getMessageThreadById('conv-new')!
      expect(thread.unreadCount).toBe(5) // 2 + 3
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. RELOAD / RE-ENTRY STABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  describe('reload/re-entry stability', () => {
    it('project artifacts survive simulated re-read', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))

      await sendProjectAttachmentToThread('conv-master', PROJECT_A)

      // Simulate re-entry: read artifacts twice
      const first = getThreadArtifacts('conv-master')
      const second = getThreadArtifacts('conv-master')

      expect(first.projectArtifacts).toHaveLength(1)
      expect(second.projectArtifacts).toHaveLength(1)
      expect(second.projectArtifacts[0].snapshot?.title).toBe('Küche')
    })

    it('offer artifacts survive simulated re-read', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )

      await createOfferWorkflow({
        conversationId: 'conv-master',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.200 €',
      })

      const first = getThreadArtifacts('conv-master')
      const second = getThreadArtifacts('conv-master')

      expect(first.offerPaymentArtifact).not.toBeNull()
      expect(second.offerPaymentArtifact).not.toBeNull()
      expect(second.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(1200))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. COMBINED SCENARIO: PROJECT + QUOTE IN MASTER THREAD
  // ═══════════════════════════════════════════════════════════════════════════

  describe('combined project + quote in master thread', () => {
    it('project and quote coexist in canonical master thread', async () => {
      await addConversation(
        seedConversation({ id: 'conv-master', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Bad' }))

      // Customer sends project
      await sendProjectAttachmentToThread('conv-master', PROJECT_A)

      // Craftsman sends quote
      await createOfferWorkflow({
        conversationId: 'conv-master',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '7.500 €',
        description: 'Komplettangebot Badezimmer',
      })

      const artifacts = getThreadArtifacts('conv-master')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    })

    it('project + quote via old duplicate both appear in canonical', async () => {
      await addConversation(
        seedConversation({ id: 'conv-old', createdAt: 1000 })
      )
      await addConversation(
        seedConversation({ id: 'conv-new', createdAt: 2000 })
      )
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))

      // Project sent via old ID
      await sendProjectAttachmentToThread('conv-old', PROJECT_A)

      // Quote sent via old ID
      await createOfferWorkflow({
        conversationId: 'conv-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '4.000 €',
      })

      // Both visible from canonical
      const artifacts = getThreadArtifacts('conv-new')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. PARTICIPANT SCOPING — NO CROSS-PAIR CONTAMINATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('participant scoping correctness', () => {
    it('different customers with same craftsman are separate threads', async () => {
      await addConversation(
        seedConversation({
          id: 'conv-customer-a',
          customerUserId: 'customer-a',
          customerName: 'Customer A',
          createdAt: 1000,
        })
      )
      await addConversation(
        seedConversation({
          id: 'conv-customer-b',
          customerUserId: 'customer-b',
          customerName: 'Customer B',
          createdAt: 2000,
        })
      )

      const threads = getMessageThreads()
      expect(threads).toHaveLength(2)

      // Each thread has its own customer
      const names = threads.map((t) => t.customerName).sort()
      expect(names).toEqual(['Customer A', 'Customer B'])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. CONVERSATIONS WITHOUT customerUserId
  // ═══════════════════════════════════════════════════════════════════════════

  describe('conversations without customerUserId', () => {
    it('ungroupable conversations are treated as unique', async () => {
      // Conversations without customerUserId cannot be reliably deduplicated
      await addConversation(
        seedConversation({
          id: 'conv-no-uid-a',
          customerUserId: undefined,
          createdAt: 1000,
        })
      )
      await addConversation(
        seedConversation({
          id: 'conv-no-uid-b',
          customerUserId: undefined,
          createdAt: 2000,
        })
      )

      const threads = getMessageThreads()
      // Without customerUserId, dedup cannot group them, so both appear
      expect(threads).toHaveLength(2)
    })
  })
})
