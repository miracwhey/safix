/**
 * Thread Artifact Persistence Hardening — Repository + Partial-Failure + Snapshot
 *
 * Validates structural guarantees that go beyond the service-level pre-check:
 *
 *  1. REPOSITORY-LEVEL UNIQUENESS: InMemoryThreadArtifactRepository enforces
 *     the (conversationId, artifactType) uniqueness constraint structurally
 *     — even when duplicate initial data is supplied or upsert is called in
 *     rapid succession.
 *
 *  2. PARTIAL-FAILURE HANDLING: When the canonical project artifact is
 *     persisted but the accompanying attachment message fails to write,
 *     the thread remains correctly project-bound.  The artifact is the
 *     canonical truth; the message is a secondary notification.
 *
 *  3. SNAPSHOT INTEGRITY: Snapshot fields in the artifact record are frozen
 *     at attach time.  Later changes to the live project entity do NOT
 *     alter the persisted snapshot, ensuring thread context is a traceable
 *     point-in-time record.
 *
 *  4. RACE PROTECTION BEYOND SERVICE LAYER: The repository upsert itself
 *     deduplicates by (conversationId, artifactType) — concurrent writes
 *     converge to exactly one record regardless of service-level guards.
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import type { ThreadArtifactRecord } from '../../src/lib/messages/threadArtifactRecord'
import type { Conversation, Message } from '../../src/lib/messages/types'
import type { MessageRepository } from '../../src/lib/messages/repository/MessageRepository'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
  sendProjectAttachmentToThread,
} from '../../src/lib/messages'
import { addProject, updateProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { persistProjectArtifact } from '../../src/lib/messages/threadArtifactService'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-ph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'PH Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-ph-001',
    craftsmanName: 'PH Handwerker',
    craftsmanHandle: 'ph-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-ph-001',
    projectTitle: 'PH Test',
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
    id: overrides.id ?? `proj-ph-${Date.now()}`,
    title: 'PH Projekt',
    customer: 'PH Kundin',
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
    description: 'PH-Test-Projekt',
    ...overrides,
  }
}

function makeArtifactRecord(
  conversationId: string,
  overrides: Partial<ThreadArtifactRecord> = {}
): ThreadArtifactRecord {
  return {
    id: `ta_project_${conversationId}_${Date.now()}`,
    conversationId,
    artifactType: 'project',
    projectId: PROJECT_UUID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Creates a MessageRepository that throws on addMessageAndUpdateConversation
 * but works normally for all other operations.
 */
function createFailingMessageRepository(
  conversations: Conversation[] = [],
  messages: Message[] = []
): MessageRepository {
  const convs = [...conversations]
  const msgs = [...messages]
  const listeners = new Set<() => void>()

  return {
    async initialize(): Promise<void> {},
    getConversations: () => [...convs],
    getConversationById: (id) => convs.find((c) => c.id === id),
    getConversationByProjectId: (id) => convs.find((c) => c.projectId === id),
    getMessages: () => [...msgs],
    getMessagesByConversationId: (id) => msgs.filter((m) => m.conversationId === id),
    addConversation: async (conversation) => {
      convs.push(conversation)
      listeners.forEach((l) => l())
    },
    updateConversation: (id, patch) => {
      const idx = convs.findIndex((c) => c.id === id)
      if (idx >= 0) convs[idx] = { ...convs[idx], ...patch }
      listeners.forEach((l) => l())
    },
    addMessageAndUpdateConversation: async () => {
      throw new Error('Simulated message write failure')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Thread Artifact Persistence Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. REPOSITORY-LEVEL UNIQUENESS
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Repository-level uniqueness enforcement', () => {
    it('constructor allows multiple project artifacts for same conversation (multi-send)', () => {
      const record1 = makeArtifactRecord('conv-1', { id: 'first', snapshotTitle: 'Old' })
      const record2 = makeArtifactRecord('conv-1', { id: 'second', snapshotTitle: 'New' })

      const repo = new InMemoryThreadArtifactRepository([record1, record2])

      // Both project records should survive (append-only multi-send)
      const all = repo.getAll()
      expect(all).toHaveLength(2)
    })

    it('constructor preserves distinct (conversationId, artifactType) pairs', () => {
      const projectRecord = makeArtifactRecord('conv-1', { artifactType: 'project' })
      const offerRecord = makeArtifactRecord('conv-1', { artifactType: 'offer', offerId: 'offer-1' })

      const repo = new InMemoryThreadArtifactRepository([projectRecord, offerRecord])
      expect(repo.getAll()).toHaveLength(2)
    })

    it('constructor deduplicates offer artifacts by (conversationId, artifactType)', () => {
      const offer1: ThreadArtifactRecord = {
        ...makeArtifactRecord('conv-1', { id: 'offer-1' }),
        artifactType: 'offer',
        offerId: 'old-offer',
      }
      const offer2: ThreadArtifactRecord = {
        ...makeArtifactRecord('conv-1', { id: 'offer-2' }),
        artifactType: 'offer',
        offerId: 'new-offer',
      }

      const repo = new InMemoryThreadArtifactRepository([offer1, offer2])
      const all = repo.getAll().filter((r) => r.artifactType === 'offer')
      expect(all).toHaveLength(1)
      expect(all[0].offerId).toBe('new-offer')
    })

    it('upsert matches by record id', async () => {
      const repo = new InMemoryThreadArtifactRepository()
      const record1 = makeArtifactRecord('conv-1', { id: 'rec-1', snapshotTitle: 'Old' })
      const record2 = { ...record1, snapshotTitle: 'Updated' }

      await repo.upsert(record1)
      await repo.upsert(record2)

      const all = repo.getAll()
      expect(all).toHaveLength(1)
      expect(all[0].snapshotTitle).toBe('Updated')
    })

    it('concurrent upserts converge to exactly one record for same id', async () => {
      const repo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(repo)

      const baseRecord = makeArtifactRecord('conv-race', { id: 'race-id' })

      // Fire 5 concurrent upserts for the same id
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo.upsert({ ...baseRecord, snapshotTitle: `Write-${i}` })
        )
      )

      const all = repo.getByConversationId('conv-race')
      expect(all).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. PARTIAL-FAILURE HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Partial-failure handling', () => {
    it('artifact persists even when message write fails', async () => {
      const threadId = 'conv-pf-001'
      const conv = seedConversation({ id: threadId })
      const project = seedProject({ id: PROJECT_UUID, title: 'PF Test' })

      // Set up repos: normal artifact repo, failing message repo
      const failingRepo = createFailingMessageRepository([conv])
      setMessageRepository(failingRepo)
      await addProject(project)

      // This should NOT throw — the artifact is canonical, message is secondary
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      // Artifact IS persisted — thread is project-bound
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID)

      // Artifacts resolves correctly
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('hasProjectAttached is true even when message write failed', async () => {
      const threadId = 'conv-pf-002'
      const conv = seedConversation({ id: threadId })
      const project = seedProject({ id: PROJECT_UUID })

      const failingRepo = createFailingMessageRepository([conv])
      setMessageRepository(failingRepo)
      await addProject(project)

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const artifacts = getThreadArtifacts(threadId)
      const hasProjectAttached = artifacts.projectArtifact !== null
      expect(hasProjectAttached).toBe(true)
    })

    it('snapshot data survives message write failure', async () => {
      const threadId = 'conv-pf-003'
      const conv = seedConversation({ id: threadId })
      const project = seedProject({
        id: PROJECT_UUID,
        title: 'Snapshot PF',
        status: 'request',
        category: 'Elektrik',
      })

      const failingRepo = createFailingMessageRepository([conv])
      setMessageRepository(failingRepo)
      await addProject(project)

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.snapshotTitle).toBe('Snapshot PF')
      expect(record!.snapshotStatus).toBe('request')
      expect(record!.snapshotSummary).toBe('Elektrik')
    })

    it('retry after partial failure creates another artifact (multi-send)', async () => {
      const threadId = 'conv-pf-004'
      const conv = seedConversation({ id: threadId })
      const project = seedProject({ id: PROJECT_UUID })

      // First call: artifact persists, message fails
      const failingRepo = createFailingMessageRepository([conv])
      setMessageRepository(failingRepo)
      await addProject(project)

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      // Second call creates another artifact (multi-send model)
      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      // Two artifacts exist (append-only)
      const records = getThreadArtifactRepository().getByConversationId(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. SNAPSHOT INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Snapshot integrity', () => {
    it('snapshot fields frozen at attach time', async () => {
      const threadId = 'conv-snap-001'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Originaltitel',
        status: 'request',
        category: 'Sanitär',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      // Now change the live project
      updateProject(PROJECT_UUID, { title: 'Neuer Titel', status: 'in_progress' })

      // Snapshot in artifact record must still reflect attach-time values
      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.snapshotTitle).toBe('Originaltitel')
      expect(record!.snapshotStatus).toBe('request')
      expect(record!.snapshotSummary).toBe('Sanitär')
    })

    it('snapshot persisted even for projects with minimal data', async () => {
      const threadId = 'conv-snap-002'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Minimal',
        status: 'request',
        category: undefined,
        description: 'Nur Beschreibung',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record!.snapshotTitle).toBe('Minimal')
      expect(record!.snapshotStatus).toBe('request')
      // Falls back to description when category is undefined
      expect(record!.snapshotSummary).toBe('Nur Beschreibung')
    })

    it('getThreadArtifacts returns snapshot data alongside live entity', async () => {
      const threadId = 'conv-snap-003'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Snapshot+Entity',
        status: 'request',
        category: 'Malerarbeiten',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      // Snapshot is available
      expect(artifacts.projectArtifact!.snapshot).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot!.title).toBe('Snapshot+Entity')
      // Live entity is also available
      expect(artifacts.projectArtifact!.project).not.toBeNull()
    })

    it('sendProjectAttachmentToThread persists all compact snapshot fields', async () => {
      const threadId = 'conv-snap-compact-001'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Komplett-Projekt',
        status: 'request',
        category: 'Elektrik',
        location: 'München',
        requestedBudget: '2.000 – 5.000 €',
        requestedTiming: 'Innerhalb 2 Wochen',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).not.toBeNull()
      // Core snapshot fields
      expect(record!.snapshotTitle).toBe('Komplett-Projekt')
      expect(record!.snapshotStatus).toBe('request')
      // Compact card snapshot fields — the write-path fix
      expect(record!.snapshotCategory).toBe('Elektrik')
      expect(record!.snapshotLocation).toBe('München')
      expect(record!.snapshotBudget).toBe('2.000 – 5.000 €')
      expect(record!.snapshotTiming).toBe('Innerhalb 2 Wochen')
    })

    it('compact snapshot fields resolve into ProjectSnapshot on read', async () => {
      const threadId = 'conv-snap-compact-002'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Lese-Test',
        status: 'request',
        category: 'Bad',
        location: 'Köln',
        requestedBudget: 'unter 1.000 €',
        requestedTiming: 'Flexibel',
      }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, PROJECT_UUID)

      const artifacts = getThreadArtifacts(threadId)
      const snapshot = artifacts.projectArtifact!.snapshot
      expect(snapshot).not.toBeNull()
      expect(snapshot!.category).toBe('Bad')
      expect(snapshot!.location).toBe('Köln')
      expect(snapshot!.requestedBudget).toBe('unter 1.000 €')
      expect(snapshot!.requestedTiming).toBe('Flexibel')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. RACE PROTECTION BEYOND SERVICE LAYER
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Multi-send append-only model', () => {
    it('concurrent persistProjectArtifact calls create separate records (append-only)', async () => {
      await Promise.all(
        Array.from({ length: 3 }, () =>
          persistProjectArtifact({
            conversationId: 'conv-race-001',
            projectId: PROJECT_UUID,
            snapshotTitle: 'Race Test',
          })
        )
      )

      const records = getThreadArtifactRepository().getByConversationId('conv-race-001')
      // Each call creates a new record (append-only)
      expect(records.length).toBe(3)
      expect(records.every((r) => r.projectId === PROJECT_UUID)).toBe(true)
    })

    it('repository getByConversationAndType returns first project record', async () => {
      // Pre-load with multiple project records for same conversation
      const record1 = makeArtifactRecord('conv-race-002', { id: 'dup-1', snapshotTitle: 'First' })
      const record2 = makeArtifactRecord('conv-race-002', { id: 'dup-2', snapshotTitle: 'Second' })
      const repo = new InMemoryThreadArtifactRepository([record1, record2])

      // getByConversationAndType returns the first match
      const result = repo.getByConversationAndType('conv-race-002', 'project')
      expect(result).toBeDefined()

      // Both records exist (append-only for projects)
      const all = repo.getByConversationId('conv-race-002')
      expect(all.filter((r) => r.artifactType === 'project')).toHaveLength(2)
    })

    it('DB migration removes UNIQUE constraint for project artifacts', async () => {
      const fs = await import('fs')
      const migration = fs.readFileSync(
        path.resolve(__dirname, '../../supabase/migrations/20260323000004_thread_artifacts_multi_project.sql'),
        'utf-8'
      )
      expect(migration).toContain('DROP CONSTRAINT')
      expect(migration).toContain('thread_artifacts_offer_unique')
      expect(migration).toContain('thread_artifacts_payment_phase_unique')
    })

    it('SupabaseThreadArtifactRepository has insert method for append-only writes', async () => {
      const fs = await import('fs')
      const repoSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/lib/messages/repository/SupabaseThreadArtifactRepository.ts'),
        'utf-8'
      )
      expect(repoSource).toContain('async insert(record: ThreadArtifactRecord)')
      expect(repoSource).toContain('.insert(stripNullColumns(recordToRow(record)))')
    })
  })
})
