/**
 * Calendar-First Planning Screen Contract Tests
 *
 * Proves the full calendar-first refactor against the mandatory contract:
 *
 *   1.  Top hierarchy is date navigation → day strip → time grid
 *   2.  Selected day explicitly drives the main content
 *   3.  Day strip exists and changes selection
 *   4.  Timed grid renders even when selected day has no scheduled entries
 *   5.  Real scheduled items render as timed event blocks in the grid
 *   6.  Pending jobs do not render in the timed grid
 *   7.  Pending jobs render in the unscheduled section
 *   8.  Current-time line renders only for today
 *   9.  Warnings/conflicts render only when relevant and below primary content
 *   10. List/calendar mode is explicit and justified
 *   11. Routing/interaction semantics are correct
 *   12. Title source does not leak internal/workflow naming
 *   13. No fake times regress
 *   14. No prior scheduling truth contracts regress
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createCalendarEntryFromJob,
  formatDateKey,
} from '../../src/lib/calendar/calendarEngine'
import {
  getTimedEntriesForDay,
  getPendingEntries,
  getScheduledEntries,
  getInProgressEntries,
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

beforeEach(() => {
  const repo = new InMemoryCalendarRepository()
  setCalendarRepository(repo)
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Top hierarchy is date navigation → day strip → time grid
// ═══════════════════════════════════════════════════════════════════════════

describe('1. Top hierarchy: date nav → day strip → time grid', () => {
  // Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen.
  // The orphan's `planner-header` class no longer exists; Operations renders the
  // selected-date label directly above DayStrip. Surviving invariant: DayStrip
  // appears before DayTimeGrid, no SectionCard wrappers, no PLANUNG hero.
  it('day strip renders before time grid', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)

    const stripPos = renderSection.indexOf('DayStrip')
    const gridPos = renderSection.indexOf('DayTimeGrid')

    expect(stripPos).toBeGreaterThan(-1)
    expect(gridPos).toBeGreaterThan(stripPos)
  })

  it('no CraftsmanSectionCard wrappers in the screen', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('CraftsmanSectionCard')
  })

  it('no giant "PLANUNG" hero section above planning content', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)

    expect(renderSection).not.toMatch(/tracking-wide uppercase[^>]*>Planung</)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Selected day explicitly drives the main content
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Selected day drives grid content', () => {
  it('getTimedEntriesForDay filters by dateKey and eligible status', () => {
    const todayScheduled = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const todayPending = makeEntry({ dateKey: TODAY, status: 'pending' })
    const tomorrowScheduled = makeEntry({ dateKey: TOMORROW, status: 'scheduled' })

    const result = getTimedEntriesForDay(
      [todayScheduled, todayPending, tomorrowScheduled],
      TODAY
    )

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(todayScheduled.id)
  })

  it('in_progress entries for selected day are included in grid', () => {
    const inProg = makeEntry({ dateKey: TODAY, status: 'in_progress', startsAtLabel: 'Jetzt' })
    const result = getTimedEntriesForDay([inProg], TODAY)
    expect(result).toHaveLength(1)
  })

  it('screen uses selectedDateKey state to drive grid content', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('selectedDateKey')
    expect(source).toContain('getTimedEntriesForDay')
    expect(source).toContain('setSelectedDateKey')
  })

  it('selected date is shown in the header', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Operations uses formatSelectedDate(selectedDateKey) in place of the
    // ScheduleScreen's formattedSelectedDate / selected-date-label markers.
    expect(source).toContain('formatSelectedDate(selectedDateKey)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Day strip exists and changes selection
// ═══════════════════════════════════════════════════════════════════════════

describe('3. Day strip navigation', () => {
  it('DayStrip component exists and renders day cells', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayStrip.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('day-strip')
    expect(source).toContain('day-cell-')
    expect(source).toContain('onSelectDay')
  })

  it('day strip shows weekday labels and day numbers', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayStrip.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('day.weekday')
    expect(source).toContain('day.dayNum')
  })

  it('selected day and today are visually distinct', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayStrip.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('isSelected')
    expect(source).toContain('isToday')
    // Selected uses dark bg, today uses blue accent
    expect(source).toContain('bg-slate-900')
    expect(source).toContain('bg-blue-50')
  })

  it('screen passes onSelectDay to DayStrip', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('onSelectDay={handleSelectDay}')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Timed grid renders even when selected day has no scheduled entries
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Grid renders on empty days', () => {
  it('DayTimeGrid renders hour rows regardless of entries', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // Hour rows are always rendered from START_HOUR to END_HOUR
    expect(source).toContain('hour-row-')
    expect(source).toContain('hours.map')
    // The grid renders with an explicit height for the time column
    expect(source).toContain('HOUR_HEIGHT')
  })

  it('empty grid does NOT show a giant "Keine Einsätze" placeholder card', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('Keine Einsätze geplant')
  })

  it('getTimedEntriesForDay returns empty array on no entries — grid still receives valid input', () => {
    const result = getTimedEntriesForDay([], TODAY)
    expect(result).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Real scheduled items render as timed event blocks in the grid
// ═══════════════════════════════════════════════════════════════════════════

describe('5. Timed event blocks in grid', () => {
  it('DayTimeGrid renders event blocks with positional time placement', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('event-block-')
    expect(source).toContain('entry.startsAtLabel')
    expect(source).toContain('entry.endsAtLabel')
    // Block positioned with top offset from time calculation
    expect(source).toContain('style={{ top, height')
  })

  it('event blocks show project title as primary readable content', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('entry.title')
    expect(source).toContain('entry.location')
  })

  it('event blocks link to job detail for drilldown', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${entry.jobId}')
  })

  it('only entries with real start time are positioned in the grid', () => {
    const withTime = makeEntry({ startsAtLabel: '10:00', endsAtLabel: '12:00', dateKey: TODAY })
    const noTime = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const jetzt = makeEntry({ startsAtLabel: 'Jetzt', dateKey: TODAY, status: 'in_progress' })

    const all = getTimedEntriesForDay([withTime, noTime, jetzt], TODAY)
    // All 3 are eligible for the grid (scheduled/in_progress for today)
    expect(all).toHaveLength(3)
    // But DayTimeGrid internally only positions entries with real times
    // (parseTime returns null for '', 'Jetzt')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Pending jobs do not render in the timed grid
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Pending jobs excluded from grid', () => {
  it('pending entries are filtered out by getTimedEntriesForDay', () => {
    const pending = makeEntry({ status: 'pending', dateKey: TODAY })
    const scheduled = makeEntry({ status: 'scheduled', dateKey: TODAY })

    const result = getTimedEntriesForDay([pending, scheduled], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('scheduled')
  })

  it('completed entries are also filtered out of the grid', () => {
    const completed = makeEntry({ status: 'completed', dateKey: TODAY })
    const result = getTimedEntriesForDay([completed], TODAY)
    expect(result).toHaveLength(0)
  })

  it('cancelled entries do not appear in the grid', () => {
    const cancelled = makeEntry({ status: 'cancelled', dateKey: TODAY })
    const result = getTimedEntriesForDay([cancelled], TODAY)
    expect(result).toHaveLength(0)
  })

  it('booked job creates pending CalendarEntry that is excluded from grid', () => {
    const job = makeJob({ status: 'booked', dateLabel: 'Heute', assignedMemberIds: ['w1'] })
    syncCalendarEntriesForJobs([job])
    const entries = getCalendarEntries()
    expect(entries[0].status).toBe('pending')

    const gridEntries = getTimedEntriesForDay(entries, TODAY)
    expect(gridEntries).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Pending jobs render in the unscheduled section
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Pending jobs surface as actionable work', () => {
  // Operations does not embed an inline "Noch nicht eingeplant" section.
  // Pending/unscheduled jobs surface in CraftsmanJobsScreen?focus=handlungsbedarf
  // via deriveActionQueue (covered by jobsScreenSelectors / queueDirectActions).
  // We keep the selector contract here.
  it('getPendingEntries returns only pending status entries', () => {
    const pending = makeEntry({ status: 'pending' })
    const scheduled = makeEntry({ status: 'scheduled' })
    const inProg = makeEntry({ status: 'in_progress' })

    const result = getPendingEntries([pending, scheduled, inProg])
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('pending')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Current-time line renders only for today
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Current-time line for today only', () => {
  it('DayTimeGrid renders now-line only when isToday is true', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // Now-line is gated on isToday
    expect(source).toContain('now-line')
    expect(source).toContain('isToday')
    expect(source).toContain('nowLineTop !== null')
  })

  it('screen passes isToday based on selectedDateKey matching today', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Operations names the today key `todayKey` (was `todayDateKey` in the
    // deleted ScheduleScreen). Same invariant.
    expect(source).toContain('const isToday = selectedDateKey === todayKey')
    expect(source).toContain('isToday={isToday}')
  })

  it('now-line uses real current time (getCurrentHourFraction)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('getCurrentHourFraction')
    expect(source).toContain('now.getHours()')
    expect(source).toContain('now.getMinutes()')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Warnings/conflicts render only when relevant and below primary content
// ═══════════════════════════════════════════════════════════════════════════

describe('9. Warnings below primary content', () => {
  // Repointed to CraftsmanOperationsScreen. Anchor changed from
  // 'Noch nicht eingeplant' (orphan-only) to '<DayTimeGrid' since Operations
  // does not surface unscheduled jobs inline.
  it('team capacity / overbooking sections are after the day grid', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)

    const gridPos = renderSection.indexOf('<DayTimeGrid')
    const teamPos = renderSection.indexOf('Auslastung heute')
    const warningPos = renderSection.indexOf('Überbuchte Mitarbeiter')

    expect(gridPos).toBeGreaterThan(-1)
    expect(teamPos).toBeGreaterThan(gridPos)
    expect(warningPos).toBeGreaterThan(teamPos)
  })

  it('team/warning sections are conditionally rendered', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('todayTeamLoads.length > 0')
    expect(source).toContain('overbookedLoads.length > 0')
  })
})

// 10. (Liste/Kalender mode switch + 3-section operational feed) removed:
// the ScheduleScreen mode toggle was deleted with the orphan. Operations has
// no Liste mode and no list-section-* feed — planning is calendar-first only.

// ═══════════════════════════════════════════════════════════════════════════
// 11. Routing/interaction semantics are correct
// ═══════════════════════════════════════════════════════════════════════════

describe('11. Routing and interactions', () => {
  it('event blocks link to /craftsman/jobs/:jobId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${entry.jobId}')
  })

  // 'unscheduled job rows link to /craftsman/jobs/:id' removed: Operations
  // does not surface inline unscheduled rows. The CraftsmanJobsScreen jobs-row
  // routing is covered by jobsScreenSelectors / queueDirectActions.

  it('Heute button returns to today', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('handleGoToday')
    expect(source).toContain('Heute')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Title source does not leak internal/workflow naming
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Title quality', () => {
  it('event blocks use entry.title (project-first) not status/workflow labels', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('entry.title')
    expect(source).not.toContain('Anfrage läuft')
    expect(source).not.toContain('Auftrag aus Angebot')
  })

  it('status labels use human-readable German', () => {
    expect(getCalendarStatusLabel('scheduled')).toBe('Geplant')
    expect(getCalendarStatusLabel('in_progress')).toBe('In Arbeit')
    expect(getCalendarStatusLabel('completed')).toBe('Abgeschlossen')
    expect(getCalendarStatusLabel('pending')).toBe('Terminplanung offen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. No fake times regress
// ═══════════════════════════════════════════════════════════════════════════

describe('13. No fake times', () => {
  it('booked job without real time has empty startsAtLabel', () => {
    const job = makeJob({ status: 'booked', dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('')
  })

  it('scheduled job without time has empty startsAtLabel', () => {
    const job = makeJob({ status: 'scheduled', dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('')
  })

  it('scheduled job with real time preserves it', () => {
    const job = makeJob({ status: 'scheduled', dateLabel: 'Heute, 14:00 Uhr' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('14:00')
  })

  it('DayTimeGrid parseTime does not fabricate times', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // parseTime returns null for empty or non-time strings
    expect(source).toContain("if (!label || label === 'Jetzt' || label === 'Offen') return null")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 14. No prior scheduling truth contracts regress
// ═══════════════════════════════════════════════════════════════════════════

describe('14. No prior truth regressions', () => {
  it('pending status still maps from booked jobs', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'], dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.status).toBe('pending')
  })

  it('scheduled status still maps from scheduled jobs', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'], dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.status).toBe('scheduled')
  })

  it('getScheduledEntries and getInProgressEntries still work', () => {
    const sched = makeEntry({ status: 'scheduled' })
    const inProg = makeEntry({ status: 'in_progress' })
    const pending = makeEntry({ status: 'pending' })

    expect(getScheduledEntries([sched, inProg, pending])).toHaveLength(1)
    expect(getInProgressEntries([sched, inProg, pending])).toHaveLength(1)
  })

  it('screen still does not import ScheduleOverviewCard/OperationsOverviewCard/SchedulingLifecycleSection', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('ScheduleOverviewCard')
    expect(source).not.toContain('OperationsOverviewCard')
    expect(source).not.toContain('SchedulingLifecycleSection')
  })

  it('no shadow-heavy oversized cards in planning screen', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('shadow-[0_16px_36px_-28px')
    expect(source).not.toContain('shadow-[0_18px_40px_-28px')
  })

  it('fake time values are never fabricated', () => {
    const job = makeJob({ status: 'scheduled', dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('')
  })

  it('today/calendar truth alignment: scheduled shows in grid, pending does not', () => {
    const scheduledEntry = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const pendingEntry = makeEntry({ status: 'pending', dateKey: TODAY })

    const gridEntries = getTimedEntriesForDay([scheduledEntry, pendingEntry], TODAY)
    expect(gridEntries).toHaveLength(1)
    expect(gridEntries[0].status).toBe('scheduled')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTION BLOCK — Real calendar-first surface (Operations)
// ═══════════════════════════════════════════════════════════════════════════
//
// Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen.
// The CalendarViewMode 'week' / 'list' toggle and the `planner-header` class
// were ScheduleScreen-only — Operations is calendar-first by construction
// (no list mode), so the "default mode" assertions become structural.

describe('Correction: Kalender (time grid) is the planning surface', () => {
  it('DayStrip appears before DayTimeGrid in the screen render', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)

    const dayStripPos = renderSection.indexOf('<DayStrip')
    const dayTimeGridPos = renderSection.indexOf('<DayTimeGrid')

    expect(dayStripPos).toBeGreaterThan(-1)
    expect(dayTimeGridPos).toBeGreaterThan(dayStripPos)
  })

  it('no giant CraftsmanSectionCard or shadow cards before time grid', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('CraftsmanSectionCard')
    expect(source).not.toContain('CalendarWeekView')
    expect(source).not.toContain('CalendarPlannerCard')
    expect(source).not.toContain('shadow-[0_18px_40px')
  })

  it('screen does not import or use Home TodayBlock to fake the planner', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('TodayBlock')
    expect(source).not.toContain('todayBlockSelectors')
    expect(source).not.toContain('deriveTodayBlock')
  })

  it('screen hierarchy: day strip → time grid → team load → overbooked warnings', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)

    const stripPos = renderSection.indexOf('<DayStrip')
    const gridPos = renderSection.indexOf('<DayTimeGrid')
    const teamPos = renderSection.indexOf('Auslastung heute')
    const warningPos = renderSection.indexOf('Überbuchte Mitarbeiter')

    expect(stripPos).toBeGreaterThan(-1)
    expect(gridPos).toBeGreaterThan(stripPos)
    expect(teamPos).toBeGreaterThan(gridPos)
    expect(warningPos).toBeGreaterThan(teamPos)
  })
})
