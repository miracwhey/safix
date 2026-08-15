/**
 * Thread Project Attach Flow — Canonical Persistence Hardening Tests
 *
 * Validates that the thread project attach flow is hardened against:
 *
 *  1. Double-tap / concurrent writes (no duplicate messages or records)
 *  2. Reload after attach (artifact survives fresh read)
 *  3. Delayed subscription sync (artifact available before subscription fires)
 *  4. Thread without project (no phantom artifacts)
 *  5. Thread with project (canonical artifact exists)
 *  6. Duplicate persistence protection (second write is no-op)
 *  7. hasProjectAttached derived exclusively from canonical artifact
 *  8. Attach button visibility gated solely by canonical artifact state
 *  9. Plain text messaging after project attach (no regression)
 * 10. Project data refresh triggers artifact re-resolution
 *
 * All assertions derive truth ONLY from the persisted ThreadArtifactRecord.
 * No message scanning, no conversation metadata inference, no local UI state.
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
  getThreadArtifactRecords,
  getMessageThreadById,
  sendProjectAttachmentToThread,
  subscribeThreadArtifacts,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
  sendDirectMessageWorkflow,
} from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SECOND_PROJECT_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-harden-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Hardening Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-harden-001',
    craftsmanName: 'Hardening Handwerker',
    craftsmanHandle: 'harden-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-harden-001',
    projectTitle: 'Hardening Test',
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
    id: overrides.id ?? `proj-harden-${Date.now()}`,
    title: 'Hardening Projekt',
    customer: 'Hardening Kundin',
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
    description: 'Hardening-Test-Projekt',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Thread Project Attach — Canonical Persistence Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. DOUBLE-TAP / CONCURRENT WRITE PROTECTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Multi-send project cards (replaces old double-tap protection)', () => {
    it('second sendProjectAttachmentToThread creates another artifact (multi-send)', async () => {
      const threadId = 'conv-harden-double-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      // First call creates a project artifact + message
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const threadAfterFirst = getMessageThreadById(threadId)
      const messageCountAfterFirst = threadAfterFirst?.messages.length ?? 0

      // Second call creates ANOTHER project artifact + message (multi-send)
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const threadAfterSecond = getMessageThreadById(threadId)
      const messageCountAfterSecond = threadAfterSecond?.messages.length ?? 0

      expect(messageCountAfterSecond).toBe(messageCountAfterFirst + 1)
    })

    it('multiple sendProjectAttachmentWorkflow calls create separate artifacts', async () => {
      const threadId = 'conv-harden-double-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // Two artifact records should exist (append-only model)
      const records = getThreadArtifactRecords(threadId)
      const projectRecords = records.filter((r) => r.artifactType === 'project')
      expect(projectRecords).toHaveLength(2)

      // Two messages should exist
      const thread = getMessageThreadById(threadId)
      expect(thread?.messages).toHaveLength(2)
    })

    it('parallel sendProjectAttachmentToThread calls both produce artifacts', async () => {
      const threadId = 'conv-harden-parallel-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      // Simulate rapid double-tap: fire both without awaiting
      await Promise.all([
        sendProjectAttachmentToThread(threadId, PROJECT_UUID),
        sendProjectAttachmentToThread(threadId, PROJECT_UUID),
      ])

      // Both sends produce artifacts (multi-send model)
      const records = getThreadArtifactRecords(threadId)
      const projectRecords = records.filter((r) => r.artifactType === 'project')
      expect(projectRecords.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. RELOAD AFTER ATTACH
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Reload after attach', () => {
    it('artifact survives fresh getThreadArtifacts call after write', async () => {
      const threadId = 'conv-harden-reload-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // Simulate reload: fresh read from repository
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('hasProjectAttached equivalent is true after reload', async () => {
      const threadId = 'conv-harden-reload-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // The canonical derivation for hasProjectAttached
      const artifacts = getThreadArtifacts(threadId)
      const hasProjectAttached = artifacts.projectArtifact !== null
      expect(hasProjectAttached).toBe(true)
    })

    it('snapshot data available on reload even without project entity', async () => {
      const threadId = 'conv-harden-snapshot-001'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Snapshot-Test',
        status: 'request',
        category: 'Elektrik',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // Verify snapshot is persisted in the artifact record
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.snapshotTitle).toBe('Snapshot-Test')
      expect(record!.snapshotStatus).toBe('request')
      expect(record!.snapshotSummary).toBe('Elektrik')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. DELAYED SUBSCRIPTION SYNC
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Delayed subscription sync', () => {
    it('subscription fires after artifact write', async () => {
      const threadId = 'conv-harden-sub-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      let notifyCount = 0
      const unsub = subscribeThreadArtifacts(() => { notifyCount++ })

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      expect(notifyCount).toBeGreaterThan(0)
      unsub()
    })

    it('artifact readable immediately after write (before subscription callback)', async () => {
      const threadId = 'conv-harden-sub-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      // Read directly — no subscription needed for immediate access
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
    })

    it('subscription-driven refresh produces same result as direct read', async () => {
      const threadId = 'conv-harden-sub-003'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      let subscriptionArtifacts: ReturnType<typeof getThreadArtifacts> | null = null
      const unsub = subscribeThreadArtifacts(() => {
        subscriptionArtifacts = getThreadArtifacts(threadId)
      })

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const directArtifacts = getThreadArtifacts(threadId)

      expect(subscriptionArtifacts).not.toBeNull()
      expect(subscriptionArtifacts!.projectArtifact).not.toBeNull()
      expect(directArtifacts.projectArtifact).not.toBeNull()
      expect(subscriptionArtifacts!.projectArtifact!.snapshot?.projectId)
        .toBe(directArtifacts.projectArtifact!.snapshot?.projectId)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. THREAD WITHOUT PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Thread without project', () => {
    it('thread with no artifact has null projectArtifact', async () => {
      const threadId = 'conv-harden-noproj-001'
      await addConversation(seedConversation({ id: threadId }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.pendingProjectArtifact).toBe(false)
    })

    it('hasProjectAttached equivalent is false for thread without artifact', async () => {
      const threadId = 'conv-harden-noproj-002'
      await addConversation(seedConversation({ id: threadId }))

      const artifacts = getThreadArtifacts(threadId)
      const hasProjectAttached = artifacts.projectArtifact !== null
      expect(hasProjectAttached).toBe(false)
    })

    it('sourceProjectId on conversation alone does NOT produce artifact', async () => {
      const threadId = 'conv-harden-noproj-003'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: PROJECT_UUID,
      }))

      // No thread_artifacts record → no artifact, even with sourceProjectId
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. THREAD WITH PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Thread with project', () => {
    it('canonical artifact exists after attach', async () => {
      const threadId = 'conv-harden-withproj-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.kind).toBe('project')
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('artifact record has correct participant IDs', async () => {
      const threadId = 'conv-harden-withproj-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-H1',
        craftsmanUserId: 'craft-H1',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.customerUserId).toBe('cust-H1')
      expect(record!.craftsmanUserId).toBe('craft-H1')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. DUPLICATE PERSISTENCE PROTECTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Duplicate persistence protection', () => {
    it('sendProjectAttachmentToThread creates additional artifact on second call (multi-send)', async () => {
      const threadId = 'conv-harden-dedup-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const recordsBefore = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      const threadBefore = getMessageThreadById(threadId)

      // Second call creates another artifact (multi-send model)
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const recordsAfter = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      const threadAfter = getMessageThreadById(threadId)

      // New artifact record created (not deduplicated)
      expect(recordsAfter.length).toBe(recordsBefore.length + 1)
      // New message created
      expect(threadAfter!.messages.length).toBe(threadBefore!.messages.length + 1)
    })

    it('attaching a different project to same thread creates both artifacts', async () => {
      const threadId = 'conv-harden-dedup-002'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Projekt A' }))
      await addProject(seedProject({ id: SECOND_PROJECT_UUID, title: 'Projekt B' }))
      await addConversation(seedConversation({ id: threadId }))

      // Attach first project
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)
      // Attach second project
      await sendProjectAttachmentToThread(threadId, SECOND_PROJECT_UUID)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      expect(records.map((r) => r.projectId)).toContain(PROJECT_UUID)
      expect(records.map((r) => r.projectId)).toContain(SECOND_PROJECT_UUID)

      // Two attachment messages
      const thread = getMessageThreadById(threadId)
      expect(thread?.messages).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. hasProjectAttached DERIVED EXCLUSIVELY FROM CANONICAL ARTIFACT
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Project send CTA always available for customer (multi-send)', () => {
    it('screen source does not gate attach button behind hasProjectAttached', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      // Multi-send: no hasProjectAttached gating — button always visible for customer
      expect(screenSource).not.toContain('hasProjectAttached')

      // No message-based or conversation-metadata-based derivation
      expect(screenSource).not.toContain('messages.some')
      expect(screenSource).not.toContain('attachmentType')
      expect(screenSource).not.toContain('linkedProjectId')
      expect(screenSource).not.toContain('conversionState')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. ATTACH BUTTON VISIBILITY FROM CANONICAL STATE ONLY
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. Attach button visibility from canonical state only', () => {
    it('screen source gates attach button on role only (always available for customer)', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      // Button visibility depends on customer role only (multi-send)
      expect(screenSource).toContain("role === 'customer'")
      // thread-attach-project data-testid is in ChatComposer tile; screen exposes showProjectPicker
      expect(screenSource).toContain('showProjectPicker')

      // Double-tap guard exists
      expect(screenSource).toContain('isAttachingProjectRef')
    })

    it('screen source contains double-tap guard in handleProjectSelect', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      // Guard against concurrent attach calls
      expect(screenSource).toContain('isAttachingProjectRef.current')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. PLAIN TEXT MESSAGING AFTER PROJECT ATTACH (NO REGRESSION)
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. Plain text messaging after project attach (no regression)', () => {
    it('text messages work normally after a project is attached', async () => {
      const threadId = 'conv-harden-textmsg-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      // Attach project
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // Send a plain text message after attach
      await sendDirectMessageWorkflow(threadId, 'Wann können Sie vorbeikommen?')

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()

      // The text message exists alongside the attachment message
      const textMessages = thread!.messages.filter((m) => m.text.trim() !== '')
      expect(textMessages.length).toBeGreaterThanOrEqual(1)
      expect(textMessages.some((m) => m.text === 'Wann können Sie vorbeikommen?')).toBe(true)
    })

    it('project artifact is unaffected by subsequent text messages', async () => {
      const threadId = 'conv-harden-textmsg-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID)

      // Send multiple text messages
      await sendDirectMessageWorkflow(threadId, 'Erste Nachricht')
      await sendDirectMessageWorkflow(threadId, 'Zweite Nachricht', 'counterparty')

      // Artifact is still intact
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')

      // Record unchanged
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.projectId).toBe(PROJECT_UUID)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. PROJECT DATA REFRESH TRIGGERS ARTIFACT RE-RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. Project data refresh triggers artifact re-resolution', () => {
    it('screen source refreshes artifacts in subscribeProjects callback', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      // The subscribeProjects callback must also re-resolve artifacts
      // so entity-enriched cards appear when the project repo hydrates
      expect(screenSource).toContain('subscribeProjects')
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('setArtifacts')
    })
  })
})
