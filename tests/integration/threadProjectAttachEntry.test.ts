/**
 * Thread Project Attach Entry — Restore Verification Tests
 *
 * Verifies that the project attach entry has been cleanly restored
 * in the message thread after the RUN 1 teardown + RUN 2 rebuild:
 *
 * 1. Customer can open the restored project attach entry from the thread
 * 2. Customer can select and send a project into the current conversation
 * 3. Canonical project artifact row is created/updated via the write path
 * 4. Project card remains visible after reload for both participants
 * 5. No regression to participant scoping
 * 6. No regression to the rebuilt canonical thread card model
 * 7. Craftsman does NOT see the attach entry (customer-only feature)
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getThreadArtifactRecord,
  getMessageThreadById,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject, getProjects, subscribeProjects } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { sendProjectAttachmentWorkflow } from '../../src/lib/workflow/messageWorkflow'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SECOND_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

const SCREEN_PATH = path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx')

async function readScreenSource(): Promise<string> {
  const fs = await import('fs')
  return fs.readFileSync(SCREEN_PATH, 'utf-8')
}

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Test Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-attach-001',
    craftsmanName: 'Test Handwerker',
    craftsmanHandle: 'test-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-attach-001',
    projectTitle: 'Attach Entry Test',
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
    id: overrides.id ?? `proj-attach-${Date.now()}`,
    title: 'Badezimmer Renovierung',
    customer: 'Test Kundin',
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

describe('Thread Project Attach Entry — Restore Verification', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. CUSTOMER CAN OPEN THE ATTACH ENTRY
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Customer can open the project attach entry', () => {
    it('MessageThreadScreen contains ProjectPickerSheet and attach button', async () => {
      const screenSource = await readScreenSource()

      // ProjectPickerSheet is imported and used
      expect(screenSource).toContain('ProjectPickerSheet')
      expect(screenSource).toContain('showProjectPicker')
      // thread-attach-project data-testid is in ChatComposer tile, not directly in screen

      // Uses canonical write path, not legacy attachment inference
      expect(screenSource).toContain('sendProjectAttachmentWorkflow')

      // No legacy patterns reintroduced
      expect(screenSource).not.toContain('canAttachProject')
      expect(screenSource).not.toContain('linkedProjectId')
      expect(screenSource).not.toContain('conversionState')
      expect(screenSource).not.toContain('getJobContextForThread')
    })

    it('attach entry is only rendered for customer role', async () => {
      const screenSource = await readScreenSource()

      // The attach button is gated by customer role check (always available for multi-send)
      expect(screenSource).toContain("role === 'customer'")
    })

    it('customer project list is available via getProjects()', async () => {
      await addProject(seedProject({ id: VALID_UUID, title: 'Projekt A' }))
      await addProject(seedProject({ id: SECOND_UUID, title: 'Projekt B' }))

      const projects = getProjects()
      expect(projects).toHaveLength(2)
      expect(projects.map((p) => p.title)).toContain('Projekt A')
      expect(projects.map((p) => p.title)).toContain('Projekt B')
    })

    it('project subscription notifies on new projects', async () => {
      let notified = false
      const unsub = subscribeProjects(() => { notified = true })

      await addProject(seedProject({ id: VALID_UUID }))
      expect(notified).toBe(true)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. CUSTOMER CAN SELECT AND SEND A PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Customer can select and send a project', () => {
    it('sendProjectAttachmentWorkflow attaches project to thread', async () => {
      const threadId = 'conv-attach-select-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      const result = await sendProjectAttachmentWorkflow(threadId, VALID_UUID)
      expect(result).toBe(true)

      // Conversation should have sourceProjectId stamped
      const conv = getConversationById(threadId)
      expect(conv?.sourceProjectId).toBe(VALID_UUID)
    })

    it('project attachment message is created in the thread', async () => {
      const threadId = 'conv-attach-msg-001'
      await addProject(seedProject({ id: VALID_UUID, title: 'Badezimmer' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      // The attachment creates a message with empty text
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].text).toBe('')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. CANONICAL ARTIFACT ROW IS CREATED
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Canonical project artifact row is created', () => {
    it('thread_artifacts record exists after attachment', async () => {
      const threadId = 'conv-attach-artifact-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(VALID_UUID)
      expect(record!.artifactType).toBe('project')
    })

    it('artifact record contains snapshot data for immediate rendering', async () => {
      const threadId = 'conv-attach-snapshot-001'
      await addProject(
        seedProject({
          id: VALID_UUID,
          title: 'Badezimmer Renovierung',
          status: 'request',
          category: 'Sanitär',
        })
      )
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.snapshotTitle).toBe('Badezimmer Renovierung')
      expect(record!.snapshotStatus).toBe('request')
      expect(record!.snapshotSummary).toBe('Sanitär')
    })

    it('artifact record includes participant user IDs', async () => {
      const threadId = 'conv-attach-participants-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'cust-001',
          craftsmanUserId: 'craft-001',
        })
      )

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.customerUserId).toBe('cust-001')
      expect(record!.craftsmanUserId).toBe('craft-001')
    })

    it('getThreadArtifacts resolves project artifact after write', async () => {
      const threadId = 'conv-attach-resolve-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(VALID_UUID)
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. PROJECT CARD REMAINS VISIBLE AFTER RELOAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Project card remains visible after reload', () => {
    it('customer reload: project artifact still present', async () => {
      const threadId = 'conv-attach-reload-customer-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      // Simulate reload by re-reading from repository
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(VALID_UUID)
    })

    it('craftsman reload: project artifact still present', async () => {
      const threadId = 'conv-attach-reload-craftsman-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'cust-X',
          craftsmanUserId: 'craft-X',
        })
      )

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      // Both participant perspectives resolve the same artifact
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(VALID_UUID)
    })

    it('artifact survives multiple getThreadArtifacts calls (idempotent)', async () => {
      const threadId = 'conv-attach-idempotent-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      // Multiple reads should all return the same artifact
      const a1 = getThreadArtifacts(threadId)
      const a2 = getThreadArtifacts(threadId)
      const a3 = getThreadArtifacts(threadId)
      expect(a1.projectArtifact).not.toBeNull()
      expect(a2.projectArtifact).not.toBeNull()
      expect(a3.projectArtifact).not.toBeNull()
      expect(a1.projectArtifact!.project.id).toBe(VALID_UUID)
      expect(a2.projectArtifact!.project.id).toBe(VALID_UUID)
      expect(a3.projectArtifact!.project.id).toBe(VALID_UUID)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. No regression to participant scoping', () => {
    it('only participants can see the conversation', async () => {
      const conv = seedConversation({
        id: 'conv-attach-scope-001',
        customerUserId: 'cust-A',
        craftsmanUserId: 'craft-B',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-A')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-B')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('project attachment does not break participant scoping', async () => {
      const threadId = 'conv-attach-scope-002'
      await addProject(seedProject({ id: VALID_UUID }))
      const conv = seedConversation({
        id: threadId,
        customerUserId: 'cust-C',
        craftsmanUserId: 'craft-D',
      })
      await addConversation(conv)

      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      // Participant check still works after attachment
      expect(isConversationParticipant(conv, 'cust-C')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-D')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. NO REGRESSION TO CANONICAL THREAD CARD MODEL
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. No regression to canonical thread card model', () => {
    it('attach entry writes through canonical persistProjectArtifact path only', async () => {
      const threadId = 'conv-attach-canonical-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      // sendProjectAttachmentWorkflow uses sendProjectAttachmentToThread
      // which calls persistProjectArtifact (canonical write path)
      await sendProjectAttachmentWorkflow(threadId, VALID_UUID)

      // Verify through the canonical read path
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('no artifact without explicit send (no legacy inference)', async () => {
      const threadId = 'conv-attach-no-inference-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: VALID_UUID,
        })
      )

      // Having sourceProjectId on conversation alone does NOT produce artifact
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('screen does not use any legacy business-card patterns', async () => {
      const screenSource = await readScreenSource()

      // Uses canonical model
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('subscribeThreadArtifacts')
      // Persistent top-cards removed (V5 2026-06-23): stream-only artifact cards.
      expect(screenSource).toContain('ChatArtifactCardCompact')
      expect(screenSource).not.toContain('ThreadArtifactCards')
      expect(screenSource).toContain('sendProjectAttachmentWorkflow')

      // Does NOT use legacy patterns
      expect(screenSource).not.toContain('getJobContextForThread')
      expect(screenSource).not.toContain('getThreadConversionState')
      expect(screenSource).not.toContain('buildTruthTraceSnapshot')
      expect(screenSource).not.toContain('ThreadProjectContextBar')
      expect(screenSource).not.toContain('ThreadOfferCard')
      expect(screenSource).not.toContain('ThreadJobContextBar')
      expect(screenSource).not.toContain('CraftsmanOfferForm')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. CRAFTSMAN DOES NOT SEE ATTACH ENTRY
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Craftsman does not see the attach entry', () => {
    it('attach button is gated behind customer role check in source', async () => {
      const screenSource = await readScreenSource()

      // The plus button rendering requires customer role (always available for multi-send)
      expect(screenSource).toContain("role === 'customer'")
    })
  })
})
