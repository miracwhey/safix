/**
 * Jobs Screen Selectors Contract Tests
 *
 * Pure-function contract for the consolidated owner work surface
 * (`/craftsman/jobs`).
 *
 * Verifies:
 *  - `?focus=` whitelist parsing + smart default
 *  - Section count derivation
 *  - Section content shape (queue / queue-grouped / jobs-grouped)
 *  - Bottom-nav tab affinity rule
 *
 * No second source of truth: every classification flows from
 * `deriveActionQueue` (or canonical job-status filters).
 */

import { describe, it, expect } from 'vitest'
import {
  deriveJobsScreenSectionContent,
  deriveJobsScreenSectionStats,
  resolveJobsScreenActiveTab,
  resolveJobsScreenSection,
  type JobsScreenSection,
} from '../../src/lib/dashboard/jobsScreenSelectors'
import { deriveActionQueue } from '../../src/lib/dashboard/actionQueueSelectors'
import type { Job } from '../../src/lib/jobs/types'

// ── Factories ────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Dachsanierung Beispiel',
    customer: 'Herr Müller',
    location: 'Berlin-Mitte',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '2.500 €',
    description: 'Dachsanierung komplett',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: ['w1'],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function emptyQueue() {
  return deriveActionQueue([], [], [])
}

// ── resolveJobsScreenSection ────────────────────────────────────────────────

describe('resolveJobsScreenSection', () => {
  it('returns whitelisted focus values verbatim', () => {
    const queue = emptyQueue()
    const sections: JobsScreenSection[] = ['handlungsbedarf', 'aktiv', 'geplant', 'alle']
    for (const s of sections) {
      expect(resolveJobsScreenSection(s, queue)).toBe(s)
    }
  })

  it('falls back to handlungsbedarf when needsAction items exist and focus is missing', () => {
    const newRequest = makeJob({ status: 'new' })
    const queue = deriveActionQueue([newRequest], [], [])
    expect(queue.needsAction.length).toBeGreaterThan(0)
    expect(resolveJobsScreenSection(null, queue)).toBe('handlungsbedarf')
    expect(resolveJobsScreenSection(undefined, queue)).toBe('handlungsbedarf')
  })

  it('falls back to aktiv when no needsAction items exist and focus is missing', () => {
    const inProg = makeJob({ status: 'in_progress' })
    const queue = deriveActionQueue([inProg], [], [])
    expect(queue.needsAction.length).toBe(0)
    expect(queue.inProgress.length).toBeGreaterThan(0)
    expect(resolveJobsScreenSection(null, queue)).toBe('aktiv')
  })

  it('falls back to smart default for unknown focus values', () => {
    const queue = emptyQueue()
    expect(resolveJobsScreenSection('payment', queue)).toBe('aktiv')
    expect(resolveJobsScreenSection('xyz', queue)).toBe('aktiv')
    expect(resolveJobsScreenSection('', queue)).toBe('aktiv')
  })
})

// ── deriveJobsScreenSectionStats ────────────────────────────────────────────

describe('deriveJobsScreenSectionStats', () => {
  it('counts each section directly from queue groups; alle excludes cancelled', () => {
    const newReq = makeJob({ id: 'a', status: 'new' })
    const inProg = makeJob({ id: 'b', status: 'in_progress' })
    const waitingPay = makeJob({ id: 'c', status: 'waiting_payment' })
    const planned = makeJob({ id: 'd', status: 'booked', assignedMemberIds: ['w1'] })
    const completed = makeJob({ id: 'e', status: 'completed' })
    const cancelled = makeJob({ id: 'f', status: 'cancelled' })
    const jobs = [newReq, inProg, waitingPay, planned, completed, cancelled]

    const queue = deriveActionQueue(jobs, [], [])
    const stats = deriveJobsScreenSectionStats(queue, jobs)

    expect(stats.handlungsbedarf).toBe(queue.needsAction.length)
    expect(stats.aktiv).toBe(queue.inProgress.length + queue.waiting.length)
    expect(stats.geplant).toBe(queue.comingUp.length)
    expect(stats.alle).toBe(jobs.filter((j) => j.status !== 'cancelled').length)
    // Cancelled job must not inflate the broad list count.
    expect(stats.alle).toBe(5)
  })

  it('returns zeros when there are no jobs', () => {
    const stats = deriveJobsScreenSectionStats(emptyQueue(), [])
    expect(stats).toEqual({ handlungsbedarf: 0, aktiv: 0, geplant: 0, alle: 0 })
  })
})

// ── deriveJobsScreenSectionContent ──────────────────────────────────────────

describe('deriveJobsScreenSectionContent', () => {
  it('handlungsbedarf returns flat queue list of needsAction items', () => {
    const newReq = makeJob({ id: 'r1', status: 'new' })
    const queue = deriveActionQueue([newReq], [], [])
    const content = deriveJobsScreenSectionContent('handlungsbedarf', queue, [newReq])

    expect(content.kind).toBe('queue')
    if (content.kind !== 'queue') throw new Error('expected queue shape')
    expect(content.items).toEqual(queue.needsAction)
    expect(content.items.some((i) => i.job.id === 'r1')).toBe(true)
  })

  it('aktiv returns grouped queue (In Arbeit + Wartet) and skips empty groups', () => {
    const inProg = makeJob({ id: 'i1', status: 'in_progress' })
    const waitingPay = makeJob({ id: 'w1', status: 'waiting_payment' })
    const queue = deriveActionQueue([inProg, waitingPay], [], [])
    const content = deriveJobsScreenSectionContent('aktiv', queue, [inProg, waitingPay])

    expect(content.kind).toBe('queue-grouped')
    if (content.kind !== 'queue-grouped') throw new Error('expected queue-grouped')
    const labels = content.groups.map((g) => g.label)
    expect(labels).toEqual(['In Arbeit', 'Wartet'])
  })

  it('aktiv omits a sub-group when it is empty', () => {
    const inProg = makeJob({ id: 'i1', status: 'in_progress' })
    const queue = deriveActionQueue([inProg], [], [])
    const content = deriveJobsScreenSectionContent('aktiv', queue, [inProg])
    if (content.kind !== 'queue-grouped') throw new Error('expected queue-grouped')
    expect(content.groups.map((g) => g.label)).toEqual(['In Arbeit'])
  })

  it('geplant returns flat queue list of comingUp items', () => {
    const planned = makeJob({ id: 'p1', status: 'booked', assignedMemberIds: ['w1'] })
    const queue = deriveActionQueue([planned], [], [])
    const content = deriveJobsScreenSectionContent('geplant', queue, [planned])

    expect(content.kind).toBe('queue')
    if (content.kind !== 'queue') throw new Error('expected queue shape')
    expect(content.items).toEqual(queue.comingUp)
  })

  it('alle returns status-grouped raw jobs (Geplant/Aktiv/Erledigt)', () => {
    const newReq = makeJob({ id: 'a', status: 'new' })
    const booked = makeJob({ id: 'b', status: 'booked', assignedMemberIds: ['w1'] })
    const inProg = makeJob({ id: 'c', status: 'in_progress' })
    const completed = makeJob({ id: 'd', status: 'completed' })
    const cancelled = makeJob({ id: 'e', status: 'cancelled' })
    const jobs = [newReq, booked, inProg, completed, cancelled]
    const queue = deriveActionQueue(jobs, [], [])

    const content = deriveJobsScreenSectionContent('alle', queue, jobs)
    expect(content.kind).toBe('jobs-grouped')
    if (content.kind !== 'jobs-grouped') throw new Error('expected jobs-grouped')

    const labels = content.groups.map((g) => g.label)
    expect(labels).toEqual(['Geplant', 'Aktiv', 'Erledigt'])

    const planned = content.groups.find((g) => g.label === 'Geplant')!.jobs
    const active = content.groups.find((g) => g.label === 'Aktiv')!.jobs
    const done = content.groups.find((g) => g.label === 'Erledigt')!.jobs

    // Cancelled must not appear in any group.
    expect(planned.some((j) => j.id === 'e')).toBe(false)
    expect(active.some((j) => j.id === 'e')).toBe(false)
    expect(done.some((j) => j.id === 'e')).toBe(false)

    expect(planned.map((j) => j.id).sort()).toEqual(['a', 'b'])
    expect(active.map((j) => j.id)).toEqual(['c'])
    expect(done.map((j) => j.id)).toEqual(['d'])
  })

  it('alle hides empty sub-groups (e.g. when nothing is planned yet)', () => {
    const completed = makeJob({ id: 'd', status: 'completed' })
    const queue = deriveActionQueue([completed], [], [])
    const content = deriveJobsScreenSectionContent('alle', queue, [completed])
    if (content.kind !== 'jobs-grouped') throw new Error('expected jobs-grouped')
    expect(content.groups.map((g) => g.label)).toEqual(['Erledigt'])
  })
})

// ── resolveJobsScreenActiveTab ──────────────────────────────────────────────

describe('resolveJobsScreenActiveTab', () => {
  it('keeps the home tab highlighted when the user enters via ?focus=handlungsbedarf', () => {
    expect(resolveJobsScreenActiveTab('handlungsbedarf')).toBe('home')
  })

  it('uses the verwaltung tab for any other entry (canonical Aufträge surface)', () => {
    expect(resolveJobsScreenActiveTab('aktiv')).toBe('verwaltung')
    expect(resolveJobsScreenActiveTab('geplant')).toBe('verwaltung')
    expect(resolveJobsScreenActiveTab('alle')).toBe('verwaltung')
    expect(resolveJobsScreenActiveTab(null)).toBe('verwaltung')
    expect(resolveJobsScreenActiveTab(undefined)).toBe('verwaltung')
  })
})

// ── No second source of truth ───────────────────────────────────────────────

describe('selector hygiene: no second source of truth', () => {
  it('handlungsbedarf items are sourced verbatim from queue.needsAction (no re-classification)', () => {
    const newReq = makeJob({ id: 'a', status: 'new' })
    const queue = deriveActionQueue([newReq], [], [])
    const content = deriveJobsScreenSectionContent('handlungsbedarf', queue, [newReq])
    if (content.kind !== 'queue') throw new Error('expected queue shape')
    // Same reference identity guarantees no shadow re-derivation in the screen.
    expect(content.items).toBe(queue.needsAction)
  })

  it('geplant items are sourced verbatim from queue.comingUp', () => {
    const planned = makeJob({ id: 'p', status: 'booked', assignedMemberIds: ['w1'] })
    const queue = deriveActionQueue([planned], [], [])
    const content = deriveJobsScreenSectionContent('geplant', queue, [planned])
    if (content.kind !== 'queue') throw new Error('expected queue shape')
    expect(content.items).toBe(queue.comingUp)
  })
})
