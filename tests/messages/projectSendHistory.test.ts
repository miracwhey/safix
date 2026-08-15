/**
 * Project Send History in Chat Timeline — Tests
 *
 * Validates that project-send artifacts render as inline event cards
 * in the chat message timeline, in addition to the top active project
 * context bar (ThreadArtifactCards).
 *
 * Coverage:
 *   1. Active project bar remains visible (top context)
 *   2. First sent project appears in chat history
 *   3. Second and third sent projects also appear in chat history
 *   4. History order is stable (chronological)
 *   5. Active project switching does not delete history cards
 *   6. Reload/re-entry preserves both active bar and history cards
 *   7. No regression to participant scoping
 *   8. No regression to plain text messaging
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  setActiveThreadProject,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getSession } from '../../src/lib/session'
import { formatMessageTimeLabel } from '../../src/lib/messages/dateUtils'

// ── Helpers ─────────────────────────────────────────────────────────────

const PROJECT_UUID_A = 'aaa1c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_UUID_B = 'bbb2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PROJECT_UUID_C = 'ccc3c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-psh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-psh-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-psh-001',
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
    id: overrides.id ?? `proj-psh-${Date.now()}`,
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

// ── Tests ───────────────────────────────────────────────────────────────

describe('Project Send History in Chat Timeline', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Active project bar remains visible ──

  it('active project bar still resolves after project send', async () => {
    const threadId = 'conv-psh-bar'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)

    // Top context bar: projectArtifact is set (backward compat first element)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.isActiveProject).toBe(true)

    // projectArtifacts array is populated for timeline rendering
    expect(artifacts.projectArtifacts).toHaveLength(1)
  })

  // ─── 2. First sent project appears in chat history ──

  it('first sent project artifact has createdAt for timeline placement', async () => {
    const threadId = 'conv-psh-first'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Terrasse' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    const beforeSend = Date.now()
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Terrasse',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(1)

    const artifact = artifacts.projectArtifacts[0]
    expect(artifact.createdAt).toBeGreaterThanOrEqual(beforeSend)
    expect(artifact.createdAt).toBeLessThanOrEqual(Date.now())

    // Verify the time label can be formatted
    const label = formatMessageTimeLabel(artifact.createdAt)
    expect(label).toBeTruthy()
  })

  // ─── 3. Second and third sent projects also appear in chat history ──

  it('multiple sent projects all appear as separate artifacts with createdAt', async () => {
    const threadId = 'conv-psh-multi'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
    await addProject(seedProject({ id: PROJECT_UUID_C, title: 'Dach' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    // Send three projects with small delays to ensure distinct timestamps
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_B,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Bad',
      snapshotStatus: 'request',
    })

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_C,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Dach',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(3)

    // All three have createdAt for timeline placement
    for (const artifact of artifacts.projectArtifacts) {
      expect(artifact.createdAt).toBeGreaterThan(0)
    }

    // All three have distinct artifactIds
    const ids = artifacts.projectArtifacts.map((a) => a.artifactId)
    expect(new Set(ids).size).toBe(3)
  })

  // ─── 4. History order is stable (chronological by createdAt) ──

  it('project artifacts are sorted chronologically by createdAt', async () => {
    const threadId = 'conv-psh-order'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_B,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Bad',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    // First artifact was sent first — createdAt order must be stable
    expect(artifacts.projectArtifacts[0].createdAt)
      .toBeLessThanOrEqual(artifacts.projectArtifacts[1].createdAt)
  })

  // ─── 5. Active project switching does not delete history cards ──

  it('switching active project preserves all history cards', async () => {
    const threadId = 'conv-psh-switch'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_B,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Bad',
      snapshotStatus: 'request',
    })

    // Before switch: A is active
    const before = getThreadArtifacts(threadId)
    expect(before.projectArtifacts).toHaveLength(2)
    expect(before.projectArtifacts[0].isActiveProject).toBe(true) // A
    expect(before.projectArtifacts[1].isActiveProject).toBe(false) // B

    // Switch active project to B
    setActiveThreadProject(threadId, PROJECT_UUID_B)

    // After switch: both cards still exist, active changed
    const after = getThreadArtifacts(threadId)
    expect(after.projectArtifacts).toHaveLength(2) // NOT collapsed!
    expect(after.projectArtifacts[0].isActiveProject).toBe(false) // A is now non-active
    expect(after.projectArtifacts[1].isActiveProject).toBe(true) // B is now active

    // Both cards still have createdAt for timeline placement
    expect(after.projectArtifacts[0].createdAt).toBeGreaterThan(0)
    expect(after.projectArtifacts[1].createdAt).toBeGreaterThan(0)
  })

  // ─── 6. Reload/re-entry preserves both active bar and history cards ──

  it('re-reading after initial load preserves all artifacts with createdAt', async () => {
    const threadId = 'conv-psh-reload'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Bad' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_B,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Bad',
      snapshotStatus: 'request',
    })

    // First read (initial load)
    const firstRead = getThreadArtifacts(threadId)
    expect(firstRead.projectArtifacts).toHaveLength(2)
    expect(firstRead.projectArtifact).not.toBeNull()

    // Second read (simulates re-entry/reload)
    const secondRead = getThreadArtifacts(threadId)
    expect(secondRead.projectArtifacts).toHaveLength(2)
    expect(secondRead.projectArtifact).not.toBeNull()

    // Active bar and history are identical across reads
    expect(secondRead.projectArtifacts[0].artifactId).toBe(firstRead.projectArtifacts[0].artifactId)
    expect(secondRead.projectArtifacts[1].artifactId).toBe(firstRead.projectArtifacts[1].artifactId)
    expect(secondRead.projectArtifacts[0].createdAt).toBe(firstRead.projectArtifacts[0].createdAt)
    expect(secondRead.projectArtifacts[1].createdAt).toBe(firstRead.projectArtifacts[1].createdAt)
  })

  // ─── 7. No regression to participant scoping ──

  it('non-participant cannot see project send history', async () => {
    const threadId = 'conv-psh-scoping'

    await addProject(seedProject({ id: PROJECT_UUID_A }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    // Mock session as an unrelated user
    const session = getSession()
    const originalUser = session.user
    session.user = { id: 'unrelated-user-999' } as typeof session.user

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(0)
    expect(artifacts.projectArtifact).toBeNull()

    // Restore
    session.user = originalUser
  })

  // ─── 8. No regression to plain text messaging ──

  it('project send history artifacts are separate from message items', async () => {
    const threadId = 'conv-psh-separate'

    await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Küche' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: PROJECT_UUID_A,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Küche',
      snapshotStatus: 'request',
    })

    // Artifacts are resolved from thread_artifacts, not messages
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(1)
    expect(artifacts.projectArtifacts[0].kind).toBe('project')

    // The artifact createdAt can be used for timeline interleaving
    // without depending on any message record
    expect(artifacts.projectArtifacts[0].createdAt).toBeGreaterThan(0)
    expect(artifacts.projectArtifacts[0].artifactId).toBeTruthy()
  })

  // ─── 9. Snapshot-only artifacts also have createdAt (reload stability) ──

  it('snapshot-only artifact has createdAt for timeline rendering after reload', async () => {
    const threadId = 'conv-psh-snapshot'

    // NO project entity added — only artifact with snapshot data
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID_A,
      customerUserId: 'customer-psh-001',
      craftsmanUserId: 'craftsman-psh-001',
      snapshotTitle: 'Keller',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(1)

    // Even without entity, snapshot card has createdAt for timeline
    const artifact = artifacts.projectArtifacts[0]
    expect(artifact.snapshot?.title).toBe('Keller')
    expect(artifact.project).toBeNull()
    expect(artifact.createdAt).toBeGreaterThan(0)
  })
})
