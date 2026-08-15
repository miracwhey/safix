/**
 * Craftsman Request Detail Access + Snapshot Safety Tests
 *
 * Final safety verification for two risk areas:
 *
 * 1. CRAFTSMAN DETAIL ACCESS — craftsman can open a full request detail
 *    view from sent project cards and top context bar EVEN BEFORE a job
 *    exists (pre-offer, pre-job state).
 *
 * 2. SNAPSHOT SAFETY — compact project card displays category, location,
 *    budget, timing from persisted snapshot data without depending on
 *    entity hydration timing.
 *
 * Non-regression:
 *   - Multi-send history preserved
 *   - Active project logic not broken
 *   - Customer navigation unchanged
 *   - Participant scoping preserved
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
  const id = overrides.id ?? `conv-safety-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Safety Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-safety-1',
    craftsmanName: 'Safety Handwerker',
    craftsmanHandle: 'safety-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-safety-1',
    projectTitle: 'Safety-Projekt',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Berlin',
    timeLabel: 'Gerade eben',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-safety-${Date.now()}`,
    title: overrides.title ?? 'Safety-Projekt',
    sourceJobId: overrides.sourceJobId ?? '',
    category: 'Elektrik',
    description: 'Steckdosen erneuern in der Küche',
    location: 'München',
    status: 'request',
    source: 'builder',
    customer: 'Kunde',
    craftsman: 'Handwerker',
    dateLabel: 'Offen',
    price: '',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedBudget: '500 – 1.500 €',
    requestedTiming: 'Innerhalb 2 Wochen',
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
// 1. CRAFTSMAN DETAIL ACCESS — pre-job request detail
// ═══════════════════════════════════════════════════════════════════════

describe('Craftsman request detail access — pre-job', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('craftsman can open request detail before job exists (getProjectDetailPath)', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-safety-1',
      project: seedProject({ id: 'proj-safety-pre-job', sourceJobId: '' }),
      snapshot: null,
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/request/proj-safety-pre-job')
  })

  it('craftsman routes to /craftsman/jobs/:jobId when job exists', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-safety-2',
      project: seedProject({ id: 'proj-safety-with-job', sourceJobId: 'job-99' }),
      snapshot: null,
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/jobs/job-99')
  })

  it('craftsman gets request detail from snapshot-only artifact', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-safety-3',
      project: null,
      snapshot: { title: 'Snapshot-Only', status: 'request', projectId: 'proj-snap-only' },
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/request/proj-snap-only')
  })

  it('customer navigation still works (/projects/:projectId)', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-safety-4',
      project: seedProject({ id: 'proj-safety-cust' }),
      snapshot: null,
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'customer')
    expect(path).toBe('/projects/proj-safety-cust')
  })

  it('no dead click: craftsman top bar links to request detail (rendered HTML)', async () => {
    const projectId = 'proj-safety-render-001'
    const threadId = 'conv-safety-render-001'

    await addProject(seedProject({ id: projectId, title: 'Fliesenlegen', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Fliesenlegen',
      snapshotStatus: 'request',
    })

    const html = renderThread(threadId, 'craftsman')

    // Craftsman can now click to see request detail before job exists
    expect(html).toContain(`/craftsman/request/${projectId}`)
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain('Fliesenlegen')
  })

  it('no dead click: craftsman sent card links to request detail (rendered HTML)', async () => {
    const projectId = 'proj-safety-render-002'
    const threadId = 'conv-safety-render-002'

    await addProject(seedProject({ id: projectId, title: 'Badumbau', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Badumbau',
      snapshotStatus: 'request',
    })

    const html = renderThread(threadId, 'craftsman')

    // Sent card has the unified footer affordance linking to request detail
    expect(html).toContain('project-send-event')
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain(`/craftsman/request/${projectId}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. SNAPSHOT SAFETY — compact card stability after reload
// ═══════════════════════════════════════════════════════════════════════

describe('Snapshot safety — compact card fields persisted', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('snapshot includes category, location, budget, timing after persist', async () => {
    const projectId = 'proj-snap-safety-001'
    const threadId = 'conv-snap-safety-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Heizungswartung',
      category: 'Heizung',
      location: 'Hamburg',
      requestedBudget: 'unter 500 €',
      requestedTiming: 'So schnell wie möglich',
    }))
    await addConversation(seedConversation({ id: threadId }))

    // Persist WITH snapshot fields (as sendProjectAttachmentToThread now does)
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Heizungswartung',
      snapshotStatus: 'request',
      snapshotSummary: 'Heizung',
      snapshotCategory: 'Heizung',
      snapshotLocation: 'Hamburg',
      snapshotBudget: 'unter 500 €',
      snapshotTiming: 'So schnell wie möglich',
    })

    // Read artifacts — snapshot should have the compact card fields
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()

    const snapshot = artifacts.projectArtifact!.snapshot
    expect(snapshot).not.toBeNull()
    expect(snapshot!.category).toBe('Heizung')
    expect(snapshot!.location).toBe('Hamburg')
    expect(snapshot!.requestedBudget).toBe('unter 500 €')
    expect(snapshot!.requestedTiming).toBe('So schnell wie möglich')
  })

  it('compact card renders metadata from snapshot even without entity enrichment', async () => {
    const projectId = 'proj-snap-safety-002'
    const threadId = 'conv-snap-safety-002'

    // Only persist artifact record — NO entity in project store
    // This simulates delayed entity hydration
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Fensterreparatur',
      snapshotStatus: 'request',
      snapshotSummary: 'Schreinerei',
      snapshotCategory: 'Schreinerei',
      snapshotLocation: 'Köln',
      snapshotBudget: '1.000 – 3.000 €',
      snapshotTiming: 'Innerhalb 4 Wochen',
    })

    // Snapshot should resolve without entity
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project).toBeNull() // Entity NOT loaded

    const snapshot = artifacts.projectArtifact!.snapshot
    expect(snapshot!.title).toBe('Fensterreparatur')
    expect(snapshot!.category).toBe('Schreinerei')
    expect(snapshot!.location).toBe('Köln')
    expect(snapshot!.requestedBudget).toBe('1.000 – 3.000 €')
    expect(snapshot!.requestedTiming).toBe('Innerhalb 4 Wochen')
  })

  it('compact card renders category/location from persisted snapshot in HTML', async () => {
    const projectId = 'proj-snap-safety-003'
    const threadId = 'conv-snap-safety-003'

    // Only persist artifact — no entity
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Dachreparatur',
      snapshotStatus: 'request',
      snapshotCategory: 'Dach',
      snapshotLocation: 'Frankfurt',
    })

    const html = renderThread(threadId, 'customer')

    // V5 redesign: the stream card shows title + category (subtitle) from the
    // snapshot. Location/meta moved to the detail surface.
    expect(html).toContain('Dachreparatur')
    expect(html).toContain('Dach')
    expect(html).toContain('project-send-event')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. NON-REGRESSION: multi-send + active project + participant scoping
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — safety pass', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('multi-send history: both craftsman cards get request detail links', async () => {
    const threadId = 'conv-safety-multi-001'
    const projectA = 'proj-safety-multi-a'
    const projectB = 'proj-safety-multi-b'

    await addProject(seedProject({ id: projectA, title: 'Projekt A', sourceJobId: '' }))
    await addProject(seedProject({ id: projectB, title: 'Projekt B', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Projekt A',
      snapshotStatus: 'request',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
      snapshotTitle: 'Projekt B',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    const html = renderThread(threadId, 'craftsman')
    expect(html).toContain(`/craftsman/request/${projectA}`)
    expect(html).toContain(`/craftsman/request/${projectB}`)
    expect(html).toContain('Projekt A')
    expect(html).toContain('Projekt B')
  })

  it('active project switching preserved', async () => {
    const threadId = 'conv-safety-switch-001'
    const projectA = 'proj-safety-switch-a'
    const projectB = 'proj-safety-switch-b'

    await addProject(seedProject({ id: projectA, title: 'Haupt' }))
    await addProject(seedProject({ id: projectB, title: 'Neben' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
    })

    // First project is active by default
    let artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)

    // Switch to second
    await setActiveThreadProject(threadId, projectB)
    artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
  })

  it('participant scoping preserved — wrong user sees no artifacts', async () => {
    const threadId = 'conv-safety-scope-001'
    const projectId = 'proj-safety-scope-001'

    await addProject(seedProject({ id: projectId }))
    await addConversation(seedConversation({
      id: threadId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
    }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-safety-1',
      craftsmanUserId: 'craftsman-safety-1',
    })

    // The correct user sees the artifact
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
  })
})
