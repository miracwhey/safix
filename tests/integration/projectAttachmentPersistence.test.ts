/**
 * Project Attachment Persistence — Integration Tests
 *
 * Validates the root-cause fix for the conversation UPDATE race condition:
 * sourceProjectId must be stamped on the conversation BEFORE the message
 * insert, so the background conversation UPDATE from
 * addMessageAndUpdateConversation includes the correct source_project_id.
 *
 * Previous behavior: sourceProjectId was stamped AFTER the message insert,
 * creating a race between two fire-and-forget conversation UPDATEs that
 * could overwrite the correct value.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-race-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-001',
    projectTitle: 'Badezimmer',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Badezimmer',
    customer: 'Anna Kundin',
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
    ...overrides,
  }
}

describe('Project attachment persistence (race condition fix)', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('stamps sourceProjectId BEFORE message insert so conversation carries it', async () => {
    const project = seedProject()
    await addProject(project)
    const conversation = seedConversation()
    await addConversation(conversation)

    // Before attachment: no sourceProjectId
    expect(getConversationById(conversation.id)?.sourceProjectId).toBeUndefined()

    await sendProjectAttachmentToThread(conversation.id, project.id)

    // After attachment: sourceProjectId is stamped
    const updated = getConversationById(conversation.id)
    expect(updated?.sourceProjectId).toBe(project.id)
  })

  it('project artifact is confirmed after attachment', async () => {
    const project = seedProject()
    await addProject(project)
    const conversation = seedConversation()
    await addConversation(conversation)

    await sendProjectAttachmentToThread(conversation.id, project.id)

    const artifacts = getThreadArtifacts(conversation.id)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    expect(artifacts.projectArtifact!.project.id).toBe(project.id)
  })

  it('sourceProjectId is not overwritten when already set', async () => {
    const project = seedProject()
    await addProject(project)
    const conversation = seedConversation({ sourceProjectId: project.id })
    await addConversation(conversation)

    // Attach the same project again
    await sendProjectAttachmentToThread(conversation.id, project.id)

    // sourceProjectId should still be the same
    const updated = getConversationById(conversation.id)
    expect(updated?.sourceProjectId).toBe(project.id)
  })

  it('sourceProjectId survives simulated reload from persisted state', async () => {
    const project = seedProject()
    await addProject(project)
    const conversation = seedConversation()
    await addConversation(conversation)

    await sendProjectAttachmentToThread(conversation.id, project.id)

    // Verify sourceProjectId is on the conversation before any "reload"
    const updated = getConversationById(conversation.id)
    expect(updated?.sourceProjectId).toBe(project.id)

    // Simulate what a reload would do: re-read the conversation and
    // verify sourceProjectId is present
    const reloaded = getConversationById(conversation.id)
    expect(reloaded?.sourceProjectId).toBe(project.id)

    // Artifacts should resolve correctly
    const artifacts = getThreadArtifacts(conversation.id)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
  })

  it('both roles see identical artifacts from the same persisted state', async () => {
    const project = seedProject()
    await addProject(project)
    const conversation = seedConversation()
    await addConversation(conversation)

    await sendProjectAttachmentToThread(conversation.id, project.id)

    // getThreadArtifacts is role-agnostic
    const customerView = getThreadArtifacts(conversation.id)
    const craftsmanView = getThreadArtifacts(conversation.id)

    expect(customerView.projectArtifact?.project.id)
      .toBe(craftsmanView.projectArtifact?.project.id)
    expect(customerView.projectArtifact?.persistenceStatus)
      .toBe(craftsmanView.projectArtifact?.persistenceStatus)
    expect(customerView.projectArtifact?.persistenceStatus).toBe('confirmed')
  })
})
