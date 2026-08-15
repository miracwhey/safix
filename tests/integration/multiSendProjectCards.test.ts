/**
 * Multi-Send Project Cards in Thread — End-to-End Tests
 *
 * Validates the append-only multi-send project card model:
 *
 *  1. Inquiry from profile does NOT auto-send generic text
 *  2. Inquiry from profile opens the correct thread directly
 *  3. Customer can still write/send plain text manually
 *  4. Customer can send one project card into the thread
 *  5. Customer can send multiple project cards into the same thread
 *  6. All sent project cards remain visible in stable order
 *  7. Reload/re-entry preserves all sent project cards for both participants
 *  8. Participant scoping still holds
 *  9. No regression to offer/payment artifact rendering
 * 10. No regression to auth/bootstrap foundation
 */

import path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installMockSession, mockCustomerSession, resetMockSession } from '../helpers/mockSession'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getThreadArtifactRecords,
  getMessageThreadById,
  subscribeThreadArtifacts,
  persistOfferArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendDirectMessageWorkflow,
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'
import { startProfileInquiryWorkflow } from '../../src/lib/workflow/exploreInquiryWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_UUID_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const PROJECT_UUID_C = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-ms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Multi-Send Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-ms-001',
    craftsmanName: 'Multi-Send Handwerker',
    craftsmanHandle: 'ms-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-ms-001',
    projectTitle: 'Multi-Send Test',
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
    id: overrides.id ?? `proj-ms-${Date.now()}`,
    title: 'Badezimmer Renovierung',
    customer: 'Multi-Send Kundin',
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
    category: 'Sanitär',
    description: 'Komplettrenovierung des Badezimmers',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Multi-Send Project Cards in Thread', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. INQUIRY FROM PROFILE DOES NOT AUTO-SEND GENERIC TEXT
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Profile inquiry does not auto-send generic text', () => {
    beforeEach(() => { installMockSession(mockCustomerSession('customer-ms-001')) })
    afterEach(() => { resetMockSession() })

    it('startProfileInquiryWorkflow creates thread with no messages', async () => {
      const threadId = await startProfileInquiryWorkflow({
        craftsmanId: 'craft-profile-001',
        craftsmanName: 'Max Meister',
        craftsmanHandle: 'max-meister-notext',
        craftsmanAvatarUrl: '',
        location: 'München',
      })

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      // No auto-text message — thread should have zero messages
      expect(thread!.messages).toHaveLength(0)
    })

    it('conversation is created with correct metadata despite no auto-text', async () => {
      const threadId = await startProfileInquiryWorkflow({
        craftsmanId: 'craft-profile-002',
        craftsmanName: 'Lisa Lack',
        craftsmanHandle: 'lisa-lack-notext',
        craftsmanAvatarUrl: '',
        location: 'Hamburg',
      })

      const conv = getConversationById(threadId)
      expect(conv).toBeDefined()
      expect(conv!.craftsmanName).toBe('Lisa Lack')
      expect(conv!.inquiryOrigin).toBe('profile')
      expect(conv!.projectLocation).toBe('Hamburg')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. INQUIRY FROM PROFILE OPENS THE CORRECT THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Inquiry opens the correct thread directly', () => {
    beforeEach(() => { installMockSession(mockCustomerSession('customer-ms-001')) })
    afterEach(() => { resetMockSession() })

    it('returns a valid thread ID', async () => {
      const threadId = await startProfileInquiryWorkflow({
        craftsmanId: 'craft-direct-001',
        craftsmanName: 'Fritz Flink',
        craftsmanHandle: 'fritz-flink-direct',
        craftsmanAvatarUrl: '',
        location: 'Berlin',
      })

      expect(threadId).toBeDefined()
      expect(typeof threadId).toBe('string')
      expect(threadId.length).toBeGreaterThan(0)

      // Thread exists and is navigable
      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. CUSTOMER CAN WRITE PLAIN TEXT MANUALLY
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Customer can write/send plain text manually', () => {
    it('customer can send plain text message after profile inquiry', async () => {
      const threadId = 'conv-ms-text-001'
      await addConversation(seedConversation({ id: threadId }))

      await sendDirectMessageWorkflow(threadId, 'Hallo, ich brauche Hilfe')

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].text).toBe('Hallo, ich brauche Hilfe')
    })

    it('customer can send multiple text messages', async () => {
      const threadId = 'conv-ms-text-002'
      await addConversation(seedConversation({ id: threadId }))

      await sendDirectMessageWorkflow(threadId, 'Nachricht 1')
      await sendDirectMessageWorkflow(threadId, 'Nachricht 2')
      await sendDirectMessageWorkflow(threadId, 'Nachricht 3')

      const thread = getMessageThreadById(threadId)
      expect(thread!.messages).toHaveLength(3)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. CUSTOMER CAN SEND ONE PROJECT CARD
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Customer can send one project card', () => {
    it('single project card send creates artifact and message', async () => {
      const threadId = 'conv-ms-single-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Einzelprojekt' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // Artifact exists
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_UUID_A)
      expect(artifacts.projectArtifacts[0].artifactId).toBeDefined()

      // Backward-compat accessor
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project!.id).toBe(PROJECT_UUID_A)
    })

    it('project card has correct snapshot data', async () => {
      const threadId = 'conv-ms-single-002'
      await addProject(seedProject({
        id: PROJECT_UUID_A,
        title: 'Dachsanierung',
        status: 'request',
        category: 'Dachdecker',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const artifacts = getThreadArtifacts(threadId)
      const card = artifacts.projectArtifacts[0]
      expect(card.snapshot).not.toBeNull()
      expect(card.snapshot!.title).toBe('Dachsanierung')
      expect(card.snapshot!.status).toBe('request')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. CUSTOMER CAN SEND MULTIPLE PROJECT CARDS
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Customer can send multiple project cards into the same thread', () => {
    it('two different projects produce two separate artifact records', async () => {
      const threadId = 'conv-ms-multi-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Projekt A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Projekt B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_UUID_A)
      expect(artifacts.projectArtifacts[1].project!.id).toBe(PROJECT_UUID_B)
    })

    it('same project sent twice creates two separate artifacts', async () => {
      const threadId = 'conv-ms-multi-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Gleich' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      // Both reference the same project but have different artifact IDs
      expect(artifacts.projectArtifacts[0].artifactId).not.toBe(
        artifacts.projectArtifacts[1].artifactId
      )
    })

    it('three different projects all visible in correct order', async () => {
      const threadId = 'conv-ms-multi-003'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
      await addProject(seedProject({ id: PROJECT_UUID_C, title: 'Garten' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts[0].project!.title).toBe('Küche')
      expect(artifacts.projectArtifacts[1].project!.title).toBe('Bad')
      expect(artifacts.projectArtifacts[2].project!.title).toBe('Garten')
    })

    it('each artifact has unique ID and timestamp', async () => {
      const threadId = 'conv-ms-multi-004'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')

      expect(records).toHaveLength(2)
      expect(records[0].id).not.toBe(records[1].id)
    })

    it('backward-compat projectArtifact returns first card', async () => {
      const threadId = 'conv-ms-multi-005'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      // projectArtifact (singular) is the first in the array
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project!.id).toBe(PROJECT_UUID_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. ALL SENT PROJECT CARDS REMAIN IN STABLE ORDER
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. All sent project cards remain visible in stable order', () => {
    it('multiple reads return same artifacts in same order', async () => {
      const threadId = 'conv-ms-order-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'X' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Y' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const read1 = getThreadArtifacts(threadId)
      const read2 = getThreadArtifacts(threadId)
      const read3 = getThreadArtifacts(threadId)

      expect(read1.projectArtifacts).toHaveLength(2)
      expect(read2.projectArtifacts).toHaveLength(2)
      expect(read3.projectArtifacts).toHaveLength(2)

      // Order is stable across reads
      expect(read1.projectArtifacts[0].artifactId).toBe(read2.projectArtifacts[0].artifactId)
      expect(read1.projectArtifacts[1].artifactId).toBe(read2.projectArtifacts[1].artifactId)
    })

    it('project cards remain visible alongside text messages', async () => {
      const threadId = 'conv-ms-order-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendDirectMessageWorkflow(threadId, 'Vor dem Projekt')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendDirectMessageWorkflow(threadId, 'Nach dem Projekt')

      const thread = getMessageThreadById(threadId)
      const artifacts = getThreadArtifacts(threadId)

      // Both text messages and project card are visible
      expect(thread!.messages.length).toBeGreaterThanOrEqual(2)
      expect(artifacts.projectArtifacts).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. RELOAD / RE-ENTRY PRESERVES ALL SENT PROJECT CARDS
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Reload/re-entry preserves all sent project cards', () => {
    it('customer reload: all project cards remain visible', async () => {
      const threadId = 'conv-ms-reload-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Simulate reload by re-reading from repository
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      expect(artifacts.projectArtifacts[0].persistenceStatus).toBe('confirmed')
      expect(artifacts.projectArtifacts[1].persistenceStatus).toBe('confirmed')
    })

    it('craftsman reload: all project cards remain visible', async () => {
      const threadId = 'conv-ms-reload-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-reload',
        craftsmanUserId: 'craft-reload',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Both participants see the same artifacts
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('thread re-entry: all project cards persist', async () => {
      const threadId = 'conv-ms-reentry-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Persistent A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Persistent B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // First read (entry)
      const first = getThreadArtifacts(threadId)
      expect(first.projectArtifacts).toHaveLength(2)

      // Second read (re-entry)
      const second = getThreadArtifacts(threadId)
      expect(second.projectArtifacts).toHaveLength(2)
      expect(second.projectArtifacts[0].snapshot!.title).toBe('Persistent A')
      expect(second.projectArtifacts[1].snapshot!.title).toBe('Persistent B')
    })

    it('subscription notifies on each new project card send', async () => {
      const threadId = 'conv-ms-sub-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      let notificationCount = 0
      const unsub = subscribeThreadArtifacts(() => { notificationCount++ })

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      expect(notificationCount).toBeGreaterThanOrEqual(1)

      const before = notificationCount
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      expect(notificationCount).toBeGreaterThan(before)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. PARTICIPANT SCOPING STILL HOLDS
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. Participant scoping still holds', () => {
    it('only participants can see the conversation', async () => {
      const conv = seedConversation({
        id: 'conv-ms-scope-001',
        customerUserId: 'cust-A',
        craftsmanUserId: 'craft-B',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-A')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-B')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('project card artifacts carry participant user IDs', async () => {
      const threadId = 'conv-ms-scope-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-scope',
        craftsmanUserId: 'craft-scope',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(1)
      expect(records[0].customerUserId).toBe('cust-scope')
      expect(records[0].craftsmanUserId).toBe('craft-scope')
    })

    it('multi-send artifacts all carry correct participant IDs', async () => {
      const threadId = 'conv-ms-scope-003'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-multi-scope',
        craftsmanUserId: 'craft-multi-scope',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      for (const record of records) {
        expect(record.customerUserId).toBe('cust-multi-scope')
        expect(record.craftsmanUserId).toBe('craft-multi-scope')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. NO REGRESSION TO OFFER/PAYMENT ARTIFACT RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. No regression to offer/payment artifact rendering', () => {
    it('offer artifact is independent of project artifacts', async () => {
      const threadId = 'conv-ms-offer-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      // Send project card
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // Create offer artifact (independent)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-ms-001',
        phase: 'sent',
        snapshotPrice: '5.000 €',
        snapshotSummary: 'Angebot für Badezimmer',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot!.price).toBe('5.000 €')
    })

    it('multiple project cards and one offer coexist', async () => {
      const threadId = 'conv-ms-offer-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-ms-002',
        phase: 'sent',
        snapshotPrice: '8.000 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })

    it('offer upsert does not affect project artifacts', async () => {
      const threadId = 'conv-ms-offer-003'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // Create and update offer
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-ms-003',
        phase: 'sent',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-ms-003',
        phase: 'accepted',
      })

      const artifacts = getThreadArtifacts(threadId)
      // Project artifact unchanged
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_UUID_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. NO REGRESSION TO AUTH/BOOTSTRAP FOUNDATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. No regression to auth/bootstrap foundation', () => {
    it('thread without any artifacts returns empty projectArtifacts array', () => {
      const threadId = 'conv-ms-empty-001'
      addConversation(seedConversation({ id: threadId }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toEqual([])
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
      expect(artifacts.pendingProjectArtifact).toBe(false)
      expect(artifacts.pendingOfferArtifact).toBe(false)
    })

    it('non-existent thread returns empty artifacts', () => {
      const artifacts = getThreadArtifacts('does-not-exist')
      expect(artifacts.projectArtifacts).toEqual([])
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('screen source uses single active project for top context rendering', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/messages/ThreadArtifactCards.tsx'),
        'utf-8'
      )

      // Top context renders only the active project, not all artifacts
      expect(screenSource).toContain('activeProject')
      expect(screenSource).toContain('isActiveProject')

      // Does NOT collapse to single artifact (backward-compat field)
      expect(screenSource).not.toContain('projectArtifact &&')
    })

    it('screen source has project-send CTA always available for customer', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      // CTA is always available (no hasProjectAttached gating)
      expect(screenSource).not.toContain('hasProjectAttached')
      expect(screenSource).toContain("role === 'customer'")
      // thread-attach-project data-testid is in ChatComposer tile; screen gates attach via role check
      expect(screenSource).toContain('showProjectPicker')
    })
  })
})
