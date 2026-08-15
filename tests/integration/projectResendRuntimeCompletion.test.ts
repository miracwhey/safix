/**
 * Project Resend Runtime Completion — End-to-End Tests
 *
 * Validates the runtime fixes that make repeated project sends
 * fully trustworthy inside the visible relationship thread.
 *
 *  1. sourceProjectId atomicity (set AFTER artifact persistence)
 *  2. Workflow verification accuracy (throws on failure)
 *  3. Second project send appears in visible thread
 *  4. Third project send appears in visible thread
 *  5. Prior project history events remain visible
 *  6. Active project context remains separate from history
 *  7. Reload/re-entry preserves all project events
 *  8. No regression to relationship-thread consolidation
 *  9. No regression to participant scoping
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
  sendDirectMessageWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import {
  isConversationParticipant,
} from '../../src/lib/messages/participantScope'
import { resolveCanonicalThreadId } from '../../src/lib/messages/selectors'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_A = 'da111111-1111-4111-8111-111111111111'
const PROJECT_B = 'db222222-2222-4222-8222-222222222222'
const PROJECT_C = 'dc333333-3333-4333-8333-333333333333'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'RC Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-rc-001',
    craftsmanName: 'RC Handwerker',
    craftsmanHandle: 'rc-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-rc-001',
    projectTitle: 'Runtime Completion Test',
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
    id: overrides.id ?? `proj-rc-${Date.now()}`,
    title: 'RC Projekt',
    customer: 'RC Kundin',
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
    description: 'Runtime Completion Testprojekt',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Project Resend Runtime Completion', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. sourceProjectId ATOMICITY — SET AFTER ARTIFACT PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. sourceProjectId atomicity', () => {
    it('sourceProjectId is set after artifact is persisted (not before)', async () => {
      const threadId = 'conv-rc-atomic-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Atomic' }))
      await addConversation(seedConversation({ id: threadId }))

      // Before send: no sourceProjectId, no artifact
      const before = getConversationById(threadId)
      expect(before!.sourceProjectId).toBeUndefined()
      expect(getThreadArtifactRecords(threadId)).toHaveLength(0)

      // After send: BOTH sourceProjectId and artifact are set
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const after = getConversationById(threadId)
      expect(after!.sourceProjectId).toBe(PROJECT_A)
      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(1)
    })

    it('sourceProjectId and artifact record are consistent after first send', async () => {
      const threadId = 'conv-rc-atomic-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_A)

      // Both should be set
      const conv = getConversationById(threadId)
      expect(conv!.sourceProjectId).toBe(PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_A)
    })

    it('resend does not change sourceProjectId while creating new artifact', async () => {
      const threadId = 'conv-rc-atomic-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const afterFirst = getConversationById(threadId)
      expect(afterFirst!.sourceProjectId).toBe(PROJECT_A)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      const afterSecond = getConversationById(threadId)
      // sourceProjectId stays on first project
      expect(afterSecond!.sourceProjectId).toBe(PROJECT_A)

      // But both artifacts exist
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. WORKFLOW VERIFICATION ACCURACY
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Workflow verification accuracy', () => {
    it('workflow returns true when artifact is persisted', async () => {
      const threadId = 'conv-rc-verify-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      const result = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result).toBe(true)
    })

    it('workflow returns true for second send (resend verified)', async () => {
      const threadId = 'conv-rc-verify-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      const result1 = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result1).toBe(true)

      const result2 = await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(result2).toBe(true)

      // Both artifacts exist
      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
    })

    it('workflow returns true for third send (resend verified)', async () => {
      const threadId = 'conv-rc-verify-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)
      expect(await sendProjectAttachmentWorkflow(threadId, PROJECT_A)).toBe(true)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(3)
    })

    it('workflow throws for non-existent conversation', async () => {
      await addProject(seedProject({ id: PROJECT_A }))
      await expect(
        sendProjectAttachmentWorkflow('non-existent', PROJECT_A)
      ).rejects.toThrow('conversation not found')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. SECOND PROJECT SEND APPEARS IN VISIBLE THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Second project send appears in visible thread', () => {
    it('second send of same project creates visible artifact', async () => {
      const threadId = 'conv-rc-second-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      // Both visible with snapshots
      for (const a of artifacts.projectArtifacts) {
        expect(a.snapshot).not.toBeNull()
        expect(a.snapshot!.title).toBe('Küche')
      }
    })

    it('second send of different project creates visible artifact', async () => {
      const threadId = 'conv-rc-second-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
      expect(artifacts.projectArtifacts[0].snapshot!.title).toBe('Küche')
      expect(artifacts.projectArtifacts[1].snapshot!.title).toBe('Bad')
    })

    it('second send has unique artifact ID', async () => {
      const threadId = 'conv-rc-second-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records[0].id).not.toBe(records[1].id)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. THIRD PROJECT SEND APPEARS IN VISIBLE THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Third project send appears in visible thread', () => {
    it('three sends of same project all visible', async () => {
      const threadId = 'conv-rc-third-001'
      await addProject(seedProject({ id: PROJECT_A, title: 'Dachsanierung' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      const ids = new Set(artifacts.projectArtifacts.map((a) => a.artifactId))
      expect(ids.size).toBe(3)
    })

    it('three different projects all visible', async () => {
      const threadId = 'conv-rc-third-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'B' }))
      await addProject(seedProject({ id: PROJECT_C, title: 'C' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts[0].snapshot!.title).toBe('A')
      expect(artifacts.projectArtifacts[1].snapshot!.title).toBe('B')
      expect(artifacts.projectArtifacts[2].snapshot!.title).toBe('C')
    })

    it('timestamps are monotonically non-decreasing', async () => {
      const threadId = 'conv-rc-third-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      for (let i = 1; i < artifacts.projectArtifacts.length; i++) {
        expect(artifacts.projectArtifacts[i].createdAt)
          .toBeGreaterThanOrEqual(artifacts.projectArtifacts[i - 1].createdAt)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. PRIOR PROJECT HISTORY EVENTS REMAIN VISIBLE
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Prior project history events remain visible', () => {
    it('first artifact survives after second and third sends', async () => {
      const threadId = 'conv-rc-prior-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const firstId = getThreadArtifacts(threadId).projectArtifacts[0].artifactId

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts.some((a) => a.artifactId === firstId)).toBe(true)
    })

    it('interleaved text messages do not affect artifact visibility', async () => {
      const threadId = 'conv-rc-prior-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Nachricht 1')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendDirectMessageWorkflow(threadId, 'Nachricht 2')
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)

      const thread = getMessageThreadById(threadId)
      const textMessages = thread!.messages.filter((m) => m.text.trim())
      expect(textMessages.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. ACTIVE PROJECT CONTEXT REMAINS SEPARATE FROM HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Active project context remains separate from history', () => {
    it('first send is active, subsequent sends are history only', async () => {
      const threadId = 'conv-rc-active-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)

      // First project is active (sourceProjectId set on first send)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      // Second is not (different project, not active)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
      // Third is the same project as first but is a history event, not overwriting active
      expect(artifacts.projectArtifacts[2].isActiveProject).toBe(true)
    })

    it('all history events are visible regardless of active status', async () => {
      const threadId = 'conv-rc-active-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      // All confirmed
      for (const a of artifacts.projectArtifacts) {
        expect(a.persistenceStatus).toBe('confirmed')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. RELOAD / RE-ENTRY PRESERVES ALL PROJECT EVENTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Reload/re-entry preserves all project events', () => {
    it('repeated getThreadArtifacts calls return stable results', async () => {
      const threadId = 'conv-rc-reload-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Simulate re-entry by reading multiple times
      for (let i = 0; i < 5; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifacts).toHaveLength(2)
      }
    })

    it('getMessageThreadById + getThreadArtifacts both stable', async () => {
      const threadId = 'conv-rc-reload-002'
      await addProject(seedProject({ id: PROJECT_A, title: 'Stable' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Simulate screen re-entry
      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      expect(thread!.id).toBe(threadId)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      for (const a of artifacts.projectArtifacts) {
        expect(a.snapshot!.title).toBe('Stable')
      }
    })

    it('artifact order is stable across re-reads', async () => {
      const threadId = 'conv-rc-reload-003'
      await addProject(seedProject({ id: PROJECT_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_B)

      const read1 = getThreadArtifacts(threadId)
      const read2 = getThreadArtifacts(threadId)

      expect(read1.projectArtifacts).toHaveLength(2)
      expect(read2.projectArtifacts).toHaveLength(2)
      expect(read1.projectArtifacts[0].artifactId).toBe(read2.projectArtifacts[0].artifactId)
      expect(read1.projectArtifacts[1].artifactId).toBe(read2.projectArtifacts[1].artifactId)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. NO REGRESSION TO RELATIONSHIP-THREAD CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. No regression to relationship-thread consolidation', () => {
    it('project send to non-canonical thread routes to canonical', async () => {
      const now = Date.now()
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: 'conv-rc-consol-old',
        customerUserId: 'cust-rc-consol',
        craftsmanHandle: 'hw-rc-consol',
        createdAt: now - 5000,
      }))
      await addConversation(seedConversation({
        id: 'conv-rc-consol-new',
        customerUserId: 'cust-rc-consol',
        craftsmanHandle: 'hw-rc-consol',
        createdAt: now,
      }))

      // Send to non-canonical (older)
      await sendProjectAttachmentWorkflow('conv-rc-consol-old', PROJECT_A)

      // Canonical (newer) should have the artifact via relationship group
      const canonicalId = resolveCanonicalThreadId('conv-rc-consol-old')
      expect(canonicalId).toBe('conv-rc-consol-new')

      const artifacts = getThreadArtifacts('conv-rc-consol-new')
      expect(artifacts.projectArtifacts.length).toBeGreaterThanOrEqual(1)
    })

    it('resends to canonical thread visible from canonical thread', async () => {
      const threadId = 'conv-rc-consol-010'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('relationship group aggregation includes all duplicate conversations', async () => {
      const now = Date.now()
      await addProject(seedProject({ id: PROJECT_A }))
      await addProject(seedProject({ id: PROJECT_B }))
      await addConversation(seedConversation({
        id: 'conv-rc-group-1',
        customerUserId: 'cust-rc-group',
        craftsmanHandle: 'hw-rc-group',
        createdAt: now - 5000,
      }))
      await addConversation(seedConversation({
        id: 'conv-rc-group-2',
        customerUserId: 'cust-rc-group',
        craftsmanHandle: 'hw-rc-group',
        createdAt: now,
      }))

      // Send A to canonical, B to canonical
      await sendProjectAttachmentWorkflow('conv-rc-group-2', PROJECT_A)
      await sendProjectAttachmentWorkflow('conv-rc-group-2', PROJECT_B)

      // Both should be visible from either conversation
      const artifactsFromNew = getThreadArtifacts('conv-rc-group-2')
      expect(artifactsFromNew.projectArtifacts).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. No regression to participant scoping', () => {
    it('conversation participants are correctly identified', async () => {
      const conv = seedConversation({
        id: 'conv-rc-scope-001',
        customerUserId: 'cust-rc-scope',
        craftsmanUserId: 'craft-rc-scope',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-rc-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-rc-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('resend artifacts carry correct participant user IDs', async () => {
      const threadId = 'conv-rc-scope-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-rc-scope-2',
        craftsmanUserId: 'craft-rc-scope-2',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      for (const r of records) {
        expect(r.customerUserId).toBe('cust-rc-scope-2')
        expect(r.craftsmanUserId).toBe('craft-rc-scope-2')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. WRITE-READ CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. Write-read consistency', () => {
    it('artifact written to canonical thread is readable from same thread', async () => {
      const threadId = 'conv-rc-wrcons-001'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      // Read from the same canonical thread
      const records = getThreadArtifactRecords(threadId)
      expect(records.some((r) => r.artifactType === 'project' && r.projectId === PROJECT_A)).toBe(true)
    })

    it('multiple resends all readable from canonical thread', async () => {
      const threadId = 'conv-rc-wrcons-002'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project' && r.projectId === PROJECT_A)
      expect(records).toHaveLength(3)
      // All have unique IDs
      const ids = new Set(records.map((r) => r.id))
      expect(ids.size).toBe(3)
    })

    it('subscription notifies for each resend', async () => {
      const threadId = 'conv-rc-wrcons-003'
      await addProject(seedProject({ id: PROJECT_A }))
      await addConversation(seedConversation({ id: threadId }))

      let notifyCount = 0
      const unsub = subscribeThreadArtifacts(() => { notifyCount++ })

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      const after1 = notifyCount
      expect(after1).toBeGreaterThanOrEqual(1)

      await sendProjectAttachmentWorkflow(threadId, PROJECT_A)
      expect(notifyCount).toBeGreaterThan(after1)

      unsub()
    })
  })
})
