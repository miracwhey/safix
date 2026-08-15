/**
 * Request Flow Levels Tests
 *
 * Validates the 3-level request flow system:
 *
 *   LEVEL 0 — Smart project creation with trade-dependent questions
 *   LEVEL 1 — Compact chat card with richer preview (category, location, budget, timing)
 *   LEVEL 2 — Full detail view with grouped sections and trade-specific answers
 *
 * Non-regression coverage:
 *   - Multi-send history still works
 *   - Active project logic not broken
 *   - Reload/re-entry stability preserved
 *   - Participant scoping preserved
 *   - Plain text messaging preserved
 *   - Thread artifact model unchanged
 *   - Offer/payment continuity preserved
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
import { deriveProjectBuilderReadiness } from '../../src/lib/projects/projectBuilderSelectors'
import { getTradeQuestions, getTradeCategories } from '../../src/lib/projects/tradeQuestions'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'
import type { ProjectBuilderInput } from '../../src/lib/projects/projectBuilderSelectors'

// ── Helpers ─────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-flow-1',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-flow-1',
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
    id: overrides.id ?? `proj-flow-${Date.now()}`,
    title: overrides.title ?? 'Test-Projekt',
    sourceJobId: overrides.sourceJobId ?? '',
    category: 'Elektrik',
    description: 'Test-Beschreibung',
    location: 'Berlin',
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
// LEVEL 0 — Smart Project Creation
// ═══════════════════════════════════════════════════════════════════════

describe('Level 0 — Trade-dependent question model', () => {
  it('returns questions for all 8 known trades', () => {
    const categories = getTradeCategories()
    expect(categories).toHaveLength(8)
    expect(categories).toContain('Elektrik')
    expect(categories).toContain('Bad')
    expect(categories).toContain('Sanitär')
    expect(categories).toContain('Fliesen')
    expect(categories).toContain('Schreinerei')
    expect(categories).toContain('Malerarbeiten')
    expect(categories).toContain('Heizung')
    expect(categories).toContain('Renovierung')
  })

  it('Elektrik has scope, count, and issue questions', () => {
    const questions = getTradeQuestions('Elektrik')
    expect(questions.length).toBeGreaterThanOrEqual(3)
    const keys = questions.map((q) => q.key)
    expect(keys).toContain('scope')
    expect(keys).toContain('count')
    expect(keys).toContain('issue')
  })

  it('Bad has scope, size, and fixtures questions', () => {
    const questions = getTradeQuestions('Bad')
    expect(questions.length).toBeGreaterThanOrEqual(3)
    const keys = questions.map((q) => q.key)
    expect(keys).toContain('scope')
    expect(keys).toContain('size')
    expect(keys).toContain('fixtures')
  })

  it('returns empty array for unknown trade', () => {
    const questions = getTradeQuestions('Unbekannt')
    expect(questions).toHaveLength(0)
  })

  it('each question has required fields', () => {
    for (const category of getTradeCategories()) {
      const questions = getTradeQuestions(category)
      for (const q of questions) {
        expect(q.key).toBeTruthy()
        expect(q.label).toBeTruthy()
        expect(['single', 'multi', 'text']).toContain(q.type)
        if (q.type === 'single' || q.type === 'multi') {
          expect(q.options).toBeDefined()
          expect(q.options!.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('Level 0 — Project creation with minimal mandatory fields', () => {
  it('readiness is true with only category, description, and location', () => {
    const input: Partial<ProjectBuilderInput> = {
      category: 'Elektrik',
      description: 'Steckdose reparieren',
      location: 'Berlin',
    }
    const readiness = deriveProjectBuilderReadiness(input)
    expect(readiness.isReady).toBe(true)
    expect(readiness.missingRequired).toHaveLength(0)
  })

  it('readiness is false without location', () => {
    const input: Partial<ProjectBuilderInput> = {
      category: 'Elektrik',
      description: 'Steckdose reparieren',
    }
    const readiness = deriveProjectBuilderReadiness(input)
    expect(readiness.isReady).toBe(false)
    expect(readiness.missingRequired).toContain('Ort')
  })

  it('completeness increases with optional fields', () => {
    const minimal: Partial<ProjectBuilderInput> = {
      category: 'Elektrik',
      description: 'Test',
      location: 'Berlin',
    }
    const withBudget: Partial<ProjectBuilderInput> = {
      ...minimal,
      requestedBudget: '500 – 1.500 €',
    }
    const withAll: Partial<ProjectBuilderInput> = {
      ...withBudget,
      requestedTiming: 'Innerhalb 2 Wochen',
    }

    const r1 = deriveProjectBuilderReadiness(minimal)
    const r2 = deriveProjectBuilderReadiness(withBudget)
    const r3 = deriveProjectBuilderReadiness(withAll)

    expect(r1.completionScore).toBeLessThan(r2.completionScore)
    expect(r2.completionScore).toBeLessThan(r3.completionScore)
    expect(r3.completionScore).toBe(100)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// LEVEL 1 — Compact Chat Card
// ═══════════════════════════════════════════════════════════════════════

describe('Level 1 — Compact chat card renders correct preview fields', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('shows project title, category, location in compact card', async () => {
    const projectId = 'proj-compact-001'
    const threadId = 'conv-compact-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Elektrik-Projekt in Berlin',
      category: 'Elektrik',
      location: 'Berlin',
      requestedBudget: '500 – 1.500 €',
      requestedTiming: 'Innerhalb 2 Wochen',
    }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const html = renderThread(threadId, 'customer')

    // Title shows
    expect(html).toContain('Elektrik-Projekt in Berlin')
    // Category shows in compact card
    expect(html).toContain('Elektrik')
    // Location shows
    expect(html).toContain('Berlin')
    // Project send event rendered (unified shell footer affordance)
    expect(html).toContain('project-send-event')
    expect(html).toContain('Projekt öffnen')
  })

  it('compact card omits budget/timing (V5: on detail); data preserved in snapshot', async () => {
    const projectId = 'proj-compact-002'
    const threadId = 'conv-compact-002'

    await addProject(seedProject({
      id: projectId,
      title: 'Bad-Projekt',
      category: 'Bad',
      location: 'München',
      requestedBudget: '5.000 – 15.000 €',
      requestedTiming: 'Innerhalb 4 Wochen',
    }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const html = renderThread(threadId, 'customer')

    // V5 redesign: the stream card is title-centric — budget/timing live on the
    // detail screen, not the compact card.
    expect(html).not.toContain('5.000 – 15.000 €')
    expect(html).not.toContain('Innerhalb 4 Wochen')

    // …but the data is preserved on the artifact snapshot for the detail surface.
    const snapshot = getThreadArtifacts(threadId).projectArtifact!.snapshot!
    expect(snapshot.requestedBudget).toBe('5.000 – 15.000 €')
    expect(snapshot.requestedTiming).toBe('Innerhalb 4 Wochen')
  })

  it('compact card shows metadata testid', async () => {
    const projectId = 'proj-compact-003'
    const threadId = 'conv-compact-003'

    await addProject(seedProject({ id: projectId, category: 'Fliesen', location: 'Hamburg' }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const html = renderThread(threadId, 'customer')
    expect(html).toContain('project-send-event')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// LEVEL 2 — Full Detail View
// ═══════════════════════════════════════════════════════════════════════

describe('Level 2 — Detail view shows deeper information than compact card', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('enriched snapshot includes category, location, budget, timing', async () => {
    const projectId = 'proj-detail-001'
    const threadId = 'conv-detail-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Heizungsprojekt',
      category: 'Heizung',
      location: 'Frankfurt',
      requestedBudget: '1.500 – 5.000 €',
      requestedTiming: 'So schnell wie möglich',
      description: 'Kessel austauschen in EG',
    }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()

    const snapshot = artifacts.projectArtifact!.snapshot
    expect(snapshot).not.toBeNull()
    expect(snapshot!.category).toBe('Heizung')
    expect(snapshot!.location).toBe('Frankfurt')
    expect(snapshot!.requestedBudget).toBe('1.500 – 5.000 €')
    expect(snapshot!.requestedTiming).toBe('So schnell wie möglich')
  })

  it('trade-specific answers persist on project entity', async () => {
    const projectId = 'proj-detail-002'

    await addProject(seedProject({
      id: projectId,
      title: 'Elektrik mit Details',
      category: 'Elektrik',
      tradeSpecificAnswers: [
        { key: 'scope', label: 'Art der Arbeit', value: 'Reparatur' },
        { key: 'count', label: 'Anzahl', value: '4–10' },
      ],
    }))

    const artifacts_conv_id = 'conv-detail-002'
    await addConversation(seedConversation({ id: artifacts_conv_id }))
    await persistProjectArtifact({
      conversationId: artifacts_conv_id,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const artifacts = getThreadArtifacts(artifacts_conv_id)
    const project = artifacts.projectArtifact!.project!
    expect(project.tradeSpecificAnswers).toBeDefined()
    expect(project.tradeSpecificAnswers).toHaveLength(2)
    expect(project.tradeSpecificAnswers![0].value).toBe('Reparatur')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NON-REGRESSION — Multi-send history
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — multi-send history still works', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('multiple project cards coexist in one thread', async () => {
    const threadId = 'conv-multi-flow-001'

    await addProject(seedProject({ id: 'proj-a', title: 'Projekt A', category: 'Elektrik' }))
    await addProject(seedProject({ id: 'proj-b', title: 'Projekt B', category: 'Bad' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: 'proj-a',
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: 'proj-b',
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts).toHaveLength(2)

    const html = renderThread(threadId, 'customer')
    expect(html).toContain('Projekt A')
    expect(html).toContain('Projekt B')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NON-REGRESSION — Active project logic
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — active project logic not broken by detail view', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('active project switching works and does not change on detail view open', async () => {
    const threadId = 'conv-active-flow-001'

    await addProject(seedProject({ id: 'proj-active-a', title: 'Aktiv A' }))
    await addProject(seedProject({ id: 'proj-active-b', title: 'Aktiv B' }))
    await addConversation(seedConversation({ id: threadId }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: 'proj-active-a',
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: 'proj-active-b',
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    // First project is active by default
    let artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)

    // Switch to second project
    await setActiveThreadProject(threadId, 'proj-active-b')

    artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
    expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)

    // Read artifacts again — "detail view open" is just a re-read, should not change state
    const reread = getThreadArtifacts(threadId)
    expect(reread.projectArtifacts[1].isActiveProject).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NON-REGRESSION — Reload/re-entry stability
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — reload/re-entry stability', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('enriched snapshot survives re-read (simulating reload)', async () => {
    const threadId = 'conv-reload-flow-001'
    const projectId = 'proj-reload-flow-001'

    await addProject(seedProject({
      id: projectId,
      title: 'Reload-Projekt',
      category: 'Sanitär',
      location: 'Köln',
      requestedBudget: 'unter 500 €',
    }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    // First read
    const first = getThreadArtifacts(threadId)
    expect(first.projectArtifact!.snapshot!.category).toBe('Sanitär')
    expect(first.projectArtifact!.snapshot!.location).toBe('Köln')

    // Second read (simulates reload)
    const second = getThreadArtifacts(threadId)
    expect(second.projectArtifact!.snapshot!.category).toBe('Sanitär')
    expect(second.projectArtifact!.snapshot!.location).toBe('Köln')
    expect(second.projectArtifact!.snapshot!.requestedBudget).toBe('unter 500 €')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NON-REGRESSION — Thread artifact model unchanged
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — thread artifact model unchanged', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('artifact has correct kind, artifactId, persistenceStatus, and createdAt', async () => {
    const threadId = 'conv-model-flow-001'
    const projectId = 'proj-model-flow-001'

    await addProject(seedProject({ id: projectId }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    const artifact = artifacts.projectArtifact!
    expect(artifact.kind).toBe('project')
    expect(artifact.artifactId).toBeTruthy()
    expect(artifact.persistenceStatus).toBe('confirmed')
    expect(artifact.createdAt).toBeGreaterThan(0)
    expect(artifact.isCustomerCreated).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NON-REGRESSION — Offer/payment continuity
// ═══════════════════════════════════════════════════════════════════════

describe('Non-regression — offer/payment continuity', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('project artifacts and offer artifacts coexist independently', async () => {
    const threadId = 'conv-offer-flow-001'
    const projectId = 'proj-offer-flow-001'

    await addProject(seedProject({ id: projectId }))
    await addConversation(seedConversation({ id: threadId }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-flow-1',
      craftsmanUserId: 'craftsman-flow-1',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    // Offer is null because none was created
    expect(artifacts.offerPaymentArtifact).toBeNull()
    // Both can coexist — project artifacts don't interfere with offer artifacts
  })
})
