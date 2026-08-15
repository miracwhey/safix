/**
 * Project Resend Event Visibility — End-to-End Tests
 *
 * Validates that every project send (including resends of the same project)
 * creates a new, visible, append-only history event in the consolidated
 * relationship thread.
 *
 *  1. Repeated project sends create multiple artifact events
 *  2. Repeated project sends appear in visible consolidated thread
 *  3. Prior project-send events remain visible after subsequent sends
 *  4. Active project context remains separate from history
 *  5. Reload/re-entry preserves all project-send events
 *  6. No regression to participant scoping
 *  7. No regression to relationship-thread consolidation
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getThreadArtifactRecords,
  getMessageThreadById,
  subscribeThreadArtifacts,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
  sendDirectMessageWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import { isConversationParticipant, getRelationshipGroup } from '../../src/lib/messages/participantScope'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_A = 'aa111111-1111-4111-8111-111111111111'
const PROJECT_B = 'bb222222-2222-4222-8222-222222222222'
const PROJECT_C = 'cc333333-3333-4333-8333-333333333333'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-rv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Resend Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-rv-001',
    craftsmanName: 'Resend Handwerker',
    craftsmanHandle: 'rv-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-rv-001',
    projectTitle: 'Resend Test',
    projectSubtitle: 'Anfrage',
    projectLocation: 'München',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-rv-${Date.now()}`,
    title: 'Test Projekt',
    customer: 'Resend Kundin',
    craftsman: '',
    location: 'München',
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
    description: 'Testprojekt',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Project Resend Event Visibility', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. REPEATED PROJECT SENDS CREATE MULTIPLE ARTIFACT EVENTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Repeated project sends create multiple artifact events', () => {
    it('same project sent twice produces two distinct artifact records', async () => {
      const threadId = 'conv-rv-resend-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      // Different artifact IDs
      expect(records[0].id).not.toBe(records[1].id)
      // Same projectId
      expect(records[0].projectId).toBe(PROJECT_A)
      expect(records[1].projectId).toBe(PROJECT_A)
    })

    it('same project sent three times produces three artifacts', async () => {
      const threadId = 'conv-rv-resend-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Dach' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      // All reference the same project
      for (const a of artifacts.projectArtifacts) {
        expect(a.project!.id).toBe(PROJECT_A)
      }
      // All have unique artifactIds
      const ids = artifacts.projectArtifacts.map((a) => a.artifactId)
      expect(new Set(ids).size).toBe(3)
    })

    it('different projects sent alternately all create separate artifacts', async () => {
      const threadId = 'conv-rv-resend-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_A)
      expect(artifacts.projectArtifacts[1].project!.id).toBe(PROJECT_B)
      expect(artifacts.projectArtifacts[2].project!.id).toBe(PROJECT_A)
    })

    it('each artifact has a monotonically increasing createdAt', async () => {
      const threadId = 'conv-rv-resend-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      for (let i = 1; i < artifacts.projectArtifacts.length; i++) {
        expect(artifacts.projectArtifacts[i].createdAt)
          .toBeGreaterThanOrEqual(artifacts.projectArtifacts[i - 1].createdAt)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. REPEATED PROJECT SENDS APPEAR IN VISIBLE CONSOLIDATED THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Repeated project sends appear in visible consolidated thread', () => {
    it('getThreadArtifacts returns all resent project artifacts', async () => {
      const threadId = 'conv-rv-visible-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Sichtbar A' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Sichtbar B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      // Snapshots are populated for immediate rendering
      for (const a of artifacts.projectArtifacts) {
        expect(a.snapshot).not.toBeNull()
        expect(a.snapshot!.title).toBeTruthy()
      }
    })

    it('resent artifacts carry snapshot data for immediate rendering', async () => {
      const threadId = 'conv-rv-visible-002'
      await addProject(seedProject({
        id: PROJECT_A,
        title: 'Garten',
        category: 'Gartenbau',
        location: 'Köln',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      // Both carry the same snapshot data
      for (const a of artifacts.projectArtifacts) {
        expect(a.snapshot!.title).toBe('Garten')
        expect(a.snapshot!.category).toBe('Gartenbau')
        expect(a.snapshot!.location).toBe('Köln')
      }
    })

    it('project artifacts appear alongside text messages in the thread', async () => {
      const threadId = 'conv-rv-visible-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendDirectMessageWorkflow(threadId, 'Hallo')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Hier mein Projekt')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Nochmal gesendet')

      const thread = getMessageThreadById(threadId)
      const artifacts = getThreadArtifacts(threadId)

      // 3 text messages (attachment messages have empty text and are filtered)
      const textMessages = thread!.messages.filter((m) => m.text.trim())
      expect(textMessages.length).toBeGreaterThanOrEqual(3)

      // 2 project artifact events
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('subscription fires for each resend artifact creation', async () => {
      const threadId = 'conv-rv-visible-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      let notifyCount = 0
      const unsub = subscribeThreadArtifacts(() => { notifyCount++ })

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after1 = notifyCount
      expect(after1).toBeGreaterThanOrEqual(1)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after2 = notifyCount
      expect(after2).toBeGreaterThan(after1)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after3 = notifyCount
      expect(after3).toBeGreaterThan(after2)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PRIOR PROJECT-SEND EVENTS REMAIN VISIBLE
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Prior project-send events remain visible after subsequent sends', () => {
    it('first project card is still visible after second send', async () => {
      const threadId = 'conv-rv-prior-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'First' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const afterFirst = getThreadArtifacts(threadId)
      expect(afterFirst.projectArtifacts).toHaveLength(1)
      const firstArtifactId = afterFirst.projectArtifacts[0].artifactId

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const afterSecond = getThreadArtifacts(threadId)
      expect(afterSecond.projectArtifacts).toHaveLength(2)

      // First artifact is still present with the same ID
      expect(afterSecond.projectArtifacts.some((a) => a.artifactId === firstArtifactId)).toBe(true)
    })

    it('all three sends remain visible when interleaved with text', async () => {
      const threadId = 'conv-rv-prior-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Repeated' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Zwischennachricht 1')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Zwischennachricht 2')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)

      // No artifact was overwritten or collapsed
      const ids = new Set(artifacts.projectArtifacts.map((a) => a.artifactId))
      expect(ids.size).toBe(3)
    })

    it('different project sends do not replace earlier project sends', async () => {
      const threadId = 'conv-rv-prior-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'Garten' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts[0].snapshot!.title).toBe('Küche')
      expect(artifacts.projectArtifacts[1].snapshot!.title).toBe('Bad')
      expect(artifacts.projectArtifacts[2].snapshot!.title).toBe('Garten')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. ACTIVE PROJECT CONTEXT REMAINS SEPARATE FROM HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Active project context remains separate from history', () => {
    it('sourceProjectId is set only on first send', async () => {
      const threadId = 'conv-rv-active-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after1 = getConversationById(threadId)
      expect(after1!.sourceProjectId).toBe(PROJECT_A)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      const after2 = getConversationById(threadId)
      // sourceProjectId remains the first project — NOT overwritten
      expect(after2!.sourceProjectId).toBe(PROJECT_A)
    })

    it('resending same project does not change sourceProjectId', async () => {
      const threadId = 'conv-rv-active-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)
    })

    it('active project flag is separate from artifact visibility', async () => {
      const threadId = 'conv-rv-active-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)

      // First project is active (sourceProjectId was set on first send)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)

      // Both are visible regardless of active status
      expect(artifacts.projectArtifacts[0].persistenceStatus).toBe('confirmed')
      expect(artifacts.projectArtifacts[1].persistenceStatus).toBe('confirmed')
    })

    it('all resent artifacts are visible even when active pointer stays fixed', async () => {
      const threadId = 'conv-rv-active-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      // Active project pointer hasn't suppressed any history event
      // All three share the same projectId, and all are visible
      for (const a of artifacts.projectArtifacts) {
        expect(a.project!.id).toBe(PROJECT_A)
        expect(a.persistenceStatus).toBe('confirmed')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. RELOAD / RE-ENTRY PRESERVES ALL PROJECT-SEND EVENTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Reload/re-entry preserves all project-send events', () => {
    it('all artifacts survive multiple re-reads (simulated reload)', async () => {
      const threadId = 'conv-rv-reload-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Simulate multiple reloads / re-entries
      for (let i = 0; i < 5; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifacts).toHaveLength(3)
      }
    })

    it('re-entry via getMessageThreadById preserves artifacts', async () => {
      const threadId = 'conv-rv-reload-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Persistent' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Re-read thread and artifacts (simulating screen re-entry)
      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      expect(artifacts.projectArtifacts[0].snapshot!.title).toBe('Persistent')
      expect(artifacts.projectArtifacts[1].snapshot!.title).toBe('Persistent')
    })

    it('artifacts retain stable order across re-reads', async () => {
      const threadId = 'conv-rv-reload-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const read1 = getThreadArtifacts(threadId)
      const read2 = getThreadArtifacts(threadId)

      expect(read1.projectArtifacts).toHaveLength(3)
      expect(read2.projectArtifacts).toHaveLength(3)

      for (let i = 0; i < 3; i++) {
        expect(read1.projectArtifacts[i].artifactId)
          .toBe(read2.projectArtifacts[i].artifactId)
      }
    })

    it('both participants see all project-send events', async () => {
      const threadId = 'conv-rv-reload-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-rv-both',
        craftsmanUserId: 'craft-rv-both',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      // Both artifact records carry participant IDs
      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      for (const r of records) {
        expect(r.customerUserId).toBe('cust-rv-both')
        expect(r.craftsmanUserId).toBe('craft-rv-both')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. No regression to participant scoping', () => {
    it('isConversationParticipant correctly scopes visibility', async () => {
      const conv = seedConversation({
        id: 'conv-rv-scope-001',
        customerUserId: 'cust-rv-scope',
        craftsmanUserId: 'craft-rv-scope',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-rv-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-rv-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'unrelated-user')).toBe(false)
    })

    it('resend artifacts carry correct participant user IDs', async () => {
      const threadId = 'conv-rv-scope-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-rv-scope-2',
        craftsmanUserId: 'craft-rv-scope-2',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      for (const r of records) {
        expect(r.customerUserId).toBe('cust-rv-scope-2')
        expect(r.craftsmanUserId).toBe('craft-rv-scope-2')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION TO RELATIONSHIP-THREAD CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. No regression to relationship-thread consolidation', () => {
    it('artifacts from duplicate conversations appear in consolidated thread', async () => {
      // Create two conversations for the same pair (duplicate relationship)
      const threadId1 = 'conv-rv-consol-001'
      const threadId2 = 'conv-rv-consol-002'

      await addProject(seedProject({ id: PROJECT_A, title: 'Consolidated' }))
      await addConversation(seedConversation({
        id: threadId1,
        customerUserId: 'cust-rv-consol',
        craftsmanHandle: 'hw-consol',
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: threadId2,
        customerUserId: 'cust-rv-consol',
        craftsmanHandle: 'hw-consol',
        createdAt: 2000,
      }))

      // Send project to the first (non-canonical) conversation
      await sendProjectAttachmentWorkflow(threadId1, PROJECT_A)

      // The canonical conversation (most recently created) should see
      // the artifact via relationship group aggregation
      const groupIds = getRelationshipGroup(
        getConversationById(threadId2)!,
        [getConversationById(threadId1)!, getConversationById(threadId2)!]
      )
      expect(groupIds).toContain(threadId1)
      expect(groupIds).toContain(threadId2)

      // getThreadArtifacts for the canonical thread should include artifacts
      // from the non-canonical conversation
      const artifacts = getThreadArtifacts(threadId2)
      expect(artifacts.projectArtifacts.length).toBeGreaterThanOrEqual(1)
    })

    it('resend to canonical thread visible from canonical thread', async () => {
      const threadId = 'conv-rv-consol-010'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      // Multiple resends all go to the same canonical thread
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      expect(thread!.id).toBe(threadId)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('workflow post-write verification confirms artifact records for resends', async () => {
      const threadId = 'conv-rv-consol-020'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      // First send
      const result1 = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result1).toBe(true)

      // Second send (resend) — should also succeed
      const result2 = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result2).toBe(true)

      // Verify both artifact records exist
      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project' && r.projectId === PROJECT_A)
      expect(records).toHaveLength(2)
    })
  })
})
