/**
 * First Project Stays Active + Explicit Project Switch — Tests
 *
 * Validates that:
 *
 *  1. First sent project becomes active when no active project exists
 *  2. Later sent projects do NOT overwrite active project automatically
 *  3. Multiple project cards remain visible in history
 *  4. Explicit switch action updates active project correctly
 *  5. Reload/re-entry preserves both history and active project
 *  6. No regression to participant scoping
 *  7. No regression to rebuilt thread artifact rendering
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getThreadArtifactRecords,
  setActiveThreadProject,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
  setActiveThreadProjectWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_UUID_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const PROJECT_UUID_C = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-ap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Active Project Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-ap-001',
    craftsmanName: 'Active Project Handwerker',
    craftsmanHandle: 'ap-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-ap-001',
    projectTitle: 'Active Project Test',
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
    id: overrides.id ?? `proj-ap-${Date.now()}`,
    title: 'Badezimmer Renovierung',
    customer: 'Active Project Kundin',
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

describe('First Project Stays Active + Explicit Project Switch', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. FIRST SENT PROJECT BECOMES ACTIVE
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. First sent project becomes active when no active project exists', () => {
    it('first project send sets sourceProjectId on the conversation', async () => {
      const threadId = 'conv-ap-first-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Erstes Projekt' }))
      await addConversation(seedConversation({ id: threadId }))

      // No sourceProjectId before send
      const before = getConversationById(threadId)
      expect(before?.sourceProjectId).toBeUndefined()

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // sourceProjectId is now set to the first project
      const after = getConversationById(threadId)
      expect(after?.sourceProjectId).toBe(PROJECT_UUID_A)
    })

    it('first project artifact is marked as active', async () => {
      const threadId = 'conv-ap-first-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Aktiv' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. LATER SENDS DO NOT OVERWRITE ACTIVE PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Later sent projects do not overwrite active project automatically', () => {
    it('second project send does NOT change sourceProjectId', async () => {
      const threadId = 'conv-ap-nooverwrite-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const conv = getConversationById(threadId)
      // sourceProjectId stays as the first project
      expect(conv?.sourceProjectId).toBe(PROJECT_UUID_A)
    })

    it('third project send still does not change active project', async () => {
      const threadId = 'conv-ap-nooverwrite-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addProject(seedProject({ id: PROJECT_UUID_C }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const conv = getConversationById(threadId)
      expect(conv?.sourceProjectId).toBe(PROJECT_UUID_A)
    })

    it('only the first project artifact is marked as active after multi-send', async () => {
      const threadId = 'conv-ap-nooverwrite-003'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Active' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'History' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(2)

      // First project is active
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      expect(artifacts.projectArtifacts[0].project!.id).toBe(PROJECT_UUID_A)

      // Second project is NOT active
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
      expect(artifacts.projectArtifacts[1].project!.id).toBe(PROJECT_UUID_B)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ALL SENT PROJECT CARDS REMAIN VISIBLE
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Multiple project cards remain visible in history', () => {
    it('all sent projects are in the artifact history', async () => {
      const threadId = 'conv-ap-history-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'B' }))
      await addProject(seedProject({ id: PROJECT_UUID_C, title: 'C' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
      expect(artifacts.projectArtifacts[0].project!.title).toBe('A')
      expect(artifacts.projectArtifacts[1].project!.title).toBe('B')
      expect(artifacts.projectArtifacts[2].project!.title).toBe('C')
    })

    it('artifact records carry correct data for each send', async () => {
      const threadId = 'conv-ap-history-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records).toHaveLength(2)
      expect(records[0].projectId).toBe(PROJECT_UUID_A)
      expect(records[1].projectId).toBe(PROJECT_UUID_B)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. EXPLICIT SWITCH ACTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Explicit switch action updates active project correctly', () => {
    it('setActiveThreadProject changes the active project', async () => {
      const threadId = 'conv-ap-switch-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Active is first project
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_A)

      // Explicitly switch to second project
      const result = setActiveThreadProject(threadId, PROJECT_UUID_B)
      expect(result).toBe(true)

      // Active is now second project
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_B)
    })

    it('workflow wrapper also works correctly', async () => {
      const threadId = 'conv-ap-switch-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const result = setActiveThreadProjectWorkflow(threadId, PROJECT_UUID_B)
      expect(result).toBe(true)
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_B)
    })

    it('switch updates isActiveProject flags in artifacts', async () => {
      const threadId = 'conv-ap-switch-003'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Was Active' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Now Active' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Before switch: A is active
      const before = getThreadArtifacts(threadId)
      expect(before.projectArtifacts[0].isActiveProject).toBe(true)
      expect(before.projectArtifacts[1].isActiveProject).toBe(false)

      // Switch to B
      setActiveThreadProject(threadId, PROJECT_UUID_B)

      // After switch: B is active
      const after = getThreadArtifacts(threadId)
      expect(after.projectArtifacts[0].isActiveProject).toBe(false)
      expect(after.projectArtifacts[1].isActiveProject).toBe(true)
    })

    it('switch to non-existent-in-history project is rejected', async () => {
      const threadId = 'conv-ap-switch-004'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // Try to switch to a project not in thread history
      const result = setActiveThreadProject(threadId, 'not-in-history')
      expect(result).toBe(false)

      // Active project unchanged
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_A)
    })

    it('switch to non-existent conversation returns false', () => {
      const result = setActiveThreadProject('non-existent', PROJECT_UUID_A)
      expect(result).toBe(false)
    })

    it('can switch back to the first project after switching away', async () => {
      const threadId = 'conv-ap-switch-005'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Switch to B
      setActiveThreadProject(threadId, PROJECT_UUID_B)
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_B)

      // Switch back to A
      setActiveThreadProject(threadId, PROJECT_UUID_A)
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_A)

      // Verify isActiveProject flags
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
      expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. RELOAD/RE-ENTRY PRESERVES BOTH HISTORY AND ACTIVE PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Reload/re-entry preserves both history and active project', () => {
    it('multiple reads return consistent active project state', async () => {
      const threadId = 'conv-ap-reload-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Multiple reads produce same result
      const read1 = getThreadArtifacts(threadId)
      const read2 = getThreadArtifacts(threadId)
      const read3 = getThreadArtifacts(threadId)

      for (const read of [read1, read2, read3]) {
        expect(read.projectArtifacts).toHaveLength(2)
        expect(read.projectArtifacts[0].isActiveProject).toBe(true)
        expect(read.projectArtifacts[1].isActiveProject).toBe(false)
      }
    })

    it('active project survives re-derivation after explicit switch', async () => {
      const threadId = 'conv-ap-reload-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Switch to B
      setActiveThreadProject(threadId, PROJECT_UUID_B)

      // Re-derive multiple times
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
        expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
      }

      // sourceProjectId stays B
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_B)
    })

    it('history count is preserved across reads', async () => {
      const threadId = 'conv-ap-reload-003'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addProject(seedProject({ id: PROJECT_UUID_C }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      // All three cards visible on every read
      expect(getThreadArtifacts(threadId).projectArtifacts).toHaveLength(3)
      expect(getThreadArtifacts(threadId).projectArtifacts).toHaveLength(3)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. No regression to participant scoping', () => {
    it('participant scoping still works with active project', async () => {
      const conv = seedConversation({
        id: 'conv-ap-scope-001',
        customerUserId: 'cust-scope-A',
        craftsmanUserId: 'craft-scope-B',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-scope-A')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-scope-B')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('artifact records carry participant IDs after active project is set', async () => {
      const threadId = 'conv-ap-scope-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-scope',
        craftsmanUserId: 'craft-scope',
      }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const records = getThreadArtifactRecords(threadId)
        .filter((r) => r.artifactType === 'project')
      expect(records[0].customerUserId).toBe('cust-scope')
      expect(records[0].craftsmanUserId).toBe('craft-scope')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION TO THREAD ARTIFACT RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. No regression to rebuilt thread artifact rendering', () => {
    it('projectArtifact (singular backward-compat) is the first artifact', async () => {
      const threadId = 'conv-ap-compat-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project!.id).toBe(PROJECT_UUID_A)
    })

    it('empty thread returns correct defaults', () => {
      const threadId = 'conv-ap-empty-001'
      addConversation(seedConversation({ id: threadId }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toEqual([])
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.pendingProjectArtifact).toBe(false)
    })

    it('UI source has active project badge and switch action', async () => {
      const fs = await import('fs')
      const cardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/messages/ThreadArtifactProjectCard.tsx'),
        'utf-8'
      )

      // Active project badge
      expect(cardSource).toContain('Hauptprojekt')
      expect(cardSource).toContain('isActiveProject')

      // Switch action for non-active cards
      expect(cardSource).toContain('Als Hauptprojekt setzen')
      expect(cardSource).toContain('onSetActive')
      expect(cardSource).toContain('set-active-project')
    })

    it('screen source wires up setActiveThreadProjectWorkflow', async () => {
      const fs = await import('fs')
      const screenSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      expect(screenSource).toContain('setActiveThreadProjectWorkflow')
      expect(screenSource).toContain('handleSetActiveProject')
      expect(screenSource).toContain('onSetActive')
    })
  })
})
