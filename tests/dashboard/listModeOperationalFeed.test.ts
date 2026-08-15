/**
 * Operational Feed — Selector Truth Contract
 *
 * Originally guarded the 3-section list-mode feed (selected-day → unscheduled
 * → upcoming) inside CraftsmanScheduleScreen. ScheduleScreen, ScheduledRow,
 * and UpcomingRow have been deleted as part of the Aufträge consolidation —
 * planning now lives in CraftsmanOperationsScreen (DayStrip + DayTimeGrid).
 *
 * What survives here is the underlying calendar selector contract, which is
 * surface-independent and still drives Today, Action Queue, and Operations:
 *   - getTimedEntriesForDay (selected-day filter, status gating)
 *   - getUpcomingScheduledEntries (future-day, no duplicates, sort, status)
 *   - getPendingEntries (pending-only)
 *   - getCalendarStatusLabel (human German)
 *   - syncCalendarEntriesForJobs (no fake times for booked jobs)
 *
 * Source-string assertions on the deleted ScheduleScreen and on the deleted
 * ScheduledRow/UpcomingRow components were dropped: their UI invariants no
 * longer correspond to any runtime surface. Operations-screen structure is
 * covered by tests/dashboard/calendarFirstPlanningContract.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  formatDateKey,
} from '../../src/lib/calendar/calendarEngine'
import {
  getTimedEntriesForDay,
  getUpcomingScheduledEntries,
  getPendingEntries,
  getCalendarStatusLabel,
} from '../../src/lib/calendar/calendarSelectors'
import {
  getCalendarEntries,
  syncCalendarEntriesForJobs,
} from '../../src/lib/calendar/calendarStore'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import type { Job } from '../../src/lib/jobs/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Factories ──────────────────────────────────────────────────────────────

const TODAY = formatDateKey(new Date())
const TOMORROW = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return formatDateKey(d)
})()
const DAY_AFTER = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  return formatDateKey(d)
})()
const YESTERDAY = (() => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return formatDateKey(d)
})()

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Dachsanierung',
    customerName: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: TODAY,
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    status: 'new',
    amount: '1.000 €',
    description: 'Test description',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

beforeEach(() => {
  const repo = new InMemoryCalendarRepository()
  setCalendarRepository(repo)
})

// ═══════════════════════════════════════════════════════════════════════════
// Selected-day selector (was Section 2)
// ═══════════════════════════════════════════════════════════════════════════

describe('getTimedEntriesForDay', () => {
  it('returns only selected day scheduled/in_progress', () => {
    const todayScheduled = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const todayPending = makeEntry({ dateKey: TODAY, status: 'pending' })
    const tomorrowScheduled = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })

    const result = getTimedEntriesForDay(
      [todayScheduled, todayPending, tomorrowScheduled],
      TODAY,
    )

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(todayScheduled.id)
  })

  it('still excludes pending entries from timed grid', () => {
    const pending = makeEntry({ status: 'pending', dateKey: TODAY })
    const scheduled = makeEntry({ status: 'scheduled', dateKey: TODAY })

    const result = getTimedEntriesForDay([pending, scheduled], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('scheduled')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Upcoming-entries selector (was Section 6 + parts of 12)
// ═══════════════════════════════════════════════════════════════════════════

describe('getUpcomingScheduledEntries', () => {
  it('returns only future entries after the given day', () => {
    const todayEntry = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const tomorrowEntry = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })
    const dayAfterEntry = makeEntry({ dateKey: DAY_AFTER, status: 'scheduled' })

    const result = getUpcomingScheduledEntries(
      [todayEntry, tomorrowEntry, dayAfterEntry],
      TODAY,
    )

    expect(result).toHaveLength(2)
    expect(result[0].dateKey).toBe(TOMORROW)
    expect(result[1].dateKey).toBe(DAY_AFTER)
  })

  it('excludes selected-day entries (no duplicates with selected day)', () => {
    const todayEntry = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const result = getUpcomingScheduledEntries([todayEntry], TODAY)
    expect(result).toHaveLength(0)
  })

  it('excludes pending and completed entries', () => {
    const tomorrowPending = makeEntry({ dateKey: TOMORROW, status: 'pending' })
    const tomorrowCompleted = makeEntry({ dateKey: TOMORROW, status: 'completed' })
    const tomorrowScheduled = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })

    const result = getUpcomingScheduledEntries(
      [tomorrowPending, tomorrowCompleted, tomorrowScheduled],
      TODAY,
    )

    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('scheduled')
  })

  it('sorts by dateKey then startsAtLabel', () => {
    const laterTomorrow = makeEntry({ dateKey: TOMORROW, startsAtLabel: '14:00', status: 'scheduled' })
    const earlyTomorrow = makeEntry({ dateKey: TOMORROW, startsAtLabel: '08:00', status: 'scheduled' })
    const dayAfter = makeEntry({ dateKey: DAY_AFTER, startsAtLabel: '09:00', status: 'scheduled' })

    const result = getUpcomingScheduledEntries(
      [laterTomorrow, earlyTomorrow, dayAfter],
      TODAY,
    )

    expect(result).toHaveLength(3)
    expect(result[0].startsAtLabel).toBe('08:00')
    expect(result[1].startsAtLabel).toBe('14:00')
    expect(result[2].dateKey).toBe(DAY_AFTER)
  })

  it('excludes past entries', () => {
    const yesterday = makeEntry({ dateKey: YESTERDAY, status: 'scheduled' })
    const tomorrow = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })

    const result = getUpcomingScheduledEntries([yesterday, tomorrow], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].dateKey).toBe(TOMORROW)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Pending-entries selector
// ═══════════════════════════════════════════════════════════════════════════

describe('getPendingEntries', () => {
  it('returns only entries with pending status', () => {
    const pending = makeEntry({ status: 'pending' })
    const scheduled = makeEntry({ status: 'scheduled' })

    const result = getPendingEntries([pending, scheduled])
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('pending')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Selected-day vs upcoming: no overlap
// ═══════════════════════════════════════════════════════════════════════════

describe('selected-day and upcoming partition the future without overlap', () => {
  it('today entry appears in selected-day, tomorrow appears only in upcoming', () => {
    const todayEntry = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const tomorrowEntry = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })

    const selectedDay = getTimedEntriesForDay([todayEntry, tomorrowEntry], TODAY)
    const upcoming = getUpcomingScheduledEntries([todayEntry, tomorrowEntry], TODAY)

    expect(selectedDay).toHaveLength(1)
    expect(selectedDay[0].dateKey).toBe(TODAY)
    expect(upcoming).toHaveLength(1)
    expect(upcoming[0].dateKey).toBe(TOMORROW)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Status labels (was Section 11)
// ═══════════════════════════════════════════════════════════════════════════

describe('getCalendarStatusLabel', () => {
  it('returns human-readable German labels', () => {
    expect(getCalendarStatusLabel('scheduled')).toBe('Geplant')
    expect(getCalendarStatusLabel('in_progress')).toBe('In Arbeit')
    expect(getCalendarStatusLabel('pending')).toBe('Terminplanung offen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// No fake times (was part of Section 12)
// ═══════════════════════════════════════════════════════════════════════════

describe('syncCalendarEntriesForJobs', () => {
  it('does not fabricate startsAtLabel for booked jobs without a real time', () => {
    const job = makeJob({ status: 'booked', dateLabel: 'Heute' })
    syncCalendarEntriesForJobs([job])
    const entries = getCalendarEntries()
    expect(entries[0].startsAtLabel).toBe('')
  })
})
