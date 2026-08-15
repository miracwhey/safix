/**
 * Remaining Messaging Runtime Completion — Tests
 *
 * Validates the remaining runtime behavior fixes for the messaging/thread system:
 *
 *  1.  One visible inbox entry per customer ↔ craftsman relationship
 *  2.  Opening that entry lands on the same consolidated visible thread
 *  3.  First project send appears in visible thread
 *  4.  Later project sends also appear in visible thread
 *  5.  Project sends survive reload/re-entry
 *  6.  Craftsman can send quote successfully in pre-job thread
 *  7.  Quote card appears in visible thread for both participants
 *  8.  Request detail shows richer structured information than before
 *  9.  Preview / timestamp / unread use the consolidated relationship model
 * 10.  No regression to multi-send project history
 * 11.  No regression to active project logic
 * 12.  No regression to participant scoping
 * 13.  No regression to plain text messaging
 * 14.  No regression to reload/re-entry stability
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getMessageThreadById,
  getMessageThreads,
  getThreadArtifacts,
  getThreadListRow,
  persistProjectArtifact,
  sendProjectAttachmentToThread,
  setActiveThreadProject,
  resolveCanonicalThreadId,
} from '../../src/lib/messages'
import { getMessageRepository } from '../../src/lib/messages/repository/registry'
import type { Conversation, Message } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import {
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow'
import { formatMessageTimeLabel } from '../../src/lib/messages/dateUtils'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-mrc-001'
const CRAFTSMAN_ID = 'craftsman-mrc-001'
const CRAFTSMAN_HANDLE = 'peter-hw'

const PROJECT_A = 'aaa1c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_B = 'bbb2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_C = 'ccc3c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-mrc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
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
    projectTitle: 'Test Projekt',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-mrc-${Date.now()}`,
    title: 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
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
    ...overrides,
  }
}

function addMessage(msg: Partial<Message> & { conversationId: string; id: string }): void {
  const full: Message = {
    sender: 'user',
    text: '',
    createdAtLabel: 'Gerade eben',
    ...msg,
  }
  getMessageRepository().addMessageAndUpdateConversation(
    full,
    msg.conversationId,
    {}
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Remaining Messaging Runtime Completion', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. One visible inbox entry per customer ↔ craftsman relationship
  // ═══════════════════════════════════════════════════════════════════════

  describe('one visible inbox entry per relationship', () => {
    it('duplicate conversations for same pair produce one thread in inbox', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-dup-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-dup-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      const threads = getMessageThreads()
      const pairThreads = threads.filter(
        (t) => t.customerUserId === CUSTOMER_ID && t.craftsmanHandle === CRAFTSMAN_HANDLE
      )
      expect(pairThreads).toHaveLength(1)
      // The canonical (newer) conversation should be the one visible
      expect(pairThreads[0].id).toBe('conv-mrc-dup-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Opening that entry lands on the same consolidated visible thread
  // ═══════════════════════════════════════════════════════════════════════

  describe('opening any duplicate lands on canonical thread', () => {
    it('resolveCanonicalThreadId redirects old to new', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-redirect-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-redirect-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      expect(resolveCanonicalThreadId('conv-mrc-redirect-old')).toBe('conv-mrc-redirect-new')
      expect(resolveCanonicalThreadId('conv-mrc-redirect-new')).toBe('conv-mrc-redirect-new')
    })

    it('getMessageThreadById from old duplicate returns canonical thread', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-lookup-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-lookup-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      const thread = getMessageThreadById('conv-mrc-lookup-old')
      expect(thread).toBeDefined()
      expect(thread!.id).toBe('conv-mrc-lookup-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. First project send appears in visible thread
  // ═══════════════════════════════════════════════════════════════════════

  describe('first project send appears in visible thread', () => {
    it('project artifact visible after send via workflow', async () => {
      const threadId = 'conv-mrc-send-1'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche renovieren' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Küche renovieren')
      expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
    })

    it('project send sets sourceProjectId on conversation', async () => {
      const threadId = 'conv-mrc-source'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_A)

      const conv = getConversationById(threadId)
      expect(conv?.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Later project sends also appear in visible thread
  // ═══════════════════════════════════════════════════════════════════════

  describe('later project sends also appear', () => {
    it('second project send appends without overwriting first', async () => {
      const threadId = 'conv-mrc-multi-send'
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
  // 5. Project sends survive reload/re-entry
  // ═══════════════════════════════════════════════════════════════════════

  describe('project sends survive reload', () => {
    it('project artifact present on re-read', async () => {
      const threadId = 'conv-mrc-reload'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // First read
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.projectArtifacts).toHaveLength(1)

      // Re-read (simulates re-entry)
      const artifacts2 = getThreadArtifacts(threadId)
      expect(artifacts2.projectArtifacts).toHaveLength(1)
      expect(artifacts2.projectArtifacts[0].snapshot?.title).toBe('Küche')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Craftsman can send quote successfully in pre-job thread
  // ═══════════════════════════════════════════════════════════════════════

  describe('craftsman quote send in pre-job thread', () => {
    it('createOfferWorkflow succeeds without pre-existing job', async () => {
      const threadId = 'conv-mrc-quote-1'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '2.500 €',
        description: 'Badezimmer komplett',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('2.500 €')
    })

    it('quote send validates required fields', async () => {
      await expect(
        createOfferWorkflow({
          conversationId: '',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '100 €',
        })
      ).rejects.toThrow('Missing')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Quote card appears in visible thread for both participants
  // ═══════════════════════════════════════════════════════════════════════

  describe('quote card in visible thread', () => {
    it('offer artifact visible after quote send', async () => {
      const threadId = 'conv-mrc-quote-visible'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.200 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(1200))
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })

    it('quote routes to canonical conversation for duplicates', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-quote-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-quote-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      const offer = await createOfferWorkflow({
        conversationId: 'conv-mrc-quote-old',
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '800 €',
      })

      // Offer should be written to canonical (newer) conversation
      expect(offer.conversationId).toBe('conv-mrc-quote-new')

      // Visible from canonical thread
      const artifacts = getThreadArtifacts('conv-mrc-quote-new')
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Request detail shows richer structured information
  // ═══════════════════════════════════════════════════════════════════════

  describe('request detail enrichment', () => {
    it('artifact snapshot includes snapshotSummary as description', async () => {
      const threadId = 'conv-mrc-detail-1'
      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Dachreparatur',
        snapshotStatus: 'request',
        snapshotSummary: 'Dachziegel ersetzen nach Sturm',
        snapshotCategory: 'Dach',
        snapshotLocation: 'Hamburg',
        snapshotBudget: '3.000 – 5.000 €',
        snapshotTiming: 'So schnell wie möglich',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot?.summary).toBe('Dachziegel ersetzen nach Sturm')
    })

    it('conversation metadata enriches request detail with projectDescription', async () => {
      const projectId = PROJECT_A
      const threadId = 'conv-mrc-detail-enrich'

      // Conversation has projectDescription from category inquiry
      await addConversation(seedConversation({
        id: threadId,
        projectId,
        sourceProjectId: projectId,
        projectDescription: 'Alte Fliesen im Bad entfernen und neue verlegen',
        projectLocation: 'München',
        projectCostRange: '2.000 – 4.000 €',
        projectDuration: 'Innerhalb 3 Wochen',
      }))

      // Artifact snapshot with only basic info (no description)
      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Badezimmer Fliesen',
        snapshotStatus: 'request',
        snapshotCategory: 'Fliesen',
      })

      // The CraftsmanRequestDetailScreen's resolveRequestDetail function
      // should enrich the snapshot with conversation metadata.
      // We test the enrichment function's data model here:
      const { getConversationByProjectId } = await import('../../src/lib/messages')
      const conv = getConversationByProjectId(projectId)
      expect(conv).toBeDefined()
      expect(conv!.projectDescription).toBe('Alte Fliesen im Bad entfernen und neue verlegen')
      expect(conv!.projectLocation).toBe('München')
      expect(conv!.projectCostRange).toBe('2.000 – 4.000 €')
    })

    it('conversation inquiryCriteria provides enrichment data', async () => {
      const projectId = PROJECT_B
      const threadId = 'conv-mrc-detail-criteria'

      await addConversation(seedConversation({
        id: threadId,
        projectId,
        sourceProjectId: projectId,
        inquiryCriteria: {
          category: 'Elektrik',
          description: 'Steckdosen in der Küche erneuern',
          location: 'Frankfurt',
          budget: 'unter 1.000 €',
          timing: 'Nächste Woche',
        },
      }))

      const { getConversationByProjectId } = await import('../../src/lib/messages')
      const conv = getConversationByProjectId(projectId)
      expect(conv).toBeDefined()
      expect(conv!.inquiryCriteria?.category).toBe('Elektrik')
      expect(conv!.inquiryCriteria?.description).toBe('Steckdosen in der Küche erneuern')
      expect(conv!.inquiryCriteria?.location).toBe('Frankfurt')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Preview / timestamp / unread use the consolidated model
  // ═══════════════════════════════════════════════════════════════════════

  describe('preview / timestamp / unread consistency', () => {
    it('inbox timeLabel derives from last message sentAt across group', async () => {
      const now = Date.now()
      await addConversation(seedConversation({
        id: 'conv-mrc-time-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: now - 100000,
        timeLabel: 'Gestern',
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-time-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: now - 50000,
        timeLabel: 'Heute',
      }))

      // Add a message with a recent sentAt
      addMessage({
        id: 'msg-mrc-time-1',
        conversationId: 'conv-mrc-time-old',
        sender: 'user',
        text: 'Hallo',
        createdAtLabel: '',
        sentAt: now,
      })

      const thread = getMessageThreadById('conv-mrc-time-new')
      expect(thread).toBeDefined()
      // timeLabel should be derived from the last message's sentAt,
      // which is the most recent event
      expect(thread!.timeLabel).toBe(formatMessageTimeLabel(now))
    })

    it('inbox unread count consolidates across relationship group', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-unread-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        unreadCount: 2,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-unread-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        unreadCount: 3,
        createdAt: 2000,
      }))

      const thread = getMessageThreadById('conv-mrc-unread-new')
      expect(thread).toBeDefined()
      // Unread should be sum across both conversations in the group
      expect(thread!.unreadCount).toBe(5)
    })

    it('inbox preview uses last message from consolidated history', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-preview-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-preview-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      // Message in old conversation should appear in consolidated preview
      addMessage({
        id: 'msg-mrc-preview-1',
        conversationId: 'conv-mrc-preview-old',
        sender: 'user',
        text: 'Können Sie nächste Woche?',
        sentAt: 3000,
      })

      const thread = getMessageThreadById('conv-mrc-preview-new')
      expect(thread).toBeDefined()
      expect(thread!.lastMessagePreview).toBe('Können Sie nächste Woche?')
    })

    it('thread list row derives from consolidated thread', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-row',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        unreadCount: 1,
      }))

      addMessage({
        id: 'msg-mrc-row-1',
        conversationId: 'conv-mrc-row',
        sender: 'user',
        text: 'Guten Tag!',
        sentAt: Date.now(),
      })

      const thread = getMessageThreadById('conv-mrc-row')
      expect(thread).toBeDefined()

      const row = getThreadListRow(thread!, 'craftsman')
      expect(row.primaryName).toBe('Anna Kundin')
      expect(row.preview).toBe('Guten Tag!')
      expect(row.unreadCount).toBe(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. No regression to multi-send project history
  // ═══════════════════════════════════════════════════════════════════════

  describe('multi-send regression safety', () => {
    it('three project sends produce three distinct artifacts', async () => {
      const threadId = 'conv-mrc-3send'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'Dach' }))
      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Küche',
        snapshotStatus: 'request',
      })
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_B,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Bad',
        snapshotStatus: 'request',
      })
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_C,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Dach',
        snapshotStatus: 'request',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      const ids = new Set(artifacts.projectArtifacts.map((a) => a.artifactId))
      expect(ids.size).toBe(3)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 11. No regression to active project logic
  // ═══════════════════════════════════════════════════════════════════════

  describe('active project logic regression safety', () => {
    it('first sent project becomes active, second does not overwrite', async () => {
      const threadId = 'conv-mrc-active'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: PROJECT_A,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Küche',
        snapshotStatus: 'request',
      })
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_B,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Bad',
        snapshotStatus: 'request',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
    })

    it('active project can be switched explicitly', async () => {
      const threadId = 'conv-mrc-switch'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      })
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_B,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      })

      await setActiveThreadProject(threadId, PROJECT_B)
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 12. No regression to participant scoping
  // ═══════════════════════════════════════════════════════════════════════

  describe('participant scoping regression safety', () => {
    it('artifacts empty for nonexistent conversation', () => {
      const artifacts = getThreadArtifacts('conv-does-not-exist')
      expect(artifacts.projectArtifacts).toHaveLength(0)
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })

    it('thread not found for nonexistent ID', () => {
      const thread = getMessageThreadById('conv-mrc-nonexistent')
      expect(thread).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13. No regression to plain text messaging
  // ═══════════════════════════════════════════════════════════════════════

  describe('plain text messaging regression safety', () => {
    it('text messages appear in consolidated thread', async () => {
      const threadId = 'conv-mrc-text'
      await addConversation(seedConversation({ id: threadId }))

      addMessage({
        id: 'msg-mrc-text-1',
        conversationId: threadId,
        sender: 'user',
        text: 'Hallo, können Sie mir helfen?',
        sentAt: 1000,
      })
      addMessage({
        id: 'msg-mrc-text-2',
        conversationId: threadId,
        sender: 'counterparty',
        text: 'Ja, gerne!',
        sentAt: 2000,
      })

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(2)
      expect(thread!.messages[0].text).toBe('Hallo, können Sie mir helfen?')
      expect(thread!.messages[1].text).toBe('Ja, gerne!')
    })

    it('messages from duplicate conversations merge into one thread', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-merge-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-merge-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        createdAt: 2000,
      }))

      addMessage({
        id: 'msg-mrc-merge-1',
        conversationId: 'conv-mrc-merge-old',
        sender: 'user',
        text: 'Alte Nachricht',
        sentAt: 500,
      })
      addMessage({
        id: 'msg-mrc-merge-2',
        conversationId: 'conv-mrc-merge-new',
        sender: 'user',
        text: 'Neue Nachricht',
        sentAt: 3000,
      })

      const thread = getMessageThreadById('conv-mrc-merge-new')
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(2)
      // Sorted by sentAt
      expect(thread!.messages[0].text).toBe('Alte Nachricht')
      expect(thread!.messages[1].text).toBe('Neue Nachricht')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 14. No regression to reload/re-entry stability
  // ═══════════════════════════════════════════════════════════════════════

  describe('reload/re-entry stability', () => {
    it('thread data consistent between reads', async () => {
      const threadId = 'conv-mrc-stable'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'Stable Project',
        snapshotStatus: 'request',
      })

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '500 €',
      })

      // Read 1
      const artifacts1 = getThreadArtifacts(threadId)
      // Read 2 (simulates re-entry)
      const artifacts2 = getThreadArtifacts(threadId)

      expect(artifacts1.projectArtifacts).toHaveLength(1)
      expect(artifacts2.projectArtifacts).toHaveLength(1)
      expect(artifacts1.offerPaymentArtifact).not.toBeNull()
      expect(artifacts2.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Inbox preview timestamp correctness
  // ═══════════════════════════════════════════════════════════════════════

  describe('inbox preview timestamp correctness', () => {
    it('timeLabel computed from actual sentAt, not stale string', async () => {
      const sentAt = Date.now()
      const threadId = 'conv-mrc-timestamp-check'

      await addConversation(seedConversation({
        id: threadId,
        timeLabel: 'Stale Value',
        createdAt: sentAt - 100000,
      }))

      addMessage({
        id: 'msg-mrc-ts-1',
        conversationId: threadId,
        sender: 'user',
        text: 'Hello',
        sentAt,
      })

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      // timeLabel should be derived from sentAt, not the stale "Stale Value"
      expect(thread!.timeLabel).toBe(formatMessageTimeLabel(sentAt))
      expect(thread!.timeLabel).not.toBe('Stale Value')
    })

    it('timeLabel falls back to createdAt when no messages', async () => {
      const createdAt = Date.now() - 50000
      const threadId = 'conv-mrc-no-msgs-time'

      await addConversation(seedConversation({
        id: threadId,
        timeLabel: 'Old',
        createdAt,
      }))

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      // Should derive from createdAt since no messages exist
      expect(thread!.timeLabel).toBe(formatMessageTimeLabel(createdAt))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Unified timeline: projects + quotes coexist
  // ═══════════════════════════════════════════════════════════════════════

  describe('unified timeline with projects and quotes', () => {
    it('project and quote artifacts coexist in the same thread', async () => {
      const threadId = 'conv-mrc-unified'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
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

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()

      // Both have chronological timestamps
      expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Relationship group artifacts aggregation
  // ═══════════════════════════════════════════════════════════════════════

  describe('relationship group artifacts aggregation', () => {
    it('artifacts from non-canonical conversation visible in canonical thread', async () => {
      await addConversation(seedConversation({
        id: 'conv-mrc-group-old',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-mrc-group-new',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      await persistProjectArtifact({
        conversationId: 'conv-mrc-group-old',
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'From old conversation',
        snapshotStatus: 'request',
      })

      // Read from canonical (newer) — should include old conversation artifacts
      const artifacts = getThreadArtifacts('conv-mrc-group-new')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('From old conversation')
    })
  })
})
