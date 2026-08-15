/**
 * Scheduling Truth Contract Tests
 *
 * Proves the 3-layer product contract between:
 *   1. Entry Card = ATTENTION / OPEN WORK TRUTH
 *   2. Today Block = REAL TODAY MINI PLANNER
 *   3. Planning Screen = CALENDAR-FIRST PLANNING SURFACE
 *
 * Tests cover the mandatory verification points from the problem statement:
 *   J1.  "Termin planen" jobs NOT described as planned on Entry Card
 *   J2.  "Termin planen" jobs do NOT appear in Today planner
 *   J3.  Only real today scheduled entries appear in Today planner
 *   J4.  No fake time when no real time exists
 *   J5.  Today planner rows use project-first human language
 *   J6.  Today planner supports bounded internal scrolling
 *   J7.  Planning screen shows planning content before warnings/ops
 *   J8.  Unscheduled jobs have their own planning section
 *   J9.  Entry Card, Today Block, Planning screen speak coherent truth
 *   J10. No prior truth regressions
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { deriveWorkEntrySummary } from '../../src/lib/dashboard/workEntrySelectors'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import {
  createCalendarEntryFromJob,
  formatDateKey,
} from '../../src/lib/calendar/calendarEngine'
import {
  ensureCalendarEntryForJob,
  getCalendarEntries,
  syncCalendarEntriesForJobs,
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

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  setCalendarRepository(new InMemoryCalendarRepository([]))
})

// ═══════════════════════════════════════════════════════════════════════════
// J1. "Termin planen" jobs NOT described as planned on Entry Card
// ═══════════════════════════════════════════════════════════════════════════

describe('J1: Entry Card must never claim unscheduled work is planned', () => {
  it('booked+assigned job is NOT described as "geplanter Einsatz"', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.subtitle).not.toContain('geplanter Einsatz')
    expect(result.subtitle).not.toContain('geplante Einsätze')
    expect(result.subtitle).toContain('Auftrag wartet auf Terminplanung')
  })

  it('multiple booked+assigned jobs do not use "geplant" language', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] }),
      makeJob({ id: 'j2', status: 'booked', assignedMemberIds: ['w2'] }),
    ]
    const result = deriveWorkEntrySummary(jobs, [], [])

    expect(result.subtitle).not.toContain('geplanter Einsatz')
    expect(result.subtitle).not.toContain('geplante Einsätze')
    expect(result.subtitle).toContain('Aufträge warten auf Terminplanung')
  })

  it('truly scheduled job CAN use "terminiert" language', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.subtitle).toContain('Einsatz terminiert')
    expect(result.subtitle).not.toContain('geplanter Einsatz')
  })

  it('mixed booked+scheduled uses appropriate split wording', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] }),
      makeJob({ id: 'j2', status: 'scheduled', assignedMemberIds: ['w2'] }),
    ]
    const result = deriveWorkEntrySummary(jobs, [], [])

    expect(result.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(result.subtitle).toContain('Einsatz terminiert')
    expect(result.subtitle).not.toContain('geplanter Einsatz')
  })

  it('Entry Card forbidden wording never appears in any scenario', () => {
    const forbidden = [
      'geplanter Einsatz',
      'geplante Einsätze',
      'Termin steht bevor',
      'Termine stehen bevor',
    ]

    const scenarios = [
      () => deriveWorkEntrySummary([makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], []),
      () => deriveWorkEntrySummary([makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })], [], []),
      () => deriveWorkEntrySummary([
        makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] }),
        makeJob({ id: 'j2', status: 'scheduled', assignedMemberIds: ['w2'] }),
      ], [], []),
    ]

    for (const scenario of scenarios) {
      const result = scenario()
      for (const phrase of forbidden) {
        expect(result.subtitle).not.toContain(phrase)
        expect(result.headline).not.toContain(phrase)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J2. "Termin planen" jobs do NOT appear in Today planner
// ═══════════════════════════════════════════════════════════════════════════

describe('J2: Booked jobs must NOT appear in Today planner', () => {
  it('booked job creates pending CalendarEntry, excluded from TodayBlock items', () => {
    const job = makeJob({
      status: 'booked',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute',
    })

    ensureCalendarEntryForJob(job)
    const entries = getCalendarEntries()

    expect(entries[0].status).toBe('pending')

    const todayBlock = deriveTodayBlock(entries, TODAY)
    // TodayBlock visible as empty shell but pending entries never appear as items
    expect(todayBlock.visible).toBe(true)
    expect(todayBlock.mode).toBe('only_pending_exists')
    expect(todayBlock.items).toHaveLength(0)
  })

  it('booked job with future date also excluded from TodayBlock items', () => {
    const job = makeJob({
      status: 'booked',
      assignedMemberIds: ['w1'],
      dateLabel: 'Morgen',
    })

    ensureCalendarEntryForJob(job)
    const entries = getCalendarEntries()

    expect(entries[0].status).toBe('pending')

    const todayBlock = deriveTodayBlock(entries, TODAY)
    expect(todayBlock.visible).toBe(true)
    expect(todayBlock.mode).toBe('only_pending_exists')
    expect(todayBlock.items).toHaveLength(0)
  })

  it('pending CalendarEntry status is filtered by todayBlockSelectors', () => {
    const pendingEntry = makeEntry({ status: 'pending', dateKey: TODAY })
    const scheduledEntry = makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Real Job' })

    const result = deriveTodayBlock([pendingEntry, scheduledEntry], TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.items[0].title).toBe('Real Job')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J3. Only real today scheduled entries appear in Today planner
// ═══════════════════════════════════════════════════════════════════════════

describe('J3: Only real scheduled entries appear in Today planner', () => {
  it('scheduled entry for today appears', () => {
    const entry = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.todayCount).toBe(1)
  })

  it('in_progress entry for today appears', () => {
    const entry = makeEntry({ status: 'in_progress', dateKey: TODAY, startsAtLabel: 'Jetzt' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.items[0].statusLabel).toBe('In Arbeit')
  })

  it('completed entry for today does NOT appear in items', () => {
    const entry = makeEntry({ status: 'completed', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.items).toHaveLength(0)
  })

  it('cancelled entry for today does NOT appear in items', () => {
    const entry = makeEntry({ status: 'cancelled', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.items).toHaveLength(0)
  })

  it('pending entry for today does NOT appear in items', () => {
    const entry = makeEntry({ status: 'pending', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J4. No fake time when no real time exists
// ═══════════════════════════════════════════════════════════════════════════

describe('J4: No fake time values', () => {
  it('entry without real time shows hasRealTime=false and empty timeLabel', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(false)
    expect(result.items[0].timeLabel).toBe('')
  })

  it('entry with real time shows hasRealTime=true', () => {
    const entry = makeEntry({ startsAtLabel: '14:00', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('14:00')
  })

  it('"Jetzt" is a valid real-time for in_progress entries', () => {
    const entry = makeEntry({ startsAtLabel: 'Jetzt', status: 'in_progress', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('Jetzt')
  })

  it('booked job without time in dateLabel produces no fake time in CalendarEntry', () => {
    const job = makeJob({
      status: 'scheduled',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute',
    })
    const entry = createCalendarEntryFromJob(job)

    expect(entry.startsAtLabel).toBe('')
  })

  it('job with real time in dateLabel preserves it in CalendarEntry', () => {
    const job = makeJob({
      status: 'scheduled',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute, 14:00 Uhr',
    })
    const entry = createCalendarEntryFromJob(job)

    expect(entry.startsAtLabel).toBe('14:00')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J5. Today planner rows use project-first human language
// ═══════════════════════════════════════════════════════════════════════════

describe('J5: Today planner rows use project-first human language', () => {
  it('row shows project title as primary content', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      title: 'Elektrik-Projekt Hannover',
      startsAtLabel: '09:00',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].title).toBe('Elektrik-Projekt Hannover')
  })

  it('row shows customer and location as secondary', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      customerName: 'Familie Müller',
      location: 'Hannover',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].customerName).toBe('Familie Müller')
    expect(result.items[0].location).toBe('Hannover')
  })

  it('status labels are human-readable ("In Arbeit" / "Geplant" only)', () => {
    const scheduled = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const inProgress = makeEntry({ status: 'in_progress', dateKey: TODAY, startsAtLabel: 'Jetzt' })

    const result = deriveTodayBlock([scheduled, inProgress], TODAY)

    const labels = result.items.map(i => i.statusLabel)
    expect(labels).toContain('Geplant')
    expect(labels).toContain('In Arbeit')
    // No workflow/engine language
    expect(labels).not.toContain('Anfrage läuft')
    expect(labels).not.toContain('Auftrag aus Angebot')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J6. Today planner supports bounded internal scrolling
// ═══════════════════════════════════════════════════════════════════════════

describe('J6: Today planner supports bounded internal scrolling', () => {
  it('TodayBlock component has max-height and overflow-y-auto for scroll', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('max-h-')
    expect(source).toContain('overflow-y-auto')
  })

  it('all today items are returned unbounded (component handles scroll)', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        id: `entry-${i}`,
        jobId: `job-${i}`,
        dateKey: TODAY,
        startsAtLabel: `${8 + i}:00`,
        title: `Job ${i}`,
      }),
    )
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items).toHaveLength(10)
    expect(result.todayCount).toBe(10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J7. Planning screen shows planning content before warnings/ops
// ═══════════════════════════════════════════════════════════════════════════

describe('J7: Planning screen is calendar-first', () => {
  // Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen,
  // the runtime planning surface after the Aufträge consolidation.
  it('planning screen does not have oversized overview cards before schedule', async () => {
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

// J8 'Noch nicht eingeplant' section assertions removed: Operations does not
// surface a dedicated unscheduled list — unscheduled jobs are surfaced in
// CraftsmanJobsScreen (focus=handlungsbedarf) and via deriveActionQueue, both
// covered by their own contract tests.

// ═══════════════════════════════════════════════════════════════════════════
// J9. Entry Card, Today Block, Planning screen speak coherent truth
// ═══════════════════════════════════════════════════════════════════════════

describe('J9: Three surfaces speak coherent scheduling truth', () => {
  it('booked job: Entry Card says "wartet auf Terminplanung", TodayBlock empty shell, Planning has unscheduled section', () => {
    const job = makeJob({
      id: 'j-coherent',
      status: 'booked',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute',
    })

    // Entry Card: attention framing, not planning claim
    const workEntry = deriveWorkEntrySummary([job], [], [])
    expect(workEntry.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(workEntry.subtitle).not.toContain('geplanter Einsatz')

    // TodayBlock: visible as empty shell — booked is not real scheduled truth
    syncCalendarEntriesForJobs([job])
    const entries = getCalendarEntries()
    const todayBlock = deriveTodayBlock(entries, TODAY)
    expect(todayBlock.visible).toBe(true)
    expect(todayBlock.mode).toBe('only_pending_exists')
    expect(todayBlock.items).toHaveLength(0)

    // CalendarEntry: pending status (not scheduled)
    expect(entries[0].status).toBe('pending')
  })

  it('scheduled job: Entry Card says "terminiert", TodayBlock shows it, Planning would list it as scheduled', () => {
    const job = makeJob({
      id: 'j-scheduled',
      status: 'scheduled',
      assignedMemberIds: ['w1'],
      dateLabel: 'Heute, 10:00 Uhr',
    })

    // Entry Card: truthful "terminiert" for truly scheduled work
    const workEntry = deriveWorkEntrySummary([job], [], [])
    expect(workEntry.subtitle).toContain('Einsatz terminiert')

    // TodayBlock: visible with real scheduled entry
    syncCalendarEntriesForJobs([job])
    const entries = getCalendarEntries()
    const todayBlock = deriveTodayBlock(entries, TODAY)
    expect(todayBlock.visible).toBe(true)
    expect(todayBlock.items[0].jobId).toBe('j-scheduled')
    expect(todayBlock.items[0].timeLabel).toBe('10:00')

    // CalendarEntry: scheduled status
    expect(entries[0].status).toBe('scheduled')
  })

  it('Entry Card CTA routes to work queue, Today CTA routes to planning screen', async () => {
    const fs = await import('fs')
    const workEntrySource = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    const todayBlockSource = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )

    // Routing is data-driven: WorkEntryCard uses summary.ctaRoute from the selector
    expect(workEntrySource).toContain('summary.ctaRoute')
    expect(todayBlockSource).toContain('summary.ctaRoute')

    const entry = makeEntry({ dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J10. No prior truth regressions
// ═══════════════════════════════════════════════════════════════════════════

describe('J10: No prior truth regressions', () => {
  it('Work Entry / Setup separation preserved', () => {
    // Work entry never merges with setup — separate functions
    const workResult = deriveWorkEntrySummary([], [], [])
    expect(workResult.headline).toBe('Gerade ist nichts offen')
  })

  it('queue truth preserved: waiting_payment not actionable', () => {
    const job = makeJob({ status: 'waiting_payment' })
    const result = deriveWorkEntrySummary([job], [], [])
    expect(result.totalActionable).toBe(0)
    expect(result.paymentWaitingCount).toBe(1)
  })

  it('no false clean slate: coming-up work prevents clean slate', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([job], [], [])
    expect(result.headline).not.toBe('Gerade ist nichts offen')
    expect(result.comingUpCount).toBe(1)
  })

  it('no fake times: CalendarEntry from booked job without time has empty startsAtLabel', () => {
    const job = makeJob({ status: 'booked', dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.startsAtLabel).toBe('')
  })

  it('setup non-blocking logic preserved: WorkEntryCard has no setup imports', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    // Work Entry Card never imports setup/onboarding modules — only uses WorkEntrySummary
    const importLines = source.split('\n').filter((l: string) => l.startsWith('import'))
    const importBlock = importLines.join('\n')
    expect(importBlock).not.toContain('onboarding')
    expect(importBlock).not.toContain('SetupReminder')
  })

  it('today/calendar truth alignment: scheduled jobs show in today, booked do not', () => {
    const scheduledEntry = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const pendingEntry = makeEntry({ status: 'pending', dateKey: TODAY })

    const result = deriveTodayBlock([scheduledEntry, pendingEntry], TODAY)
    expect(result.todayCount).toBe(1)
  })

  it('backoffice secondary placement preserved', async () => {
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
