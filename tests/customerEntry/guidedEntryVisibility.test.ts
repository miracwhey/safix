import { describe, it, expect } from 'vitest'
import {
  deriveGuidedEntryVisibility,
} from '../../src/lib/customerEntry/guidedEntryVisibility'
import type { GuidedEntryState, GuidedEntryStep } from '../../src/lib/customerEntry/guidedEntryState'
import type { Project } from '../../src/lib/projects'
import type { Conversation } from '../../src/lib/messages'
import type { Job } from '../../src/lib/jobs'

// ---------------------------------------------------------------------------
// Minimal test fixtures
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `proj-${Math.random().toString(36).slice(2, 8)}`,
    sourceJobId: '',
    title: 'Test project',
    customer: 'Kunde',
    craftsman: 'Handwerker',
    location: 'Berlin',
    dateLabel: 'Offen',
    price: '1.000 €',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: `conv-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    customerName: 'Kunde',
    customerAvatarUrl: '',
    craftsmanName: 'Handwerker',
    craftsmanHandle: 'hw',
    craftsmanAvatarUrl: '',
    projectTitle: 'Test',
    projectSubtitle: '',
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    title: 'Test job',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    status: 'new',
    amount: '1.000 €',
    description: 'Test',
    paymentState: 'deposit_required',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makeState(step: GuidedEntryStep, path: 'invited' | 'self_found' | null = null): GuidedEntryState {
  return { step, path, selectedProviderId: null, projectId: null }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveGuidedEntryVisibility — resume mode removed (full | none only)', () => {
  // ── Completed ───────────────────────────────────────────────────────

  it('returns none when guided entry is completed', () => {
    const vis = deriveGuidedEntryVisibility(makeState('completed'), [], [], [])
    expect(vis.mode).toBe('none')
  })

  // ── Initial state, no backend progress → full (the 5 %/9 % fork) ────

  it('returns full when step=initial and no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(makeState('initial'), [], [], [])
    expect(vis.mode).toBe('full')
  })

  it('returns full when state is null and no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(null, [], [], [])
    expect(vis.mode).toBe('full')
  })

  // ── Has a project → hide (answer card owns it, was resume) ──────────

  it('returns none when step=initial but user has a real project (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(makeState('initial'), [makeProject()], [], [])
    expect(vis.mode).toBe('none')
  })

  it('returns none when state is null but user has a project (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(null, [makeProject()], [], [])
    expect(vis.mode).toBe('none')
  })

  // ── Beyond onboarding (has projects + conversations/jobs) → hide ────

  it('returns none when user has projects AND conversations', () => {
    const vis = deriveGuidedEntryVisibility(
      makeState('initial'),
      [makeProject()],
      [makeConversation()],
      [],
    )
    expect(vis.mode).toBe('none')
  })

  it('returns none when user has projects AND jobs', () => {
    const vis = deriveGuidedEntryVisibility(
      makeState('initial'),
      [makeProject()],
      [],
      [makeJob()],
    )
    expect(vis.mode).toBe('none')
  })

  it('returns none for mid-flow step when user is beyond onboarding', () => {
    const vis = deriveGuidedEntryVisibility(
      makeState('searching_provider', 'invited'),
      [makeProject()],
      [makeConversation()],
      [],
    )
    expect(vis.mode).toBe('none')
  })

  // ── Mid-flow steps WITHOUT a project → full (5 % path reachable) ────

  it('returns full when step=invited, no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(makeState('invited', 'invited'), [], [], [])
    expect(vis.mode).toBe('full')
  })

  it('returns full when step=self_found, no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(makeState('self_found', 'self_found'), [], [], [])
    expect(vis.mode).toBe('full')
  })

  it('returns full when step=searching_provider, no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(makeState('searching_provider', 'invited'), [], [], [])
    expect(vis.mode).toBe('full')
  })

  it('returns full when step=project_needed, no backend progress', () => {
    const vis = deriveGuidedEntryVisibility(makeState('project_needed', 'self_found'), [], [], [])
    expect(vis.mode).toBe('full')
  })

  // ── Mid-flow + user already has a project → hide (was resume) ───────

  it('returns none when step=invited but user has a project (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(makeState('invited', 'invited'), [makeProject()], [], [])
    expect(vis.mode).toBe('none')
  })

  it('returns none when step=project_needed but user has a project (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(
      makeState('project_needed', 'self_found'),
      [makeProject()],
      [],
      [],
    )
    expect(vis.mode).toBe('none')
  })

  // ── Project-implying late steps → hide regardless of fixtures (was resume) ──

  it('returns none for project_created step (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(makeState('project_created', 'self_found'), [], [], [])
    expect(vis.mode).toBe('none')
  })

  it('returns none for matching_ready step (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(makeState('matching_ready', 'self_found'), [], [], [])
    expect(vis.mode).toBe('none')
  })

  it('returns none for request_ready step (was resume)', () => {
    const vis = deriveGuidedEntryVisibility(makeState('request_ready', 'self_found'), [], [], [])
    expect(vis.mode).toBe('none')
  })

  // ── Real truth wins over guided_entry_state ─────────────────────────

  it('beyond onboarding (projects+conversations) overrides mid-flow guided state', () => {
    const vis = deriveGuidedEntryVisibility(
      makeState('project_needed', 'invited'),
      [makeProject()],
      [makeConversation()],
      [],
    )
    expect(vis.mode).toBe('none')
  })

  // ── Conversations / jobs alone (no projects) don't suppress initial ─

  it('conversations without projects still shows full initial', () => {
    const vis = deriveGuidedEntryVisibility(makeState('initial'), [], [makeConversation()], [])
    expect(vis.mode).toBe('full')
  })

  it('jobs without projects still shows full initial', () => {
    const vis = deriveGuidedEntryVisibility(makeState('initial'), [], [], [makeJob()])
    expect(vis.mode).toBe('full')
  })
})
