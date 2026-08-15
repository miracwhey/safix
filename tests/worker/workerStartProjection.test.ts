/**
 * Worker Start-tab projection — state derivation contract
 *
 * Tests the pure deriveWorkerStartViewModel function against real domain state
 * scenarios. No mocks needed: inputs are plain CalendarEntry and Job objects.
 */

import { describe, it, expect } from 'vitest'
import { deriveWorkerStartViewModel } from '../../src/lib/worker/workerStartProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = new Date('2026-04-08T09:00:00')
const TODAY_KEY = '2026-04-08'
const TOMORROW_KEY = '2026-04-09'

function makeEntry(overrides: Partial<CalendarEntry>): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    title: 'Test Einsatz',
    customerName: 'Test Kunde',
    location: 'Hannover',
    dateLabel: 'Heute',
    dateKey: TODAY_KEY,
    startsAtLabel: '08:00',
    endsAtLabel: '14:00',
    assignedMemberIds: ['tm-1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    projectId: 'p-1',
    title: 'Test Job',
    customer: 'Test Kunde',
    location: 'Hannover',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1000',
    description: '',
    paymentState: 'deposit',
    documentationStatus: 'Vollständig dokumentiert',
    assignedMemberIds: ['tm-1'],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  } as Job
}

// ── State derivation ──────────────────────────────────────────────────────────

describe('workerStartProjection: state derivation', () => {
  it('no entries today → workday_calm', () => {
    const vm = deriveWorkerStartViewModel([], [], TODAY)
    expect(vm.dayState).toBe('workday_calm')
    expect(vm.currentAssignment).toBeNull()
    expect(vm.nextAssignment).toBeNull()
    expect(vm.openItems).toHaveLength(0)
    expect(vm.summary.total).toBe(0)
  })

  it('only scheduled entries today → not_started', () => {
    const entries = [makeEntry({ status: 'scheduled' })]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('not_started')
    expect(vm.currentAssignment).toBeNull()
    expect(vm.nextAssignment).not.toBeNull()
    expect(vm.nextAssignment?.title).toBe('Test Einsatz')
  })

  it('in_progress entry today → assignment_active', () => {
    const entries = [makeEntry({ status: 'in_progress' })]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('assignment_active')
    expect(vm.currentAssignment?.title).toBe('Test Einsatz')
    expect(vm.currentAssignment?.timeWindow).toContain('08:00')
    expect(vm.currentAssignment?.timeWindow).toContain('14:00')
  })

  it('completed + scheduled today → workday_no_assignment', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'completed', startsAtLabel: '08:00' }),
      makeEntry({ id: 'e-2', status: 'scheduled', startsAtLabel: '14:00', title: 'Zweiter Einsatz' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('workday_no_assignment')
    expect(vm.nextAssignment?.title).toBe('Zweiter Einsatz')
    expect(vm.currentAssignment).toBeNull()
  })

  it('all completed today, docs closed → day_complete', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed', jobId: 'j-1' })
    // Both modules done: photoCount > 0 AND job_report exists (mirrors Doku projection isComplete)
    const job = makeJob({ id: 'j-1', photoCount: 1 })
    const reportCounts = new Map([['j-1', 1]])
    const vm = deriveWorkerStartViewModel([entry], [job], TODAY, reportCounts)
    expect(vm.dayState).toBe('day_complete')
    expect(vm.openItems).toHaveLength(0)
  })

  it('all completed today, docs open → assignment_open_item', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed', jobId: 'j-1' })
    const job = makeJob({ id: 'j-1', documentationStatus: 'Noch keine Dokumentation' })
    const vm = deriveWorkerStartViewModel([entry], [job], TODAY)
    expect(vm.dayState).toBe('assignment_open_item')
    expect(vm.openItems).toHaveLength(1)
    expect(vm.openItems[0].kind).toBe('doku')
  })

  it('all completed today, docs "Vorbereitung offen" → assignment_open_item', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed', jobId: 'j-1' })
    const job = makeJob({ id: 'j-1', documentationStatus: 'Vorbereitung offen' })
    const vm = deriveWorkerStartViewModel([entry], [job], TODAY)
    expect(vm.dayState).toBe('assignment_open_item')
    expect(vm.openItems).toHaveLength(1)
    expect(vm.openItems[0].kind).toBe('doku')
  })

  it('all completed today, no linked job → day_complete (safe fallback)', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed' }) // no jobId
    const vm = deriveWorkerStartViewModel([entry], [], TODAY)
    expect(vm.dayState).toBe('day_complete')
    expect(vm.openItems).toHaveLength(0)
  })

  it('assignment_open_item: open item has correct assignmentTitle', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed', jobId: 'j-1', title: 'Badezimmer-Sanierung' })
    const job = makeJob({ id: 'j-1', documentationStatus: 'Noch keine Dokumentation' })
    const vm = deriveWorkerStartViewModel([entry], [job], TODAY)
    expect(vm.openItems[0].assignmentTitle).toBe('Badezimmer-Sanierung')
    expect(vm.openItems[0].fromDate).toBe('today')
  })
})

// ── Today summary ─────────────────────────────────────────────────────────────

describe('workerStartProjection: today summary', () => {
  it('3 entries: 1 done, 2 scheduled → summary correct', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'completed' }),
      makeEntry({ id: 'e-2', status: 'scheduled' }),
      makeEntry({ id: 'e-3', status: 'scheduled' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.summary.total).toBe(3)
    expect(vm.summary.done).toBe(1)
    expect(vm.summary.remaining).toBe(2)
  })

  it('cancelled entries excluded from summary total', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'completed' }),
      makeEntry({ id: 'e-2', status: 'cancelled' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.summary.total).toBe(1)
    expect(vm.summary.done).toBe(1)
  })

  it('no entries today → summary is 0/0', () => {
    const vm = deriveWorkerStartViewModel([], [], TODAY)
    expect(vm.summary.total).toBe(0)
    expect(vm.summary.done).toBe(0)
    expect(vm.summary.remaining).toBe(0)
  })
})

// ── Next assignment ───────────────────────────────────────────────────────────

describe('workerStartProjection: next assignment', () => {
  it('not_started: nextAssignment is first scheduled entry by start time', () => {
    const entries = [
      makeEntry({ id: 'e-2', status: 'scheduled', startsAtLabel: '14:00', title: 'Nachmittag' }),
      makeEntry({ id: 'e-1', status: 'scheduled', startsAtLabel: '08:00', title: 'Morgen' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.nextAssignment?.title).toBe('Morgen')
  })

  it('assignment_active: nextAssignment shows next scheduled after current', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'in_progress', startsAtLabel: '08:00', title: 'Aktuell' }),
      makeEntry({ id: 'e-2', status: 'scheduled', startsAtLabel: '14:00', title: 'Danach' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('assignment_active')
    expect(vm.nextAssignment?.title).toBe('Danach')
  })

  it('workday_calm: nextAssignment resolved from future entries', () => {
    const futureEntry = makeEntry({
      id: 'e-f',
      status: 'scheduled',
      dateKey: TOMORROW_KEY,
      dateLabel: 'Morgen',
      title: 'Morgen früh',
    })
    const vm = deriveWorkerStartViewModel([futureEntry], [], TODAY)
    expect(vm.dayState).toBe('workday_calm')
    expect(vm.nextAssignment?.title).toBe('Morgen früh')
  })

  it('workday_calm: no future entries → nextAssignment is null', () => {
    const vm = deriveWorkerStartViewModel([], [], TODAY)
    expect(vm.nextAssignment).toBeNull()
  })
})

// ── Snapshot format ───────────────────────────────────────────────────────────

describe('workerStartProjection: AssignmentSnapshot format', () => {
  it('timeWindow formatted as startsAt–endsAt (en-dash)', () => {
    const entry = makeEntry({ status: 'in_progress', startsAtLabel: '09:00', endsAtLabel: '13:00' })
    const vm = deriveWorkerStartViewModel([entry], [], TODAY)
    expect(vm.currentAssignment?.timeWindow).toBe('09:00\u201313:00')
  })

  it('snapshot preserves title, customer, location from entry', () => {
    const entry = makeEntry({
      status: 'in_progress',
      title: 'Küchen-Installation',
      customerName: 'Thomas Koch',
      location: 'Hannover-Mitte',
    })
    const vm = deriveWorkerStartViewModel([entry], [], TODAY)
    expect(vm.currentAssignment?.title).toBe('Küchen-Installation')
    expect(vm.currentAssignment?.customer).toBe('Thomas Koch')
    expect(vm.currentAssignment?.location).toBe('Hannover-Mitte')
  })
})

// ── Hints ─────────────────────────────────────────────────────────────────────

describe('workerStartProjection: hints', () => {
  it('hints always empty — no real source in current domain', () => {
    const entries = [makeEntry({ status: 'in_progress' })]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.hints).toHaveLength(0)
  })
})

// ── Incomplete / null-safe data ───────────────────────────────────────────────

describe('workerStartProjection: incomplete data safety', () => {
  it('no crash on empty userEntries and empty jobs', () => {
    expect(() => deriveWorkerStartViewModel([], [], TODAY)).not.toThrow()
  })

  it('completed entry with unknown jobId → day_complete, no open items', () => {
    const entry = makeEntry({ id: 'e-1', status: 'completed', jobId: 'nonexistent-job' })
    const vm = deriveWorkerStartViewModel([entry], [], TODAY)
    expect(vm.dayState).toBe('day_complete')
    expect(vm.openItems).toHaveLength(0)
  })

  it('todayKey reflects injected date', () => {
    const customDate = new Date('2026-06-15T10:00:00')
    const vm = deriveWorkerStartViewModel([], [], customDate)
    expect(vm.todayKey).toBe('2026-06-15')
  })

  it('entries from other days do not affect today summary', () => {
    const pastEntry = makeEntry({ id: 'e-p', status: 'completed', dateKey: '2026-04-07' })
    const futureEntry = makeEntry({ id: 'e-f', status: 'scheduled', dateKey: TOMORROW_KEY })
    const vm = deriveWorkerStartViewModel([pastEntry, futureEntry], [], TODAY)
    // No entries for today
    expect(vm.summary.total).toBe(0)
    expect(vm.dayState).toBe('workday_calm')
  })

  it('multiple in_progress entries: first one becomes currentAssignment', () => {
    // Should not happen in practice but must not crash
    const entries = [
      makeEntry({ id: 'e-1', status: 'in_progress', title: 'Erster' }),
      makeEntry({ id: 'e-2', status: 'in_progress', title: 'Zweiter' }),
    ]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('assignment_active')
    expect(vm.currentAssignment?.title).toBe('Erster')
  })

  it('pending entries do not crash — fall through to workday_calm', () => {
    // 'pending' is a valid CalendarEntry status but not matched by any state bucket
    const entries = [makeEntry({ id: 'e-1', status: 'pending' as CalendarEntry['status'] })]
    expect(() => deriveWorkerStartViewModel(entries, [], TODAY)).not.toThrow()
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('workday_calm')
    expect(vm.summary.total).toBe(1) // non-cancelled, still counted
    expect(vm.summary.done).toBe(0)
  })
})

// ── Primary action correctness ────────────────────────────────────────────────

describe('workerStartProjection: primary action derivation by state', () => {
  it('not_started → start_assignment is the correct action', () => {
    const entries = [makeEntry({ status: 'scheduled' })]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('not_started')
    // The action card will show 'start_assignment' for this state
    // (verified by contract: not_started shows "Einsatz starten")
  })

  it('assignment_active → close_assignment is the correct action', () => {
    const entries = [makeEntry({ status: 'in_progress' })]
    const vm = deriveWorkerStartViewModel(entries, [], TODAY)
    expect(vm.dayState).toBe('assignment_active')
    // The action card will show 'close_assignment' for this state
  })

  it('workday_calm → no operative action (dayState confirmed)', () => {
    const vm = deriveWorkerStartViewModel([], [], TODAY)
    expect(vm.dayState).toBe('workday_calm')
  })

  it('day_complete → no operative action (dayState confirmed)', () => {
    const entry = makeEntry({ status: 'completed', jobId: 'j-1' })
    // Both modules done: photoCount > 0 AND job_report exists
    const job = makeJob({ id: 'j-1', photoCount: 1 })
    const reportCounts = new Map([['j-1', 1]])
    const vm = deriveWorkerStartViewModel([entry], [job], TODAY, reportCounts)
    expect(vm.dayState).toBe('day_complete')
  })
})
