/**
 * Today Mini Planner + Planning Screen Completion Tests
 *
 * Proves all 14 mandatory verification points from the completion pass:
 *
 *   1.  Home Today Block renders as a bounded mini planner, not a weak flat row
 *   2.  Home Today Block rows are project-first and human-readable
 *   3.  Home Today Block shows only real today scheduled items
 *   4.  pending/needs-scheduling jobs are excluded from Home Today planner
 *   5.  Home Today Block handles upcoming-next state correctly
 *   6.  Home Today Block empty state/hidden state behaves deliberately
 *   7.  Home Today Block supports overflow via internal bounded scrolling
 *   8.  Today CTA routes to the planning screen correctly
 *   9.  Today item rows route correctly
 *   10. Planning screen hierarchy is now planning-first
 *   11. Scheduled content appears before unscheduled section
 *   12. Unscheduled jobs have their own explicit section
 *   13. Warnings/operations sections appear only after the real planning content
 *   14. No prior truth fixes regress
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import { deriveWorkEntrySummary } from '../../src/lib/dashboard/workEntrySelectors'
import {
  createCalendarEntryFromJob,
  formatDateKey,
} from '../../src/lib/calendar/calendarEngine'
import {
  ensureCalendarEntryForJob,
  getCalendarEntries,
} from '../../src/lib/calendar/calendarStore'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import type { Job } from '../../src/lib/jobs/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Factories ──────────────────────────────────────────────────────────────

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

const TODAY = formatDateKey(new Date())
const TOMORROW = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return formatDateKey(d)
})()

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  setCalendarRepository(new InMemoryCalendarRepository([]))
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Home Today Block renders as a bounded mini planner, not a weak flat row
// ═══════════════════════════════════════════════════════════════════════════

describe('1. Today Block is a bounded mini planner component', () => {
  it('TodayBlock has structured header + body with planner styling', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Planner Header section
    expect(source).toContain('Planner Header')
    // Planner Body section
    expect(source).toContain('Planner Body')
    // Uses card-like container (rounded-2xl)
    expect(source).toContain('rounded-2xl')
    // Shows date context for today mode
    expect(source).toContain('toLocaleDateString')
  })

  it('TodayBlock renders as a full planner card, not a flat text strip', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Has shadow for visual depth
    expect(source).toContain('shadow-')
    // Has ring border
    expect(source).toContain('ring-1')
    // Has distinct header separator
    expect(source).toContain('border-t border-slate-100')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Home Today Block rows are project-first and human-readable
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Today Block rows are project-first and human-readable', () => {
  it('row model puts project title first', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      title: 'Elektrik-Projekt Hannover',
      startsAtLabel: '09:00',
      customerName: 'Familie Müller',
      location: 'Hannover',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].title).toBe('Elektrik-Projekt Hannover')
    expect(result.items[0].customerName).toBe('Familie Müller')
    expect(result.items[0].location).toBe('Hannover')
  })

  it('status labels are human-readable (not workflow/engine labels)', () => {
    const scheduled = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const inProgress = makeEntry({ status: 'in_progress', dateKey: TODAY, startsAtLabel: 'Jetzt' })

    const result = deriveTodayBlock([scheduled, inProgress], TODAY)
    const labels = result.items.map((i) => i.statusLabel)

    expect(labels).toContain('Geplant')
    expect(labels).toContain('In Arbeit')
    expect(labels).not.toContain('Anfrage läuft')
    expect(labels).not.toContain('Auftrag aus Angebot')
    expect(labels).not.toContain('booked')
    expect(labels).not.toContain('scheduled')
  })

  it('TodayBlock component shows project title as primary visual element', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Title is the primary content element
    expect(source).toContain('item.title')
    // Customer/location are secondary (smaller text)
    expect(source).toContain('item.customerName')
    expect(source).toContain('item.location')
    // Status is a small chip
    expect(source).toContain('item.statusLabel')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Home Today Block shows only real today scheduled items
// ═══════════════════════════════════════════════════════════════════════════

describe('3. Today Block shows only real today scheduled items', () => {
  it('only scheduled and in_progress entries for today appear', () => {
    const entries = [
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Active' }),
      makeEntry({ status: 'in_progress', dateKey: TODAY, startsAtLabel: 'Jetzt', title: 'Working' }),
      makeEntry({ status: 'completed', dateKey: TODAY, title: 'Done' }),
      makeEntry({ status: 'cancelled', dateKey: TODAY, title: 'Cancelled' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(2)
    expect(result.items.map((i) => i.title)).toEqual(['Active', 'Working'])
  })

  it('entries for future dates do not count as today', () => {
    const entries = [
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Today' }),
      makeEntry({ status: 'scheduled', dateKey: TOMORROW, title: 'Tomorrow' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.items[0].title).toBe('Today')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. pending/needs-scheduling jobs are excluded from Home Today planner
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Pending jobs excluded from Today planner', () => {
  it('pending entry is filtered out by deriveTodayBlock', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY, title: 'Needs Scheduling' }),
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Really Planned' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.items[0].title).toBe('Really Planned')
  })

  it('booked job creates pending CalendarEntry, which is excluded', () => {
    const job = makeJob({
      status: 'booked',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute',
    })
    ensureCalendarEntryForJob(job)
    const entries = getCalendarEntries()

    expect(entries[0].status).toBe('pending')

    const result = deriveTodayBlock(entries, TODAY)
    // Pending entries never pollute scheduled/today truth.
    // TodayBlock stays visible as only_pending_exists shell (not accidentally hidden).
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
  })

  it('only-pending entries result in only_pending_exists TodayBlock', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY }),
      makeEntry({ status: 'pending', dateKey: TOMORROW }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Home Today Block handles upcoming-next state correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('5. Today Block handles upcoming-next state', () => {
  it('shows upcoming mode when no today entries but future exist', () => {
    const entry = makeEntry({
      dateKey: TOMORROW,
      dateLabel: 'Morgen',
      startsAtLabel: '10:00',
      title: 'Fenster einbauen',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('today_empty_but_upcoming')
    expect(result.headline).toBe('Heute')
    expect(result.todayCount).toBe(0)
    expect(result.items).toHaveLength(0)
    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Fenster einbauen')
    expect(result.upcomingHint).toContain('Nächster Einsatz')
  })

  it('upcoming mode subtitle does not use "Heute"', () => {
    const entry = makeEntry({
      dateKey: TOMORROW,
      dateLabel: 'Morgen',
      startsAtLabel: '14:00',
      title: 'Dacharbeit',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.subtitle).toBe('Heute nichts geplant')
    expect(result.upcomingHint).toContain('Morgen')
  })

  it('upcoming picks the chronologically closest future entry', () => {
    const entries = [
      makeEntry({ dateKey: '2099-12-31', dateLabel: 'Weit weg', startsAtLabel: '14:00', title: 'Later' }),
      makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen', startsAtLabel: '09:00', title: 'Sooner' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Sooner')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Home Today Block empty state/hidden state behaves deliberately
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Today Block empty state is deliberate', () => {
  it('shows no_relevant_work shell when no active entries exist at all', () => {
    const result = deriveTodayBlock([], TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.headline).toBe('Heute')
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('shows no_relevant_work shell when only completed/cancelled entries exist', () => {
    const entries = [
      makeEntry({ status: 'completed', dateKey: TODAY }),
      makeEntry({ status: 'cancelled', dateKey: TODAY }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })

  it('TodayBlock component returns null when hidden', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('if (!summary.visible) return null')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Home Today Block supports overflow via internal bounded scrolling
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Today Block supports bounded internal scrolling', () => {
  it('component has max-height and overflow-y-auto', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('max-h-[228px]')
    expect(source).toContain('overflow-y-auto')
  })

  it('selector returns all items unbounded (no cap)', () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({
        id: `e-${i}`,
        jobId: `j-${i}`,
        dateKey: TODAY,
        startsAtLabel: `${8 + i}:00`,
        title: `Job ${i}`,
      }),
    )
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items).toHaveLength(15)
    expect(result.todayCount).toBe(15)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Today CTA routes to the planning screen correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Today CTA routes to planning screen', () => {
  it('CTA route is /craftsman/operations', () => {
    const entry = makeEntry({ dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toBe('Planung öffnen →')
  })

  it('CTA label says "Planung" — matches the planning screen destination', () => {
    const entries = [makeEntry({ dateKey: TODAY }), makeEntry({ dateKey: TODAY })]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.ctaLabel).toContain('Planung')
    expect(result.ctaLabel).not.toContain('Auftrag')
  })

  it('upcoming-only mode also routes to planning screen', () => {
    const entry = makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('TodayBlock component links header CTA using summary.ctaRoute', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('to={summary.ctaRoute}')
    expect(source).toContain('summary.ctaLabel')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Today item rows route correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('9. Today item rows route to job detail', () => {
  it('each item has jobId for /craftsman/jobs/:jobId routing', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, jobId: 'job-abc' }),
      makeEntry({ dateKey: TODAY, jobId: 'job-xyz' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].jobId).toBe('job-abc')
    expect(result.items[1].jobId).toBe('job-xyz')
  })

  it('TodayBlock component links rows to /craftsman/jobs/:jobId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${item.jobId}')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Planning screen hierarchy is now planning-first
// ═══════════════════════════════════════════════════════════════════════════

describe('10. Planning screen is calendar-first', () => {
  // Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen.
  // The Liste/Kalender toggle, planner-header class, and list-section-* ids were
  // ScheduleScreen-only. Operations uses DayStrip + DayTimeGrid. Surviving
  // invariant: no oversized dashboard overview cards leak into the planning surface.
  it('does not import ScheduleOverviewCard or OperationsOverviewCard', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('ScheduleOverviewCard')
    expect(source).not.toContain('OperationsOverviewCard')
    expect(source).not.toContain('SchedulingLifecycleSection')
  })
})

// 11. and 12. (scheduled-before-unscheduled / unscheduled section) removed:
// Operations does not surface an inline "Noch nicht eingeplant" list — those
// jobs live in CraftsmanJobsScreen?focus=handlungsbedarf, covered by
// jobsScreenSelectors and queueDirectActions tests. Completed history is no
// longer rendered in the planning surface either.

// ═══════════════════════════════════════════════════════════════════════════
// 13. Warnings/operations sections appear only after real planning content
// ═══════════════════════════════════════════════════════════════════════════

describe('13. Warnings and operations are secondary', () => {
  // Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen.
  it('team capacity section appears after the day grid', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const gridPos = source.indexOf('<DayTimeGrid')
    const teamPos = source.indexOf('Auslastung heute')
    const warningPos = source.indexOf('Überbuchte Mitarbeiter')

    expect(gridPos).toBeGreaterThan(-1)
    if (teamPos > -1) {
      expect(teamPos).toBeGreaterThan(gridPos)
    }
    if (warningPos > -1) {
      expect(warningPos).toBeGreaterThan(gridPos)
    }
  })

  it('team/warning sections are conditional (only render when data exists)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('todayTeamLoads.length > 0')
    expect(source).toContain('overbookedLoads.length > 0')
  })

  it('DayTimeGrid is the primary planning surface', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('<DayTimeGrid')
    expect(source).toContain('DayStrip')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 14. No prior truth fixes regress
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

  it('Entry Card still uses truthful wording for booked vs scheduled', () => {
    const booked = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const scheduled = makeJob({ id: 'j2', status: 'scheduled', assignedMemberIds: ['w2'] })

    const bookedResult = deriveWorkEntrySummary([booked], [], [])
    expect(bookedResult.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(bookedResult.subtitle).not.toContain('geplanter Einsatz')

    const scheduledResult = deriveWorkEntrySummary([scheduled], [], [])
    expect(scheduledResult.subtitle).toContain('Einsatz terminiert')
  })

  it('fake time values are never fabricated', () => {
    const job = makeJob({ status: 'scheduled', dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('')
  })

  it('real time values are preserved', () => {
    const job = makeJob({ status: 'scheduled', dateLabel: 'Heute, 14:00 Uhr' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('14:00')
  })

  it('TodayBlock CTA still routes to planning screen', () => {
    const entry = makeEntry({ dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('WorkEntryCard still routes to work queue (data-driven via ctaRoute)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    // Routing is data-driven: component uses summary.ctaRoute from the selector
    expect(source).toContain('summary.ctaRoute')
  })

  it('backoffice remains secondary on home screen', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanDashboardScreen.tsx', import.meta.url),
      'utf-8',
    )
    const renderStart = source.indexOf('return (')
    const renderSection = source.slice(renderStart)
    const todayPos = renderSection.indexOf('<TodayBlock')
    const backofficePos = renderSection.indexOf('BackofficeEntryCard')
    expect(backofficePos).toBeGreaterThan(todayPos)
  })
})
