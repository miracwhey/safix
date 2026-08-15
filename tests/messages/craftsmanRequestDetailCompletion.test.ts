/**
 * Craftsman Request Detail Completion — End-to-End Tests
 *
 * Validates the complete craftsman request detail flow:
 *
 * 1. Pre-job request detail — craftsman can open request detail from
 *    active project bar and sent project cards BEFORE a job exists.
 * 2. Post-job job detail — craftsman routes to job detail when sourceJobId exists.
 * 3. Snapshot fallback — craftsman sees request detail from artifact snapshot
 *    when the full project entity is NOT loaded in the project store.
 * 4. No false "Anfrage nicht gefunden" — valid requests always resolve.
 * 5. Structured request info — detail page shows enough data for evaluation.
 * 6. Non-regression — customer detail, multi-send history, active project,
 *    participant scoping, and reload/re-entry stability remain intact.
 */

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import CraftsmanRequestDetailScreen from '../../src/screens/CraftsmanRequestDetailScreen'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  setActiveThreadProject,
  findArtifactRecordsByProjectId,
} from '../../src/lib/messages'
import { addProject, getProjectById } from '../../src/lib/projects'
import { getProjectDetailPath } from '../../src/components/messages/projectDetailPath'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'
import type { ProjectArtifact } from '../../src/lib/messages/threadArtifactTypes'

// ── Helpers ─────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-crd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'CRD Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-crd-1',
    craftsmanName: 'CRD Handwerker',
    craftsmanHandle: 'crd-handler',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-crd-1',
    projectTitle: 'CRD-Projekt',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Berlin',
    timeLabel: 'Gerade eben',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-crd-${Date.now()}`,
    title: overrides.title ?? 'CRD-Projekt',
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

function renderCraftsmanRequestDetail(projectId: string) {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/craftsman/request/${projectId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/craftsman/request/:projectId',
          element: React.createElement(CraftsmanRequestDetailScreen),
        })
      )
    )
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CRAFTSMAN OPENS REQUEST DETAIL FROM ACTIVE PROJECT BAR (PRE-JOB)
// ═══════════════════════════════════════════════════════════════════════

describe('Craftsman request detail from active project bar — pre-job', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('active project bar links to /craftsman/request/:projectId before job exists', async () => {
    const projectId = 'proj-crd-topbar-001'
    const threadId = 'conv-crd-topbar-001'

    await addProject(seedProject({ id: projectId, title: 'Fliesenlegen', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Fliesenlegen',
      snapshotStatus: 'request',
    })

    const html = renderThread(threadId, 'craftsman')

    expect(html).toContain(`/craftsman/request/${projectId}`)
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain('Fliesenlegen')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. CRAFTSMAN OPENS REQUEST DETAIL FROM SENT PROJECT HISTORY CARD
// ═══════════════════════════════════════════════════════════════════════

describe('Craftsman request detail from sent project card — pre-job', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('sent project card links to /craftsman/request/:projectId before job exists', async () => {
    const projectId = 'proj-crd-sentcard-001'
    const threadId = 'conv-crd-sentcard-001'

    await addProject(seedProject({ id: projectId, title: 'Badumbau', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Badumbau',
      snapshotStatus: 'request',
    })

    const html = renderThread(threadId, 'craftsman')

    expect(html).toContain('project-send-event')
    expect(html).toContain('Projekt öffnen')
    expect(html).toContain(`/craftsman/request/${projectId}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. CRAFTSMAN ROUTES TO JOB DETAIL WHEN sourceJobId EXISTS
// ═══════════════════════════════════════════════════════════════════════

describe('Craftsman routes to job detail when sourceJobId exists', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('getProjectDetailPath returns /craftsman/jobs/:jobId when sourceJobId exists', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-crd-job-1',
      project: seedProject({ id: 'proj-crd-with-job', sourceJobId: 'job-42' }),
      snapshot: null,
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'craftsman')
    expect(path).toBe('/craftsman/jobs/job-42')
  })

  it('sent card in thread links to /craftsman/jobs/:jobId when job exists', async () => {
    const projectId = 'proj-crd-postjob-001'
    const threadId = 'conv-crd-postjob-001'

    await addProject(seedProject({ id: projectId, title: 'Installiertes Projekt', sourceJobId: 'job-installed' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Installiertes Projekt',
      snapshotStatus: 'accepted',
    })

    const html = renderThread(threadId, 'craftsman')
    expect(html).toContain('/craftsman/jobs/job-installed')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. VALID REQUEST DOES NOT END IN NOT-FOUND (SNAPSHOT FALLBACK)
// ═══════════════════════════════════════════════════════════════════════

describe('Valid request does not show "Anfrage nicht gefunden"', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('request detail resolves from project entity when available', async () => {
    const projectId = 'proj-crd-entity-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Küchenmontage',
      category: 'Schreinerei',
      location: 'Hamburg',
    }))

    const html = renderCraftsmanRequestDetail(projectId)

    expect(html).toContain('Küchenmontage')
    expect(html).toContain('Schreinerei')
    expect(html).toContain('Hamburg')
    expect(html).not.toContain('Anfrage nicht gefunden')
  })

  it('request detail resolves from snapshot when project entity NOT loaded', async () => {
    const projectId = 'proj-crd-snapshot-only-001'
    const threadId = 'conv-crd-snapshot-001'

    // Only persist artifact with snapshot — NO project entity in store
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Fensterreparatur',
      snapshotStatus: 'request',
      snapshotCategory: 'Schreinerei',
      snapshotLocation: 'Köln',
      snapshotBudget: '1.000 – 3.000 €',
      snapshotTiming: 'Innerhalb 4 Wochen',
    })

    // Verify: entity NOT in project store
    expect(getProjectById(projectId)).toBeUndefined()

    const html = renderCraftsmanRequestDetail(projectId)

    // Should render from snapshot — NOT show "not found"
    expect(html).toContain('Fensterreparatur')
    expect(html).toContain('request-detail-view')
    expect(html).not.toContain('Anfrage nicht gefunden')
  })

  it('shows "Anfrage nicht gefunden" only for genuinely missing requests', () => {
    const html = renderCraftsmanRequestDetail('proj-genuinely-missing')

    expect(html).toContain('Anfrage nicht gefunden')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. REQUEST DETAIL SHOWS STRUCTURED REQUEST INFO
// ═══════════════════════════════════════════════════════════════════════

describe('Request detail shows structured request info', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('shows title, category, location, budget, timing from full entity', async () => {
    const projectId = 'proj-crd-info-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Elektroinstallation',
      category: 'Elektrik',
      location: 'Frankfurt',
      requestedBudget: '2.000 – 5.000 €',
      requestedTiming: 'Innerhalb 4 Wochen',
      description: 'Komplette Neuverkabelung der Wohnung',
    }))

    const html = renderCraftsmanRequestDetail(projectId)

    expect(html).toContain('Elektroinstallation')
    expect(html).toContain('Elektrik')
    expect(html).toContain('Frankfurt')
    expect(html).toContain('2.000 – 5.000 €')
    expect(html).toContain('Innerhalb 4 Wochen')
    expect(html).toContain('Komplette Neuverkabelung der Wohnung')
    expect(html).toContain('request-detail-view')
  })

  it('shows structured info from snapshot when entity not loaded', async () => {
    const projectId = 'proj-crd-snapinfo-001'
    const threadId = 'conv-crd-snapinfo-001'

    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Heizungswartung',
      snapshotStatus: 'request',
      snapshotCategory: 'Heizung',
      snapshotLocation: 'Düsseldorf',
      snapshotBudget: 'unter 500 €',
      snapshotTiming: 'So schnell wie möglich',
    })

    const html = renderCraftsmanRequestDetail(projectId)

    expect(html).toContain('Heizungswartung')
    expect(html).toContain('Heizung')
    expect(html).toContain('Düsseldorf')
    expect(html).toContain('unter 500 €')
    expect(html).toContain('So schnell wie möglich')
    expect(html).toContain('request-detail-view')
  })

  it('shows trade-specific answers from full entity', async () => {
    const projectId = 'proj-crd-trade-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Badezimmerumbau',
      category: 'Bad',
      tradeSpecificAnswers: [
        { key: 'shower', label: 'Duschkabine gewünscht?', value: 'Ja, bodenbündig' },
        { key: 'tiles', label: 'Fliesenwunsch', value: 'Großformat 60x60' },
      ],
    }))

    const html = renderCraftsmanRequestDetail(projectId)

    expect(html).toContain('Badezimmerumbau')
    expect(html).toContain('trade-specific-answers')
    expect(html).toContain('Duschkabine gewünscht?')
    expect(html).toContain('Ja, bodenbündig')
    expect(html).toContain('Fliesenwunsch')
    expect(html).toContain('Großformat 60x60')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. findArtifactRecordsByProjectId — unit tests
// ═══════════════════════════════════════════════════════════════════════

describe('findArtifactRecordsByProjectId', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('returns matching artifact records for a projectId', async () => {
    const threadId = 'conv-crd-find-001'
    const projectId = 'proj-crd-find-001'

    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      snapshotTitle: 'Test Project',
      snapshotStatus: 'request',
      snapshotCategory: 'Elektrik',
    })

    const records = findArtifactRecordsByProjectId(projectId)
    expect(records).toHaveLength(1)
    expect(records[0].projectId).toBe(projectId)
    expect(records[0].snapshotTitle).toBe('Test Project')
    expect(records[0].snapshotCategory).toBe('Elektrik')
  })

  it('returns empty array when no matching records exist', () => {
    const records = findArtifactRecordsByProjectId('proj-nonexistent')
    expect(records).toHaveLength(0)
  })

  it('only returns project artifact types (not offer/payment)', async () => {
    const threadId = 'conv-crd-find-002'
    const projectId = 'proj-crd-find-002'

    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      snapshotTitle: 'Project Record',
    })

    // The records returned should only be project type
    const records = findArtifactRecordsByProjectId(projectId)
    expect(records).toHaveLength(1)
    expect(records[0].artifactType).toBe('project')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. NON-REGRESSION — customer detail access
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — customer detail access', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('customer navigation still routes to /projects/:projectId', () => {
    const artifact: ProjectArtifact = {
      kind: 'project',
      artifactId: 'art-crd-cust-1',
      project: seedProject({ id: 'proj-crd-cust-001' }),
      snapshot: null,
      isCustomerCreated: true,
      isActiveProject: true,
      persistenceStatus: 'confirmed',
      createdAt: Date.now(),
    }
    const path = getProjectDetailPath(artifact, 'customer')
    expect(path).toBe('/projects/proj-crd-cust-001')
  })

  it('customer thread still renders project cards correctly', async () => {
    const projectId = 'proj-crd-custreg-001'
    const threadId = 'conv-crd-custreg-001'

    await addProject(seedProject({ id: projectId, title: 'Kundenansicht' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Kundenansicht',
      snapshotStatus: 'request',
    })

    const html = renderThread(threadId, 'customer')
    expect(html).toContain('Kundenansicht')
    expect(html).toContain(`/projects/${projectId}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 8. NON-REGRESSION — multi-send project history
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — multi-send project history', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('multi-send: both projects get request detail links for craftsman', async () => {
    const threadId = 'conv-crd-multi-001'
    const projectA = 'proj-crd-multi-a'
    const projectB = 'proj-crd-multi-b'

    await addProject(seedProject({ id: projectA, title: 'Projekt Alpha', sourceJobId: '' }))
    await addProject(seedProject({ id: projectB, title: 'Projekt Beta', sourceJobId: '' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Projekt Alpha',
      snapshotStatus: 'request',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
      snapshotTitle: 'Projekt Beta',
      snapshotStatus: 'request',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    const html = renderThread(threadId, 'craftsman')
    expect(html).toContain(`/craftsman/request/${projectA}`)
    expect(html).toContain(`/craftsman/request/${projectB}`)
    expect(html).toContain('Projekt Alpha')
    expect(html).toContain('Projekt Beta')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 9. NON-REGRESSION — active project logic
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — active project logic', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('active project switching preserved', async () => {
    const threadId = 'conv-crd-active-001'
    const projectA = 'proj-crd-active-a'
    const projectB = 'proj-crd-active-b'

    await addProject(seedProject({ id: projectA, title: 'Haupt' }))
    await addProject(seedProject({ id: projectB, title: 'Neben' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectA,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: projectB,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
    })

    let artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)

    await setActiveThreadProject(threadId, projectB)
    artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 10. NON-REGRESSION — participant scoping
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — participant scoping', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('artifact scoping preserved — correct user sees artifact', async () => {
    const threadId = 'conv-crd-scope-001'
    const projectId = 'proj-crd-scope-001'

    await addProject(seedProject({ id: projectId }))
    await addConversation(seedConversation({
      id: threadId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
    }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-crd-1',
      craftsmanUserId: 'craftsman-crd-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 11. NON-REGRESSION — reload/re-entry stability
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — reload/re-entry stability', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('craftsman request detail is stable across re-render (entity path)', async () => {
    const projectId = 'proj-crd-reload-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Stabile Anfrage',
      category: 'Malerarbeiten',
    }))

    // First render
    const html1 = renderCraftsmanRequestDetail(projectId)
    expect(html1).toContain('Stabile Anfrage')
    expect(html1).toContain('request-detail-view')
    expect(html1).not.toContain('Anfrage nicht gefunden')

    // Second render (simulate re-entry)
    const html2 = renderCraftsmanRequestDetail(projectId)
    expect(html2).toContain('Stabile Anfrage')
    expect(html2).toContain('request-detail-view')
    expect(html2).not.toContain('Anfrage nicht gefunden')
  })

  it('craftsman request detail is stable across re-render (snapshot path)', async () => {
    const projectId = 'proj-crd-reload-snap-001'
    const threadId = 'conv-crd-reload-snap-001'

    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      snapshotTitle: 'Snapshot-Stabil',
      snapshotStatus: 'request',
      snapshotCategory: 'Fliesen',
    })

    // First render
    const html1 = renderCraftsmanRequestDetail(projectId)
    expect(html1).toContain('Snapshot-Stabil')
    expect(html1).not.toContain('Anfrage nicht gefunden')

    // Second render
    const html2 = renderCraftsmanRequestDetail(projectId)
    expect(html2).toContain('Snapshot-Stabil')
    expect(html2).not.toContain('Anfrage nicht gefunden')
  })
})
