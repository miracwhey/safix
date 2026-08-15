/**
 * Scheduling Cleanup Contract — Final Contradiction Fixes
 *
 * Proves:
 *  1. After successful schedule save, Home Entry no longer derives a job as
 *     "waiting for scheduling" when Today already derives it as scheduled.
 *  2. Entry and Today cannot contradict each other on scheduling truth:
 *     if CalendarEntry is 'scheduled', scheduledJobIds must include the jobId.
 *  3. A scheduled job (via CalendarEntry truth) exits the "needs scheduling" bucket.
 *  4. If another issue exists alongside a scheduled job, Entry moves to that issue.
 *  5. If no other issue exists, Entry moves to the correct passive state ("terminiert").
 *  6. Raw internal IDs no longer render in DayTimeGrid (source-level check).
 *  (7 + 8 removed when ScheduledRow / UpcomingRow were deleted with CraftsmanScheduleScreen.)
 *  9. Human-readable names still render correctly when available.
 * 10. No regressions to canonical scheduling truth.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { deriveWorkEntrySummary } from '../../src/lib/dashboard/workEntrySelectors'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import { formatDateKey } from '../../src/lib/calendar/calendarEngine'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import type { Job } from '../../src/lib/jobs/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Dispute } from '../../src/lib/disputes/types'

// ── Constants ──────────────────────────────────────────────────────────────

const TODAY = formatDateKey(new Date())

// ── Factories ──────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'booked',
    amount: '1.000 €',
    description: 'Test description',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: ['w1'],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makeCalEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `cal-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Entry',
    customerName: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: TODAY,
    startsAtLabel: '10:00',
    endsAtLabel: '12:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: `dispute-${Math.random().toString(36).slice(2, 8)}`,
    jobId: 'job-1',
    status: 'open',
    reason: 'work_quality',
    title: 'Streitfall',
    description: 'Test dispute',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  setCalendarRepository(new InMemoryCalendarRepository([]))
})

// ══════════════════════════════════════════════════════════════════════════
// 1. Post-save: Home Entry no longer contradicts Today block
// ══════════════════════════════════════════════════════════════════════════

describe('1. Post-save: Home Entry no longer derives "waiting for scheduling" when Today shows scheduled', () => {
  it('booked job with scheduledJobIds from CalendarEntry exits "wartet auf Terminplanung" bucket', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const calEntry = makeCalEntry({ jobId: 'j1', status: 'scheduled', dateKey: TODAY, startsAtLabel: '10:00' })

    // This is how the dashboard now computes scheduledJobIds:
    // it merges operations schedules + calendar entries with status 'scheduled'|'in_progress'
    const scheduledJobIds = new Set(
      [calEntry].filter((e) => e.status === 'scheduled' || e.status === 'in_progress').map((e) => e.jobId),
    )

    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    const todayBlock = deriveTodayBlock([calEntry], TODAY)

    // Entry no longer says "waiting for scheduling"
    expect(workEntry.subtitle).not.toContain('wartet auf Terminplanung')
    // Entry says "terminiert" instead
    expect(workEntry.subtitle).toContain('terminiert')
    // Today block shows the job as scheduled
    expect(todayBlock.mode).toBe('today_has_items')
  })

  it('calEntry status in_progress also makes booked job exit "wartet auf Terminplanung"', () => {
    const job = makeJob({ id: 'j2', status: 'booked', assignedMemberIds: ['w1'] })
    const calEntry = makeCalEntry({
      jobId: 'j2',
      status: 'in_progress',
      dateKey: TODAY,
      startsAtLabel: 'Jetzt',
    })

    const scheduledJobIds = new Set(
      [calEntry].filter((e) => e.status === 'scheduled' || e.status === 'in_progress').map((e) => e.jobId),
    )

    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    expect(workEntry.subtitle).not.toContain('wartet auf Terminplanung')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 2. Entry and Today cannot contradict each other
// ══════════════════════════════════════════════════════════════════════════

describe('2. Entry and Today cannot contradict each other on scheduling truth', () => {
  it('if CalendarEntry is scheduled, Entry must not say "wartet auf Terminplanung"', () => {
    const job = makeJob({ id: 'j-sync', status: 'booked', assignedMemberIds: ['w1'] })
    const calEntry = makeCalEntry({ jobId: 'j-sync', status: 'scheduled', dateKey: TODAY, startsAtLabel: '09:00' })

    // Derive scheduledJobIds from CalendarEntry (canonical fix)
    const scheduledJobIds = new Set(
      [calEntry].filter((e) => e.status === 'scheduled').map((e) => e.jobId),
    )

    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    const todayBlock = deriveTodayBlock([calEntry], TODAY)

    // Neither should say "waiting" while the other says "scheduled"
    const entryWaiting = workEntry.subtitle.includes('wartet auf Terminplanung')
    const todayScheduled = todayBlock.mode === 'today_has_items'

    // The contradiction is impossible:
    // If today shows scheduled, entry must NOT say waiting
    expect(entryWaiting && todayScheduled).toBe(false)
    // Positive assertion: entry says terminiert, today has items
    expect(workEntry.subtitle).toContain('terminiert')
    expect(todayBlock.mode).toBe('today_has_items')
  })

  it('pending CalendarEntry → Entry says "wartet auf Terminplanung", Today shows empty shell (no contradiction)', () => {
    const job = makeJob({ id: 'j-pending', status: 'booked', assignedMemberIds: ['w1'] })
    const calEntry = makeCalEntry({ jobId: 'j-pending', status: 'pending', dateKey: TODAY })

    // No scheduled IDs (pending is not scheduled)
    const scheduledJobIds = new Set<string>()

    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    const todayBlock = deriveTodayBlock([calEntry], TODAY)

    // Consistent: entry says waiting, today shows empty shell (not "today_has_items")
    expect(workEntry.subtitle).toContain('wartet auf Terminplanung')
    expect(todayBlock.mode).not.toBe('today_has_items')
    // No contradiction: entry saying "waiting" is consistent with today showing "pending" shell
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 3. Scheduled job exits "needs scheduling" bucket
// ══════════════════════════════════════════════════════════════════════════

describe('3. A scheduled job exits the "needs scheduling" bucket used by Home Entry', () => {
  it('booked job in scheduledJobIds exits "wartet auf Terminplanung"', () => {
    const job = makeJob({ id: 'j-sched', status: 'booked', assignedMemberIds: ['w1'] })

    const before = deriveWorkEntrySummary([job], [], [])
    expect(before.subtitle).toContain('wartet auf Terminplanung')

    const scheduledJobIds = new Set([job.id])
    const after = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    expect(after.subtitle).not.toContain('wartet auf Terminplanung')
    expect(after.subtitle).toContain('terminiert')
  })

  it('multiple booked jobs: only unscheduled ones remain in "wartet" bucket', () => {
    const j1 = makeJob({ id: 'j-a', status: 'booked', assignedMemberIds: ['w1'] })
    const j2 = makeJob({ id: 'j-b', status: 'booked', assignedMemberIds: ['w2'] })

    // Only j1 has been scheduled
    const scheduledJobIds = new Set([j1.id])

    const result = deriveWorkEntrySummary([j1, j2], [], [], scheduledJobIds)

    expect(result.subtitle).toContain('1 Auftrag wartet auf Terminplanung') // j2 still waiting
    expect(result.subtitle).toContain('1 Einsatz terminiert') // j1 scheduled
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 4. If another issue exists, Entry moves to that issue
// ══════════════════════════════════════════════════════════════════════════

describe('4. If another issue exists, Entry moves to that issue (not scheduling)', () => {
  it('when booked job is scheduled but dispute exists, dispute takes priority', () => {
    const job = makeJob({ id: 'j-disp', status: 'booked', assignedMemberIds: ['w1'] })
    const dispute = makeDispute({ jobId: 'j-disp' })
    const scheduledJobIds = new Set([job.id])

    const result = deriveWorkEntrySummary([job], [dispute], [], scheduledJobIds)

    expect(result.urgency).toBe('critical')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.subtitle).not.toContain('wartet auf Terminplanung')
    expect(result.disputeCount).toBe(1)
  })

  it('when booked job is scheduled but unassigned job also exists, unassigned takes priority', () => {
    const scheduledJob = makeJob({ id: 'j-scheduled', status: 'booked', assignedMemberIds: ['w1'] })
    const unassignedJob = makeJob({ id: 'j-unassigned', status: 'booked', assignedMemberIds: [] })
    const scheduledJobIds = new Set([scheduledJob.id])

    const result = deriveWorkEntrySummary([scheduledJob, unassignedJob], [], [unassignedJob], scheduledJobIds)

    // Unassigned is actionable and takes priority
    expect(result.totalActionable).toBe(1)
    expect(result.unassignedCount).toBe(1)
    expect(result.urgency).toBe('high')
    expect(result.subtitle).not.toContain('wartet auf Terminplanung')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 5. If no other issue, Entry moves to correct passive state
// ══════════════════════════════════════════════════════════════════════════

describe('5. If no other issue exists, Entry moves to correct passive state', () => {
  it('single booked scheduled job → Entry shows "1 Einsatz terminiert" (passive)', () => {
    const job = makeJob({ id: 'j-pass', status: 'booked', assignedMemberIds: ['w1'] })
    const scheduledJobIds = new Set([job.id])

    const result = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    expect(result.totalActionable).toBe(0)
    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.subtitle).toContain('1 Einsatz terminiert')
    expect(result.urgency).toBe('normal')
  })

  it('no remaining issues after scheduling → headline stays passive, not "Gerade ist nichts offen"', () => {
    const job = makeJob({ id: 'j-all-ok', status: 'booked', assignedMemberIds: ['w1'] })
    const scheduledJobIds = new Set([job.id])

    const result = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    // comingUpCount > 0, so NOT clean slate
    expect(result.headline).not.toBe('Gerade ist nichts offen')
    expect(result.totalRemaining).toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 6. Raw internal IDs no longer render in DayTimeGrid
// ══════════════════════════════════════════════════════════════════════════

describe('6. Raw internal IDs no longer render in DayTimeGrid', () => {
  it('DayTimeGrid uses filter-out pattern for unresolved member IDs', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // Must filter out undefined names — not fall back to raw IDs
    expect(source).toContain('.filter((name): name is string => !!name)')
    // Must NOT use ?? id fallback to raw identifier
    expect(source).not.toContain('?? id')
    expect(source).not.toMatch(/memberNameMap\.get\(id\) \?\? id/)
  })
})

// Sections 7 + 8 (ScheduledRow / UpcomingRow ID-leak guards) removed: both
// components are deleted along with CraftsmanScheduleScreen. The same
// filter-out invariant is enforced on DayTimeGrid (Section 6 above) and
// TeamLoadCard (Section 8b below) — the only surviving member-rendering
// surfaces in the planning runtime.

// ══════════════════════════════════════════════════════════════════════════
// 8b. Raw internal IDs no longer render in TeamLoadCard
// ══════════════════════════════════════════════════════════════════════════

describe('8b. TeamLoadCard no longer leaks raw memberId in fallback label', () => {
  it('TeamLoadCard fallback for unknown member does not include raw memberId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/TeamLoadCard.tsx', import.meta.url),
      'utf-8',
    )
    // Must NOT use template literal with memberId as visible text
    expect(source).not.toContain('`Mitarbeiter ${memberId}`')
    expect(source).not.toContain('?? `Mitarbeiter ${memberId}`')
  })

  it('TeamLoadCard uses a clean fallback without raw identifier', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/TeamLoadCard.tsx', import.meta.url),
      'utf-8',
    )
    // Clean fallback is present (Mitarbeiter without ID)
    expect(source).toContain("?? 'Mitarbeiter'")
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 9. Human-readable names still render correctly when available
// ══════════════════════════════════════════════════════════════════════════

describe('9. Human-readable names still render correctly when available', () => {
  it('WorkEntry subtitle correctly labels scheduled booked jobs as "terminiert"', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const scheduledJobIds = new Set([job.id])

    const result = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    expect(result.subtitle).toContain('Einsatz terminiert')
  })

  it('WorkEntry subtitle correctly labels unscheduled booked jobs as "wartet auf Terminplanung"', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })

    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.subtitle).toContain('wartet auf Terminplanung')
  })

  it('WorkEntry mixed: both "terminiert" and "wartet" labels are used for correct jobs', () => {
    const scheduledJob = makeJob({ id: 'j-s', status: 'booked', assignedMemberIds: ['w1'] })
    const unscheduledJob = makeJob({ id: 'j-u', status: 'booked', assignedMemberIds: ['w2'] })
    const scheduledJobIds = new Set([scheduledJob.id])

    const result = deriveWorkEntrySummary([scheduledJob, unscheduledJob], [], [], scheduledJobIds)

    expect(result.subtitle).toContain('Einsatz terminiert')
    expect(result.subtitle).toContain('Auftrag wartet auf Terminplanung')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 10. No regressions to canonical scheduling truth
// ══════════════════════════════════════════════════════════════════════════

describe('10. No regressions to canonical scheduling truth', () => {
  it('job with status=scheduled is still effectively scheduled regardless of scheduledJobIds', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })

    // Even without scheduledJobIds, scheduled-status job shows "terminiert"
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.subtitle).toContain('Einsatz terminiert')
    expect(result.subtitle).not.toContain('wartet auf Terminplanung')
  })

  it('TodayBlock still excludes pending entries from items', () => {
    const pendingEntry = makeCalEntry({ status: 'pending', dateKey: TODAY })
    const todayBlock = deriveTodayBlock([pendingEntry], TODAY)

    expect(todayBlock.mode).toBe('only_pending_exists')
    expect(todayBlock.items).toHaveLength(0)
  })

  it('TodayBlock still shows scheduled entries from today', () => {
    const scheduledEntry = makeCalEntry({ status: 'scheduled', dateKey: TODAY, startsAtLabel: '09:00' })
    const todayBlock = deriveTodayBlock([scheduledEntry], TODAY)

    expect(todayBlock.mode).toBe('today_has_items')
    expect(todayBlock.todayCount).toBe(1)
  })

  it('clean slate is still returned when no jobs exist', () => {
    const result = deriveWorkEntrySummary([], [], [])

    expect(result.headline).toBe('Gerade ist nichts offen')
    expect(result.urgency).toBe('none')
    expect(result.totalRemaining).toBe(0)
  })

  it('CraftsmanDashboardScreen derives scheduledJobIds from BOTH schedules and calendarEntries', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanDashboardScreen.tsx', import.meta.url),
      'utf-8',
    )
    // scheduledJobIds must merge both operations store and calendar entry sources
    expect(source).toContain('...schedules.map((s) => s.jobId)')
    expect(source).toContain("e.status === 'scheduled' || e.status === 'in_progress'")
    expect(source).toContain('[schedules, calendarEntries]')
  })
})
