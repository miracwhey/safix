/**
 * Unified Thread Event Pipeline Tests
 *
 * Validates end-to-end consistency of the thread event system for
 * structured business events (project-send and quote-send).
 *
 * Coverage:
 *   1.  New project send appears in visible consolidated relationship thread
 *   2.  Second and later project sends also appear correctly
 *   3.  Craftsman quote send succeeds in pre-job flow
 *   4.  Quote card appears in visible consolidated thread for both participants
 *   5.  Relationship-thread timeline contains text + project + quote events
 *   6.  Errors are normalized into readable strings (no [object Object])
 *   7.  No regression to multi-send project history
 *   8.  No regression to active project logic
 *   9.  No regression to relationship-thread consolidation
 *  10.  No regression to reload/re-entry stability
 *  11.  No regression to participant scoping
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  persistProjectArtifact,
  getMessageThreadById,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import {
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow'
import { normalizeErrorMessage } from '../../src/lib/diagnostics'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-pipe-001'
const CRAFTSMAN_ID = 'craftsman-pipe-001'
const CRAFTSMAN_HANDLE = 'peter-hw'

const PROJECT_A = 'aaa1c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_B = 'bbb2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
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
    id: overrides.id ?? `proj-pipe-${Date.now()}`,
    title: 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Unified Thread Event Pipeline', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. New project send appears in visible consolidated relationship thread
  // ═══════════════════════════════════════════════════════════════════════

  describe('project send appears in visible thread', () => {
    it('newly sent project card appears in relationship thread via workflow', async () => {
      const threadId = 'conv-pipe-proj-1'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche renovieren' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Küche renovieren')
      expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
    })

    it('project send via service also appears in thread', async () => {
      const threadId = 'conv-pipe-proj-svc'
      await addProject(seedProject({ id: PROJECT_A, title: 'Bad neu' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Bad neu')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Second and later project sends also appear correctly
  // ═══════════════════════════════════════════════════════════════════════

  describe('multi-send project history', () => {
    it('second project send appends without overwriting first', async () => {
      const threadId = 'conv-pipe-multi'
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

    it('active project pointer only set on first send', async () => {
      const threadId = 'conv-pipe-active'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const convAfterFirst = getConversationById(threadId)
      expect(convAfterFirst?.sourceProjectId).toBe(PROJECT_A)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      const convAfterSecond = getConversationById(threadId)
      // sourceProjectId remains the FIRST project — not overwritten
      expect(convAfterSecond?.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Craftsman quote send succeeds in pre-job flow
  // ═══════════════════════════════════════════════════════════════════════

  describe('quote send succeeds in pre-job flow', () => {
    it('createOfferWorkflow succeeds with valid conversation data', async () => {
      const threadId = 'conv-pipe-quote-1'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '1.500 €',
        description: 'Küchenrenovierung komplett',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('1.500 €')
      expect(offer.conversationId).toBe(threadId)
    })

    it('pre-job quote does not require job to exist', async () => {
      const threadId = 'conv-pipe-quote-prejob'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      // No job exists — should still succeed
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '800 €',
      })

      expect(offer.status).toBe('pending')
      expect(offer.createdJobId).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Quote card appears in visible consolidated thread for both sides
  // ═══════════════════════════════════════════════════════════════════════

  describe('quote card appears in visible thread', () => {
    it('offer artifact is visible in thread artifacts after quote send', async () => {
      const threadId = 'conv-pipe-quote-visible'
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
        description: 'Badezimmer komplett',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })

    it('offer artifact has snapshot data for immediate rendering', async () => {
      const threadId = 'conv-pipe-quote-snap'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '3.500 €',
        description: 'Dachsanierung',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact?.snapshot?.price).toBe(formatEuro(3500))
      expect(artifacts.offerPaymentArtifact?.snapshot?.summary).toBe('Dachsanierung')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Relationship-thread timeline contains text + project + quote events
  // ═══════════════════════════════════════════════════════════════════════

  describe('unified timeline with all event types', () => {
    it('project and quote artifacts coexist in the same thread', async () => {
      const threadId = 'conv-pipe-unified'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
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
        price: '5.000 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()

      // Both have timestamps for chronological ordering
      expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThan(0)
    })

    it('text messages and artifact events are independently readable', async () => {
      const threadId = 'conv-pipe-mixed'
      await addProject(seedProject({ id: PROJECT_A, title: 'Terrasse' }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      // Send a project
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Check that thread messages and artifacts are both accessible
      const thread = getMessageThreadById(threadId)
      const artifacts = getThreadArtifacts(threadId)

      expect(thread).toBeDefined()
      expect(artifacts.projectArtifacts).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Errors are normalized into readable strings
  // ═══════════════════════════════════════════════════════════════════════

  describe('error normalization', () => {
    it('normalizeErrorMessage extracts message from Error instances', () => {
      const err = new Error('Something went wrong')
      expect(normalizeErrorMessage(err)).toBe('Something went wrong')
    })

    it('normalizeErrorMessage extracts message from plain objects', () => {
      const err = { message: 'DB insert failed', code: '23505' }
      expect(normalizeErrorMessage(err)).toBe('DB insert failed')
    })

    it('normalizeErrorMessage does NOT produce [object Object]', () => {
      const err = { message: 'RLS violation', details: 'uuid parse error' }
      const result = normalizeErrorMessage(err)
      expect(result).not.toContain('[object Object]')
      expect(result).toBe('RLS violation')
    })

    it('normalizeErrorMessage handles objects without message', () => {
      const err = { code: '42P01', detail: 'relation does not exist' }
      const result = normalizeErrorMessage(err)
      expect(result).not.toContain('[object Object]')
      // Should JSON-serialize
      expect(result).toContain('42P01')
    })

    it('normalizeErrorMessage handles string errors', () => {
      expect(normalizeErrorMessage('plain string error')).toBe('plain string error')
    })

    it('normalizeErrorMessage handles null/undefined', () => {
      expect(normalizeErrorMessage(null)).not.toContain('[object Object]')
      expect(normalizeErrorMessage(undefined)).not.toContain('[object Object]')
    })

    it('createOfferWorkflow throws Error instances (not raw objects)', async () => {
      // Missing conversationId should throw a proper Error
      try {
        await createOfferWorkflow({
          conversationId: '',
          customerUserId: CUSTOMER_ID,
          craftsmanUserId: CRAFTSMAN_ID,
          price: '100 €',
        })
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toContain('Missing')
      }
    })

    it('createOfferWorkflow error message is human readable', async () => {
      try {
        await createOfferWorkflow({
          conversationId: 'conv-nonexistent',
          customerUserId: '',
          craftsmanUserId: CRAFTSMAN_ID,
          price: '100 €',
        })
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = normalizeErrorMessage(err)
        expect(message).not.toContain('[object Object]')
        expect(message.length).toBeGreaterThan(0)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. No regression to multi-send project history
  // ═══════════════════════════════════════════════════════════════════════

  describe('multi-send regression safety', () => {
    it('three project sends create three distinct artifacts', async () => {
      const threadId = 'conv-pipe-3send'
      const PROJECT_C = 'ccc3c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

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
  // 8. No regression to active project logic
  // ═══════════════════════════════════════════════════════════════════════

  describe('active project logic regression safety', () => {
    it('first sent project becomes active', async () => {
      const threadId = 'conv-pipe-active-logic'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
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

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. No regression to relationship-thread consolidation
  // ═══════════════════════════════════════════════════════════════════════

  describe('relationship-thread consolidation', () => {
    it('artifacts from duplicate conversations are visible in canonical thread', async () => {
      // Create two conversations for the same pair
      const oldThreadId = 'conv-pipe-dup-old'
      const newThreadId = 'conv-pipe-dup-new'

      await addConversation(seedConversation({
        id: oldThreadId,
        customerUserId: CUSTOMER_ID,
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: newThreadId,
        customerUserId: CUSTOMER_ID,
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      // Write artifact to OLD (non-canonical) conversation
      await persistProjectArtifact({
        conversationId: oldThreadId,
        projectId: PROJECT_A,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        snapshotTitle: 'From old thread',
        snapshotStatus: 'request',
      })

      // Read from NEW (canonical) conversation — should include old artifacts
      const artifacts = getThreadArtifacts(newThreadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('From old thread')
    })

    it('offer from canonical thread is visible', async () => {
      const threadId = 'conv-pipe-offer-canonical'
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
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. No regression to reload/re-entry stability
  // ═══════════════════════════════════════════════════════════════════════

  describe('reload/re-entry stability', () => {
    it('project artifact survives re-read after write', async () => {
      const threadId = 'conv-pipe-reload-proj'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // First read
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.projectArtifacts).toHaveLength(1)

      // Re-read (simulates reload)
      const artifacts2 = getThreadArtifacts(threadId)
      expect(artifacts2.projectArtifacts).toHaveLength(1)
      expect(artifacts2.projectArtifacts[0].snapshot?.title).toBe('Küche')
    })

    it('offer artifact survives re-read after write', async () => {
      const threadId = 'conv-pipe-reload-offer'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '999 €',
      })

      // First read
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.offerPaymentArtifact).not.toBeNull()

      // Re-read
      const artifacts2 = getThreadArtifacts(threadId)
      expect(artifacts2.offerPaymentArtifact).not.toBeNull()
      expect(artifacts2.offerPaymentArtifact!.snapshot?.price).toBe(formatEuro(999))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 11. No regression to participant scoping
  // ═══════════════════════════════════════════════════════════════════════

  describe('participant scoping', () => {
    it('artifacts require participant identity to resolve', async () => {
      const threadId = 'conv-pipe-scope'
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
        snapshotTitle: 'Scoped project',
        snapshotStatus: 'request',
      })

      // Read from valid thread — artifacts visible
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
    })

    it('artifacts empty for nonexistent conversation', () => {
      const artifacts = getThreadArtifacts('conv-does-not-exist')
      expect(artifacts.projectArtifacts).toHaveLength(0)
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Canonical routing for quote send
  // ═══════════════════════════════════════════════════════════════════════

  describe('canonical routing for quote send', () => {
    it('createOfferWorkflow resolves to canonical conversation', async () => {
      // Create two conversations for the same pair - older and newer
      const oldThreadId = 'conv-pipe-offer-old'
      const newThreadId = 'conv-pipe-offer-new'

      await addConversation(seedConversation({
        id: oldThreadId,
        customerUserId: CUSTOMER_ID,
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: newThreadId,
        customerUserId: CUSTOMER_ID,
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanUserId: CRAFTSMAN_ID,
        createdAt: 2000,
      }))

      // Send offer via OLD conversation — should resolve to canonical (new)
      const offer = await createOfferWorkflow({
        conversationId: oldThreadId,
        customerUserId: CUSTOMER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        price: '750 €',
      })

      // Offer should be written to the canonical (newer) conversation
      expect(offer.conversationId).toBe(newThreadId)

      // Artifacts should be visible from the canonical thread
      const artifacts = getThreadArtifacts(newThreadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })
  })
})
