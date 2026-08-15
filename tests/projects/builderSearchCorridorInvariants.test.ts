/**
 * Builder → Search → Inquiry corridor invariants
 *
 * Hardens the exact path:
 *   Projekt erstellen → Aus Projekt suchen → Handwerker auswählen → Inquiry/Chat
 *
 * These tests guard against:
 * - Selector drift between Home, Search, and Inquiry for the same project
 * - Builder field loss after Supabase round-trip (row → Project → row)
 * - Cancelled/completed projects appearing in the search picker
 * - Inquiry misBinding (wrong project attached to conversation)
 * - deriveSearchCriteriaFromProject returning non-null for incomplete projects
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installMockSession, mockCustomerSession, resetMockSession } from '../helpers/mockSession'
import { getProjectRepository } from '../../src/lib/projects/repository/registry'
import {
  isBuilderProjectPending,
  isProjectActive,
} from '../../src/lib/projects'
import {
  deriveSearchCriteriaFromProject,
} from '../../src/lib/explore/searchCriteriaSelectors'
import {
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'
import { getConversationById } from '../../src/lib/messages'
import type { Project } from '../../src/lib/projects/projectTypes'
import type { ExploreProviderCard } from '../../src/lib/explore/exploreTypes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROVIDER: ExploreProviderCard = {
  craftsmanId: 'user-craftsman-1',
  craftsmanName: 'Max Meister',
  craftsmanHandle: 'max-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Elektrik',
  tradeCategories: ['Elektrik'],
  servicesOffered: ['Sicherungskasten', 'Steckdosen'],
  serviceRadiusKm: 50,
}

/** Minimal valid builder project — all required search fields present. */
function makeBuilderProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-builder-test-1',
    sourceJobId: '',
    title: 'Elektrik-Projekt in Berlin',
    customer: 'Test Kunde',
    craftsman: '',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'builder',
    category: 'Elektrik',
    description: 'Sicherungskasten modernisieren',
    customerUserId: 'user-customer-1',
    ...overrides,
  }
}

// The subset of projects that SearchScreen renders in its "Aus Projekt" picker.
// Mirrors SearchScreen.tsx: category present + not cancelled/completed.
function searchPickerFilter(projects: Project[]): Project[] {
  return projects.filter(
    (p) =>
      Boolean(p.category?.trim()) &&
      p.status !== 'cancelled' &&
      p.status !== 'completed'
  )
}

// ---------------------------------------------------------------------------
// A. Builder field persistence round-trip (rowToProject symmetry)
// ---------------------------------------------------------------------------

describe('Builder field persistence — Supabase row round-trip', () => {
  it('rowToProject preserves category after mapping', () => {
    // SupabaseProjectRepository.rowToProject maps category directly.
    // We verify via the in-memory repository that add/getById round-trips
    // the critical builder fields (real Supabase path is covered by
    // projectBuilderSupabasePath.test.ts).
    beforeEach(() => { setupCleanRepositories() })
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'rtr-1' })
    void repo.add(project)
    const read = repo.getById('rtr-1')
    expect(read?.category).toBe('Elektrik')
    expect(read?.source).toBe('builder')
    expect(read?.description).toBe('Sicherungskasten modernisieren')
    expect(read?.location).toBe('Berlin')
  })
})

// ---------------------------------------------------------------------------
// B. Search picker filter — eligible / excluded projects
// ---------------------------------------------------------------------------

describe('Search picker filter (categorisedProjects equivalent)', () => {
  it('includes a valid builder project with category', () => {
    const p = makeBuilderProject()
    expect(searchPickerFilter([p])).toHaveLength(1)
  })

  it('excludes a cancelled project', () => {
    const p = makeBuilderProject({ status: 'cancelled' })
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('excludes a completed project', () => {
    const p = makeBuilderProject({ status: 'completed' })
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('excludes a project with no category', () => {
    const p = makeBuilderProject({ category: undefined })
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('excludes a project with empty category string', () => {
    const p = makeBuilderProject({ category: '   ' })
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('includes a project in request status (pending builder project)', () => {
    const p = makeBuilderProject({ status: 'request' })
    expect(searchPickerFilter([p])).toHaveLength(1)
  })

  it('includes a project in accepted status (linked to job but eligible for second handyman)', () => {
    const p = makeBuilderProject({ status: 'accepted', sourceJobId: 'job-1' })
    expect(searchPickerFilter([p])).toHaveLength(1)
  })

  it('includes a project in in_progress status', () => {
    const p = makeBuilderProject({ status: 'in_progress' })
    expect(searchPickerFilter([p])).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// C. Home selector consistency — isBuilderProjectPending vs search filter
// ---------------------------------------------------------------------------

describe('Home selector vs search picker consistency', () => {
  it('a pending builder project is visible on both Home and in the search picker', () => {
    const p = makeBuilderProject({ status: 'request', sourceJobId: '' })
    expect(isBuilderProjectPending(p)).toBe(true)
    expect(searchPickerFilter([p])).toHaveLength(1)
  })

  it('a cancelled project is invisible on both Home and in the search picker', () => {
    const p = makeBuilderProject({ status: 'cancelled' })
    expect(isBuilderProjectPending(p)).toBe(false)
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('a completed project is invisible on both Home and in the search picker', () => {
    const p = makeBuilderProject({ status: 'completed' })
    expect(isBuilderProjectPending(p)).toBe(false)
    expect(searchPickerFilter([p])).toHaveLength(0)
  })

  it('isProjectActive matches search picker for in-flight statuses', () => {
    const statuses: Array<Project['status']> = ['request', 'accepted', 'scheduled', 'in_progress', 'review']
    for (const status of statuses) {
      const p = makeBuilderProject({ status })
      expect(isProjectActive(p)).toBe(true)
      expect(searchPickerFilter([p])).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// D. SearchCriteria derivation
// ---------------------------------------------------------------------------

describe('deriveSearchCriteriaFromProject', () => {
  it('returns valid criteria from a complete builder project', () => {
    const p = makeBuilderProject()
    const criteria = deriveSearchCriteriaFromProject(p)
    expect(criteria).not.toBeNull()
    expect(criteria?.category).toBe('Elektrik')
    expect(criteria?.description).toBe('Sicherungskasten modernisieren')
    expect(criteria?.location).toBe('Berlin')
  })

  it('returns null for a project missing description', () => {
    const p = makeBuilderProject({ description: '' })
    expect(deriveSearchCriteriaFromProject(p)).toBeNull()
  })

  it('returns null for a project missing category', () => {
    const p = makeBuilderProject({ category: '' })
    expect(deriveSearchCriteriaFromProject(p)).toBeNull()
  })

  it('returns null for a project missing location', () => {
    const p = makeBuilderProject({ location: '' })
    expect(deriveSearchCriteriaFromProject(p)).toBeNull()
  })

  it('propagates requestedBudget to criteria when present', () => {
    const p = makeBuilderProject({ requestedBudget: '1.000 – 2.000 €' })
    const criteria = deriveSearchCriteriaFromProject(p)
    expect(criteria?.budget).toBe('1.000 – 2.000 €')
  })

  it('propagates requestedTiming to criteria when present', () => {
    const p = makeBuilderProject({ requestedTiming: 'So schnell wie möglich' })
    const criteria = deriveSearchCriteriaFromProject(p)
    expect(criteria?.timing).toBe('So schnell wie möglich')
  })

  it('leaves budget/timing undefined when not set on project', () => {
    const p = makeBuilderProject({ requestedBudget: undefined, requestedTiming: undefined })
    const criteria = deriveSearchCriteriaFromProject(p)
    expect(criteria?.budget).toBeUndefined()
    expect(criteria?.timing).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// E. Inquiry binding — correct project stamped on conversation
// ---------------------------------------------------------------------------

describe('Inquiry binding — project → conversation → chat', () => {
  beforeEach(() => {
    setupCleanRepositories()
    installMockSession(mockCustomerSession('customer-builder-001'))
  })

  afterEach(() => {
    resetMockSession()
  })

  it('conversation carries sourceProjectId from the selected project', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-e2e-1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)

    const conv = getConversationById(threadId)
    expect(conv?.sourceProjectId).toBe('proj-e2e-1')
  })

  it('conversation has inquiryOrigin = "project"', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-e2e-2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)

    const conv = getConversationById(threadId)
    expect(conv?.inquiryOrigin).toBe('project')
  })

  it('conversation title matches project title', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-e2e-3', title: 'Mein Elektrik-Projekt' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)

    const conv = getConversationById(threadId)
    expect(conv?.projectTitle).toBe('Mein Elektrik-Projekt')
  })

  it('conversation subtitle carries the project category', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-e2e-4', category: 'Sanitär' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)

    const conv = getConversationById(threadId)
    expect(conv?.projectSubtitle).toBe('Sanitär')
  })

  it('a second tap on the same provider reuses the existing thread', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-e2e-5' })
    await repo.add(project)

    const first = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)
    const second = await startProjectInquiryWorkflowFromProvider(project, PROVIDER)

    expect(first).toBe(second)
  })
})

// ---------------------------------------------------------------------------
// F. Reload simulation — builder fields survive store add/getById
// ---------------------------------------------------------------------------

describe('Reload simulation — builder fields in InMemory store', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('builder project fields survive add→getById (in-memory reload equivalent)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({
      id: 'reload-1',
      category: 'Bad',
      description: 'Badezimmer renovieren',
      location: 'München',
      requestedBudget: '3.000 – 6.000 €',
      requestedTiming: 'Innerhalb 4 Wochen',
      source: 'builder',
    })
    await repo.add(project)

    const read = repo.getById('reload-1')
    expect(read?.category).toBe('Bad')
    expect(read?.description).toBe('Badezimmer renovieren')
    expect(read?.location).toBe('München')
    expect(read?.source).toBe('builder')
    expect(read?.requestedBudget).toBe('3.000 – 6.000 €')
    expect(read?.requestedTiming).toBe('Innerhalb 4 Wochen')
  })

  it('after reload equivalent, project still appears in search picker', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'reload-2' })
    await repo.add(project)

    const all = repo.getAll()
    const picked = searchPickerFilter(all)
    expect(picked.map((p) => p.id)).toContain('reload-2')
  })

  it('after reload equivalent, deriveSearchCriteriaFromProject produces valid criteria', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'reload-3' })
    await repo.add(project)

    const read = repo.getById('reload-3')!
    const criteria = deriveSearchCriteriaFromProject(read)
    expect(criteria).not.toBeNull()
    expect(criteria?.category).toBe('Elektrik')
  })
})
