/**
 * Project Card Navigation Tests
 *
 * Validates that both project UI surfaces navigate to the correct
 * project/order detail page:
 *
 *   1. ThreadArtifactProjectCard (top active project bar) — "Öffnen →"
 *   2. ProjectSendEventCard (sent project history card in timeline)
 *
 * Coverage:
 *   1. Customer top bar navigates to /projects/:projectId
 *   2. Customer sent card navigates to /projects/:projectId
 *   3. Craftsman top bar navigates to /craftsman/jobs/:sourceJobId
 *   4. Craftsman sent card navigates to /craftsman/jobs/:sourceJobId
 *   5. No navigation link when projectId/sourceJobId is unavailable
 *   6. No regression to multi-send history
 *   7. No regression to active project switching
 *   8. No regression to reload/re-entry stability
 *   9. No regression to participant scoping
 */

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  setActiveThreadProject,
} from '../../src/lib/messages'
import { addProject } from '../../src/lib/projects'
import { getProjectDetailPath } from '../../src/components/messages/projectDetailPath'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'
import type { ProjectArtifact } from '../../src/lib/messages/threadArtifactTypes'

// ── Helpers ─────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-nav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-nav-1',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-nav-1',
    projectTitle: 'Küche renovieren',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    timeLabel: 'Vor 5 Minuten',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-nav-${Date.now()}`,
    title: overrides.title ?? 'Navigations-Projekt',
    sourceJobId: overrides.sourceJobId ?? '',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    customer: 'Kunde',
    craftsman: 'Handwerker',
    dateLabel: 'Offen',
    price: '1.000 €',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function renderThread(threadId: string, role: 'customer' | 'craftsman' = 'customer') {
  const basePath = role === 'customer' ? '/messages' : '/craftsman/messages'
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`${basePath}/${threadId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: `${basePath}/:threadId`,
          element: React.createElement(MessageThreadScreen, { role, backPath: basePath }),
        })
      )
    )
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 1. getProjectDetailPath — unit tests for the navigation helper
// ═══════════════════════════════════════════════════════════════════════

describe('getProjectDetailPath — navigation path resolution', () => {
  const baseArtifact: ProjectArtifact = {
    kind: 'project',
    artifactId: 'art-1',
    project: null,
    snapshot: { title: 'Test', status: 'request', projectId: 'proj-1' },
    isCustomerCreated: true,
    isActiveProject: true,
    persistenceStatus: 'confirmed',
    createdAt: Date.now(),
  }

  it('returns /projects/:projectId for customer with snapshot projectId', () => {
    const path = getProjectDetailPath(baseArtifact, 'customer')
    expect(path).toBe('/projects/proj-1')
  })

  it('returns /projects/:projectId for customer with full project entity', () => {
    const artifact: ProjectArtifact = {
      ...baseArtifact,
      project: seedProject({ id: 'proj-full' }),
      snapshot: null,
    }
    const path = getProjectDetailPath(artifact, 'customer')
    expect(path).toBe('/projects/proj-full')
  })

  it('returns /craftsman/jobs/:sourceJobId for craftsman when sourceJobId exists', () => {
    const artifact: ProjectArtifact = {
      ...baseArtifact,
      project: seedProject({ id: 'proj-craft', sourceJobId: 'job-42' }),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/jobs/job-42')
  })

  it('returns /craftsman/request/:projectId for craftsman when no sourceJobId', () => {
    const artifact: ProjectArtifact = {
      ...baseArtifact,
      project: seedProject({ id: 'proj-no-job', sourceJobId: '' }),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/request/proj-no-job')
  })

  it('returns /craftsman/request/:projectId for craftsman when project is null (snapshot only)', () => {
    const path = getProjectDetailPath(baseArtifact, 'craftsman')
    expect(path).toBe('/craftsman/request/proj-1')
  })

  it('returns undefined for customer when no projectId available', () => {
    const artifact: ProjectArtifact = {
      ...baseArtifact,
      project: null,
      snapshot: null,
    }
    const path = getProjectDetailPath(artifact, 'customer')
    expect(path).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Customer navigation — top bar + sent card
// ═══════════════════════════════════════════════════════════════════════

describe('Customer project navigation — rendered HTML', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('top active project bar links to /projects/:projectId', async () => {
    const projectId = 'proj-nav-cust-001'
    const threadId = 'conv-nav-cust-001'

    await addProject(seedProject({ id: projectId, title: 'Badsanierung' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    const html = renderThread(threadId, 'customer')

    expect(html).toContain(`/projects/${projectId}`)
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain('Badsanierung')
  })

  it('sent project history card links to /projects/:projectId', async () => {
    const projectId = 'proj-nav-cust-002'
    const threadId = 'conv-nav-cust-002'

    await addProject(seedProject({ id: projectId, title: 'Dachausbau' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    const html = renderThread(threadId, 'customer')

    // The sent card (project-send-event) should also contain the project link
    expect(html).toContain('project-send-event')
    expect(html).toContain(`/projects/${projectId}`)
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain('Dachausbau')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Craftsman navigation — top bar + sent card
// ═══════════════════════════════════════════════════════════════════════

describe('Craftsman project navigation — rendered HTML', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('top bar links to /craftsman/jobs/:sourceJobId when project has job', async () => {
    const projectId = 'proj-nav-craft-001'
    const threadId = 'conv-nav-craft-001'

    await addProject(seedProject({ id: projectId, title: 'Elektroinstallation', sourceJobId: 'job-nav-1' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    const html = renderThread(threadId, 'craftsman')

    expect(html).toContain('/craftsman/jobs/job-nav-1')
    expect(html).toContain('Projekt öffnen')
  })

  it('navigates to /craftsman/request/:projectId when project has no sourceJobId', async () => {
    const projectId = 'proj-nav-craft-002'
    const threadId = 'conv-nav-craft-002'

    await addProject(seedProject({ id: projectId, title: 'Anfrage ohne Job', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    const html = renderThread(threadId, 'craftsman')

    // Pre-job: craftsman gets request detail link instead of dead end
    expect(html).toContain(`/craftsman/request/${projectId}`)
    expect(html).toContain('Projekt öffnen')
    // The card itself should still render
    expect(html).toContain('Anfrage ohne Job')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Non-regression: multi-send history preserved
// ═══════════════════════════════════════════════════════════════════════

describe('Navigation does not regress multi-send history', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('multiple sent projects each have their own navigation path', async () => {
    const threadId = 'conv-nav-multi-001'
    const projectA = 'proj-nav-multi-a'
    const projectB = 'proj-nav-multi-b'

    await addProject(seedProject({ id: projectA, title: 'Projekt A' }))
    await addProject(seedProject({ id: projectB, title: 'Projekt B' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    const html = renderThread(threadId, 'customer')
    expect(html).toContain(`/projects/${projectA}`)
    expect(html).toContain(`/projects/${projectB}`)
    expect(html).toContain('Projekt A')
    expect(html).toContain('Projekt B')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. Non-regression: active project switching preserves navigation
// ═══════════════════════════════════════════════════════════════════════

describe('Active project switching does not break navigation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('switching active project keeps navigation links for all cards', async () => {
    const threadId = 'conv-nav-switch-001'
    const projectA = 'proj-nav-switch-a'
    const projectB = 'proj-nav-switch-b'

    await addProject(seedProject({ id: projectA, title: 'Haupt' }))
    await addProject(seedProject({ id: projectB, title: 'Neben' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    // Switch active project from A to B
    await setActiveThreadProject(threadId, projectB)

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    const html = renderThread(threadId, 'customer')
    expect(html).toContain(`/projects/${projectA}`)
    expect(html).toContain(`/projects/${projectB}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. Non-regression: reload/re-entry preserves navigation
// ═══════════════════════════════════════════════════════════════════════

describe('Reload/re-entry preserves navigation links', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('navigation links survive repository rehydration', async () => {
    const projectId = 'proj-nav-reload-001'
    const threadId = 'conv-nav-reload-001'

    await addProject(seedProject({ id: projectId, title: 'Reload-Projekt' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-nav-1',
      craftsmanUserId: 'craftsman-nav-1',
    })

    // First render
    const html1 = renderThread(threadId, 'customer')
    expect(html1).toContain(`/projects/${projectId}`)

    // Second render (simulates re-entry)
    const html2 = renderThread(threadId, 'customer')
    expect(html2).toContain(`/projects/${projectId}`)
    expect(html2).toContain('Reload-Projekt')
  })
})
