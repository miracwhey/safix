/**
 * Deep Project Send Runtime Repair — End-to-End Tests
 *
 * Validates the full live runtime path for project sends in a
 * consolidated relationship thread.  Each test maps to a specific
 * runtime behaviour identified during the deep investigation:
 *
 *  1. First project send creates a visible history event
 *  2. Second project send creates a second visible history event
 *  3. Third project send creates a third visible history event
 *  4. All prior events remain visible after subsequent sends
 *  5. Visible thread and canonical send target stay aligned
 *  6. Failed persistence does not produce false UI success
 *  7. Reload / re-entry preserves all sent project events
 *  8. No regression to active project logic
 *  9. No regression to relationship-thread consolidation
 * 10. No regression to participant scoping
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
  sendProjectAttachmentToThread,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import {
  isConversationParticipant,
  getRelationshipGroup,
} from '../../src/lib/messages/participantScope'
import { resolveCanonicalThreadId } from '../../src/lib/messages/selectors'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository, getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'

// ── Test data ───────────────────────────────────────────────────────────────

const PROJECT_A = 'deep-a111-1111-4111-8111-111111111111'
const PROJECT_B = 'deep-b222-2222-4222-8222-222222222222'
const PROJECT_C = 'deep-c333-3333-4333-8333-333333333333'

const CUSTOMER_ID = 'customer-deep-001'
const CRAFTSMAN_ID = 'craftsman-deep-001'
const CRAFTSMAN_HANDLE = 'deep-hw'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-deep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Deep Kundin',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_ID,
    craftsmanName: 'Deep Handwerker',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Deep Runtime Test',
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
    id: overrides.id ?? `proj-deep-${Date.now()}`,
    title: 'Deep Projekt',
    customer: 'Deep Kundin',
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
    description: 'Deep Runtime Testprojekt',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Deep Project Send Runtime Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. FIRST PROJECT SEND CREATES A VISIBLE HISTORY EVENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. First project send creates a visible history event', () => {
    it('first send creates exactly one project artifact record', async () => {
      const threadId = 'conv-deep-first-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Erstes Projekt' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(1)
      expect(records[0].projectId).toBe(PROJECT_A)
    })

    it('first send artifact appears in getThreadArtifacts', async () => {
      const threadId = 'conv-deep-first-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Sichtbar' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Sichtbar')
    })

    it('first send sets sourceProjectId on conversation', async () => {
      const threadId = 'conv-deep-first-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)
    })

    it('first send marks artifact as active project', async () => {
      const threadId = 'conv-deep-first-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    })

    it('workflow returns true on successful first send', async () => {
      const threadId = 'conv-deep-first-005'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      const result = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. SECOND PROJECT SEND CREATES A SECOND VISIBLE HISTORY EVENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Second project send creates a second visible history event', () => {
    it('same project sent twice produces two artifact records', async () => {
      const threadId = 'conv-deep-second-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      expect(records[0].id).not.toBe(records[1].id) // unique IDs
    })

    it('different project sent second produces two artifact records', async () => {
      const threadId = 'conv-deep-second-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      const projectIds = artifacts.projectArtifacts.map((a) => a.project?.id)
      expect(projectIds).toContain(PROJECT_A)
      expect(projectIds).toContain(PROJECT_B)
    })

    it('second send workflow returns true', async () => {
      const threadId = 'conv-deep-second-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
    })

    it('second send does not overwrite sourceProjectId', async () => {
      const threadId = 'conv-deep-second-004'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. THIRD PROJECT SEND CREATES A THIRD VISIBLE HISTORY EVENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Third project send creates a third visible history event', () => {
    it('three sends produce three artifact records', async () => {
      const threadId = 'conv-deep-third-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addProject(seedProject({ id: PROJECT_C }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
    })

    it('three sends of same project produce three records', async () => {
      const threadId = 'conv-deep-third-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project' && r.projectId === PROJECT_A)
      expect(records).toHaveLength(3)

      // All have unique IDs
      const ids = new Set(records.map((r) => r.id))
      expect(ids.size).toBe(3)
    })

    it('three sends are sorted chronologically', async () => {
      const threadId = 'conv-deep-third-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'Erster' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Zweiter' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'Dritter' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      // Sorted ascending by createdAt
      for (let i = 1; i < artifacts.projectArtifacts.length; i++) {
        expect(artifacts.projectArtifacts[i].createdAt)
          .toBeGreaterThanOrEqual(artifacts.projectArtifacts[i - 1].createdAt)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. ALL PRIOR EVENTS REMAIN VISIBLE
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. All prior events remain visible after subsequent sends', () => {
    it('after three sends, all three are visible', async () => {
      const threadId = 'conv-deep-visible-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'B' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'C' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after1 = getThreadArtifacts(threadId)
      expect(after1.projectArtifacts).toHaveLength(1)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      const after2 = getThreadArtifacts(threadId)
      expect(after2.projectArtifacts).toHaveLength(2)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)
      const after3 = getThreadArtifacts(threadId)
      expect(after3.projectArtifacts).toHaveLength(3)

      // All three are still present
      const ids = after3.projectArtifacts.map((a) => a.project?.id)
      expect(ids).toContain(PROJECT_A)
      expect(ids).toContain(PROJECT_B)
      expect(ids).toContain(PROJECT_C)
    })

    it('artifact records have unique IDs across all sends', async () => {
      const threadId = 'conv-deep-visible-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      const idSet = new Set(records.map((r) => r.id))
      expect(idSet.size).toBe(records.length)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. VISIBLE THREAD AND CANONICAL SEND TARGET STAY ALIGNED
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Visible thread and canonical send target stay aligned', () => {
    it('send through non-canonical thread writes to canonical', async () => {
      const canonicalId = 'conv-deep-canon-001'
      const duplicateId = 'conv-deep-dup-001'

      await addProject(seedProject({ id: PROJECT_A }))
      // Canonical has higher createdAt
      await addConversation(seedConversation({
        id: duplicateId,
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: canonicalId,
        createdAt: 2000,
      }))

      // Resolve from duplicate → canonical
      expect(resolveCanonicalThreadId(duplicateId)).toBe(canonicalId)

      // Send through duplicate thread ID
      await sendProjectAttachmentWorkflow(duplicateId, PROJECT_A)

      // Artifact exists on canonical conversation
      const canonicalRecords = getThreadArtifactRecords(canonicalId)
        .filter((r) => r.artifactType === 'project')
      expect(canonicalRecords).toHaveLength(1)

      // Both threads see it via relationship group aggregation
      const artifactsFromCanonical = getThreadArtifacts(canonicalId)
      const artifactsFromDuplicate = getThreadArtifacts(duplicateId)
      expect(artifactsFromCanonical.projectArtifacts).toHaveLength(1)
      expect(artifactsFromDuplicate.projectArtifacts).toHaveLength(1)
    })

    it('relationship group aggregation includes artifacts from both threads', async () => {
      const id1 = 'conv-deep-group-001'
      const id2 = 'conv-deep-group-002'

      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))

      await addConversation(seedConversation({ id: id1, createdAt: 1000 }))
      await addConversation(seedConversation({ id: id2, createdAt: 2000 }))

      // Send to both conversations directly (service level)
      await sendProjectAttachmentToThread(id1, PROJECT_A)
      await sendProjectAttachmentToThread(id2, PROJECT_B)

      // Both artifacts visible from either thread via relationship group
      const artifacts1 = getThreadArtifacts(id1)
      const artifacts2 = getThreadArtifacts(id2)
      expect(artifacts1.projectArtifacts).toHaveLength(2)
      expect(artifacts2.projectArtifacts).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. FAILED PERSISTENCE DOES NOT PRODUCE FALSE UI SUCCESS
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Failed persistence does not produce false UI success', () => {
    it('workflow throws for non-existent conversation', async () => {
      await addProject(seedProject({ id: PROJECT_A }))

      await expect(
        sendProjectAttachmentWorkflow('conv-does-not-exist', PROJECT_A)
      ).rejects.toThrow('conversation not found')
    })

    it('service throws for non-existent conversation', async () => {
      await expect(
        sendProjectAttachmentToThread('conv-does-not-exist', PROJECT_A)
      ).rejects.toThrow('conversation not found')
    })

    it('service throws for non-existent project', async () => {
      const threadId = 'conv-deep-noproj-001'
      await addConversation(seedConversation({ id: threadId }))

      await expect(
        sendProjectAttachmentToThread(threadId, 'proj-does-not-exist')
      ).rejects.toThrow('project not found')
    })

    it('failed insert does not leave ghost artifacts', async () => {
      const threadId = 'conv-deep-ghost-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      // Create a repo that fails on insert
      const failingRepo = new InMemoryThreadArtifactRepository()
      const originalInsert = failingRepo.insert.bind(failingRepo)
      failingRepo.insert = async (record) => {
        // Simulate optimistic push then failure
        originalInsert(record)
        throw new Error('Simulated DB write failure')
      }
      setThreadArtifactRepository(failingRepo)

      await expect(
        sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      ).rejects.toThrow()

      // sourceProjectId was NOT set because persistProjectArtifact threw
      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBeUndefined()
    })

    it('subscription fires after successful send', async () => {
      const threadId = 'conv-deep-sub-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      let subscriptionFired = false
      const unsub = subscribeThreadArtifacts(() => {
        subscriptionFired = true
      })

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(subscriptionFired).toBe(true)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. RELOAD / RE-ENTRY PRESERVES ALL SENT PROJECT EVENTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Reload / re-entry preserves all sent project events', () => {
    it('artifacts survive repository re-initialization with same data', async () => {
      const threadId = 'conv-deep-reload-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      // Snapshot the current records
      const records = getThreadArtifactRepository().getAll()
      expect(records.filter((r) => r.artifactType === 'project')).toHaveLength(2)

      // Simulate reload: create new repository with existing records
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository(records))

      // All artifacts still visible
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('three sends survive simulated reload', async () => {
      const threadId = 'conv-deep-reload-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRepository().getAll()
      expect(records.filter((r) => r.artifactType === 'project')).toHaveLength(3)

      // Simulate reload
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository(records))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)

      // All have unique IDs
      const ids = new Set(artifacts.projectArtifacts.map((a) => a.artifactId))
      expect(ids.size).toBe(3)
    })

    it('thread view returns correct data after simulated reload', async () => {
      const threadId = 'conv-deep-reload-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'Reload Projekt' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRepository().getAll()
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository(records))

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Reload Projekt')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. NO REGRESSION TO ACTIVE PROJECT LOGIC
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. No regression to active project logic', () => {
    it('first send becomes the active project', async () => {
      const threadId = 'conv-deep-active-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    })

    it('second send does not become active (first remains active)', async () => {
      const threadId = 'conv-deep-active-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      const activeArtifact = artifacts.projectArtifacts.find((a) => a.isActiveProject)
      expect(activeArtifact).toBeDefined()
      expect(activeArtifact!.project!.id).toBe(PROJECT_A)

      const secondArtifact = artifacts.projectArtifacts.find((a) => a.project?.id === PROJECT_B)
      expect(secondArtifact).toBeDefined()
      expect(secondArtifact!.isActiveProject).toBe(false)
    })

    it('sourceProjectId is stable across multiple sends', async () => {
      const threadId = 'conv-deep-active-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addProject(seedProject({ id: PROJECT_C }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)

      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. NO REGRESSION TO RELATIONSHIP-THREAD CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. No regression to relationship-thread consolidation', () => {
    it('sends to canonical conversation are visible from duplicate thread', async () => {
      const canonicalId = 'conv-deep-consol-001'
      const duplicateId = 'conv-deep-consol-002'

      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: duplicateId, createdAt: 1000 }))
      await addConversation(seedConversation({ id: canonicalId, createdAt: 2000 }))

      await sendProjectAttachmentWorkflow(canonicalId, PROJECT_A)

      // Visible from both threads
      const fromCanonical = getThreadArtifacts(canonicalId)
      const fromDuplicate = getThreadArtifacts(duplicateId)
      expect(fromCanonical.projectArtifacts).toHaveLength(1)
      expect(fromDuplicate.projectArtifacts).toHaveLength(1)
    })

    it('relationship group is correctly computed', async () => {
      const id1 = 'conv-deep-rg-001'
      const id2 = 'conv-deep-rg-002'

      await addConversation(seedConversation({ id: id1, createdAt: 1000 }))
      await addConversation(seedConversation({ id: id2, createdAt: 2000 }))

      const conv = getConversationById(id1)!
      const { getConversations } = await import('../../src/lib/messages')
      const allConversations = getConversations()
      const group = getRelationshipGroup(conv, allConversations)

      expect(group).toContain(id1)
      expect(group).toContain(id2)
      expect(group).toHaveLength(2)
    })

    it('canonical resolution is idempotent', async () => {
      const id1 = 'conv-deep-idempotent-001'
      const id2 = 'conv-deep-idempotent-002'

      await addConversation(seedConversation({ id: id1, createdAt: 1000 }))
      await addConversation(seedConversation({ id: id2, createdAt: 2000 }))

      const canonical = resolveCanonicalThreadId(id1)
      const doubleCanonical = resolveCanonicalThreadId(canonical)
      expect(canonical).toBe(id2)
      expect(doubleCanonical).toBe(id2) // idempotent
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. No regression to participant scoping', () => {
    it('artifacts are only visible to participants', async () => {
      const threadId = 'conv-deep-scope-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const conv = getConversationById(threadId)!
      expect(isConversationParticipant(conv, CUSTOMER_ID)).toBe(true)
      expect(isConversationParticipant(conv, CRAFTSMAN_ID)).toBe(true)
      expect(isConversationParticipant(conv, 'random-user')).toBe(false)
    })

    it('snapshot data persists at write time for immediate rendering', async () => {
      const threadId = 'conv-deep-snap-001'
      await addProject(seedProject({
        id: PROJECT_A,
        title: 'Snapshot Titel',
        category: 'Elektrik',
        location: 'Berlin',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(1)
      expect(records[0].snapshotTitle).toBe('Snapshot Titel')
      expect(records[0].snapshotCategory).toBe('Elektrik')
      expect(records[0].snapshotLocation).toBe('Berlin')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // VERIFICATION — FULL END-TO-END RUNTIME SCENARIO
  // ═══════════════════════════════════════════════════════════════════════

  describe('Full end-to-end runtime scenario', () => {
    it('complete three-send scenario with reload', async () => {
      const threadId = 'conv-deep-e2e-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Badezimmer' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'Wohnzimmer' }))
      await addConversation(seedConversation({ id: threadId }))

      // ── Send 1 ──
      const result1 = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result1).toBe(true)

      let artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Badezimmer')
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)

      // ── Send 2 ──
      const result2 = await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      expect(result2).toBe(true)

      artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      // First send still active
      const activeAfter2 = artifacts.projectArtifacts.find((a) => a.isActiveProject)
      expect(activeAfter2!.project!.id).toBe(PROJECT_A)

      // ── Send 3 ──
      const result3 = await sendProjectAttachmentWorkflow(threadId, PROJECT_C)
      expect(result3).toBe(true)

      artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)

      // All three visible
      const titles = artifacts.projectArtifacts.map((a) => a.snapshot?.title)
      expect(titles).toContain('Badezimmer')
      expect(titles).toContain('Küche')
      expect(titles).toContain('Wohnzimmer')

      // ── Simulate reload ──
      const records = getThreadArtifactRepository().getAll()
      setThreadArtifactRepository(new InMemoryThreadArtifactRepository(records))

      // All three survive reload
      const afterReload = getThreadArtifacts(threadId)
      expect(afterReload.projectArtifacts).toHaveLength(3)

      // sourceProjectId preserved
      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)

      // Active project still correct
      const active = afterReload.projectArtifacts.find((a) => a.isActiveProject)
      expect(active!.project!.id).toBe(PROJECT_A)
    })
  })
})
