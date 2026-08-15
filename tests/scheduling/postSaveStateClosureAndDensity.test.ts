/**
 * Post-Save State Closure + Planning Densification Contract Tests
 *
 * Proves:
 *  1. successful schedule save removes the scheduling affordance from the same job
 *  2. successful schedule save closes/resolves the inline scheduling panel state
 *  3. Home Entry re-derives away from "waiting for scheduling" after save
 *  4. the scheduled job leaves unscheduled sections after save
 *  5. the scheduled job appears in the correct scheduled day/grid after save
 *  6. cancel leaves UI truth unchanged
 *  7. failed save leaves UI truth unchanged
 *  8. DayTimeGrid blocks show denser operational information
 *  9. visible team/worker names do not leak raw internal IDs when human-readable names exist
 * 10. List mode rows are denser and still readable
 * 11. no calendar/list truth regressions
 * 12. no duplicate scheduling affordance remains after success
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner } from '../helpers/mockSession'
import {
  performCanonicalScheduleSave,
} from '../../src/lib/scheduling'
import {
  getScheduleByJobId,
  getUnscheduledJobIds,
  getSchedules,
} from '../../src/lib/operations'
import {
  getCalendarEntryByJobId,
  ensureCalendarEntryForJob,
  getCalendarEntries,
} from '../../src/lib/calendar/calendarStore'
import {
  getTimedEntriesForDay,
  getPendingEntries,
} from '../../src/lib/calendar/calendarSelectors'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import { deriveActionQueue } from '../../src/lib/dashboard/actionQueueSelectors'
import { deriveWorkEntrySummary } from '../../src/lib/dashboard/workEntrySelectors'
import { formatDateKey } from '../../src/lib/calendar/calendarEngine'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import { InMemoryTeamMemberRepository } from '../../src/lib/team/repository'
import { setTeamMemberRepository } from '../../src/lib/team'
import type { TeamMember } from '../../src/lib/jobs'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import DayTimeGrid from '../../src/components/calendar/DayTimeGrid'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Factories ──────────────────────────────────────────────────────────────

const TODAY = formatDateKey(new Date())
const MISSING_MEMBER_ID_1 = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

const SCHED_POST_OWNER_ID = 'sched-post-owner'

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
    craftsmanUserId: SCHED_POST_OWNER_ID,
    ...overrides,
  }
}

function todayAt(hour: number): { scheduledStart: number; scheduledEnd: number } {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return {
    scheduledStart: d.getTime(),
    scheduledEnd: d.getTime() + 2 * 60 * 60 * 1000,
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
  setupCleanRepositories()
  installSessionForJobOwner({ craftsmanUserId: SCHED_POST_OWNER_ID })
})

function withTeamMembers(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  setTeamMemberRepository(repo)
  for (const member of members) {
    repo.add(member)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. successful schedule save removes scheduling affordance
// ═══════════════════════════════════════════════════════════════════════════

describe('1. successful save removes scheduling affordance from job', () => {
  it('action queue no longer shows plan_appointment for job after save', async () => {
    const job = makeJob({ id: 'afford-1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: shows plan_appointment
    const before = deriveActionQueue([job], [], [])
    const itemBefore = before.comingUp.find((i) => i.job.id === 'afford-1')
    expect(itemBefore?.primaryAction?.id).toBe('plan_appointment')

    // Save
    await performCanonicalScheduleSave({ jobId: 'afford-1', ...todayAt(9) })

    // After: scheduledJobIds includes the job, so plan_appointment is replaced
    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const after = deriveActionQueue([job], [], [], scheduledJobIds)
    const itemAfter = after.comingUp.find((i) => i.job.id === 'afford-1')
    expect(itemAfter?.primaryAction?.id).toBe('view_schedule')
    expect(itemAfter?.primaryAction?.id).not.toBe('plan_appointment')
  })

  it('"Termin planen" label disappears from job queue item after save', async () => {
    const job = makeJob({ id: 'afford-2', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'afford-2', ...todayAt(14) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const queue = deriveActionQueue([job], [], [], scheduledJobIds)
    const item = queue.comingUp.find((i) => i.job.id === 'afford-2')
    expect(item?.primaryAction?.label).not.toBe('Termin planen')
    expect(item?.phaseLabel).toBe('Geplant')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. successful save closes/resolves inline scheduling panel state
// ═══════════════════════════════════════════════════════════════════════════

describe('2. post-save inline panel state resolves', () => {
  it('CraftsmanJobsScreen collapses expandedCardId after scheduling', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanJobsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // After save, setExpandedCardId(null) closes the inline panel
    expect(source).toContain('setExpandedCardId(null)')
    // Screen subscribes to operations so it re-derives
    expect(source).toContain('subscribeOperations')
  })

  it('unified jobs screen subscribes to operations store for re-derivation after save', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanJobsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('subscribeOperations')
    expect(source).toContain('setSchedules(getSchedules())')
    expect(source).toContain('scheduledJobIds')
    // Must also subscribe to calendar for CalendarEntry-based schedule truth
    expect(source).toContain('subscribeCalendar')
    expect(source).toContain('setCalendarEntries(getCalendarEntries())')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Home Entry re-derives away from "waiting for scheduling" after save
// ═══════════════════════════════════════════════════════════════════════════

describe('3. Home Entry re-derives away from scheduling-waiting after save', () => {
  it('work entry no longer says "wartet auf Terminplanung" for scheduled booked job', async () => {
    const job = makeJob({ id: 'home-x1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: without schedule awareness, shows "wartet auf Terminplanung"
    const before = deriveWorkEntrySummary([job], [], [])
    expect(before.subtitle).toContain('wartet auf Terminplanung')

    // Save
    await performCanonicalScheduleSave({ jobId: 'home-x1', ...todayAt(9) })

    // After: with schedule awareness, no longer "wartet auf Terminplanung"
    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const after = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    expect(after.subtitle).not.toContain('wartet auf Terminplanung')
    expect(after.subtitle).toContain('terminiert')
  })

  it('Home Entry and Today cannot contradict: scheduled booked job is not in waiting bucket', async () => {
    const job = makeJob({ id: 'home-consistency-1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'home-consistency-1', ...todayAt(9) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    const todayBlock = deriveTodayBlock(getCalendarEntries(), TODAY)

    expect(todayBlock.items.some((item) => item.jobId === 'home-consistency-1')).toBe(true)
    expect(workEntry.subtitle).not.toContain('wartet auf Terminplanung')
    expect(workEntry.subtitle).toContain('terminiert')
  })

  it('after scheduling, entry falls through to next operational issue instead of scheduling', async () => {
    const scheduledBooked = makeJob({ id: 'home-next-1', status: 'booked', assignedMemberIds: ['w1'] })
    const newRequest = makeJob({ id: 'home-next-2', status: 'new', assignedMemberIds: [] })
    await getJobRepository().add(scheduledBooked)
    await getJobRepository().add(newRequest)
    ensureCalendarEntryForJob(scheduledBooked)

    await performCanonicalScheduleSave({ jobId: 'home-next-1', ...todayAt(10) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const workEntry = deriveWorkEntrySummary(
      [scheduledBooked, newRequest],
      [],
      [],
      scheduledJobIds,
    )

    expect(workEntry.headline).toBe('1 Anfrage braucht Prüfung')
    expect(workEntry.subtitle).not.toContain('wartet auf Terminplanung')
  })

  it('after scheduling with no other issue, entry becomes passive overview', async () => {
    const job = makeJob({ id: 'home-passive-1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'home-passive-1', ...todayAt(11) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    expect(workEntry.eyebrow).toBe('Im Blick behalten')
    expect(workEntry.headline).toBe('1 Auftrag im Blick')
    expect(workEntry.subtitle).toContain('1 Einsatz terminiert')
    // CTA must switch to planning domain when only scheduled future work remains
    expect(workEntry.ctaLabel).toBe('Planung öffnen →')
    expect(workEntry.ctaRoute).toBe('/craftsman/operations')
  })

  it('domain consistency: scheduled-only state routes to planner, not empty work queue', async () => {
    const job = makeJob({ id: 'domain-x1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'domain-x1', ...todayAt(14) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const workEntry = deriveWorkEntrySummary([job], [], [], scheduledJobIds)
    const actionQueue = deriveActionQueue([job], [], [], scheduledJobIds)

    // Action queue is empty (no needsAction, no waiting, no inProgress — only comingUp)
    expect(actionQueue.needsAction).toHaveLength(0)
    expect(actionQueue.waiting).toHaveLength(0)
    expect(actionQueue.inProgress).toHaveLength(0)

    // Home Entry uses planning CTA, agreeing with the empty action queue
    expect(workEntry.ctaRoute).toBe('/craftsman/operations')
    expect(workEntry.ctaLabel).toBe('Planung öffnen →')
    // Must NOT still point to the (now-empty) work queue
    expect(workEntry.ctaRoute).not.toBe('/craftsman/jobs?focus=handlungsbedarf')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. scheduled job leaves unscheduled sections after save
// ═══════════════════════════════════════════════════════════════════════════

describe('4. scheduled job leaves unscheduled sections', () => {
  it('job leaves getUnscheduledJobIds after canonical save', async () => {
    const job = makeJob({ id: 'unsched-x1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    expect(getUnscheduledJobIds(['unsched-x1'], getSchedules())).toContain('unsched-x1')

    await performCanonicalScheduleSave({ jobId: 'unsched-x1', ...todayAt(10) })

    expect(getUnscheduledJobIds(['unsched-x1'], getSchedules())).not.toContain('unsched-x1')
  })

  it('job leaves pending entries after save', async () => {
    const job = makeJob({ id: 'unsched-x2', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    expect(getPendingEntries(getCalendarEntries()).some((e) => e.jobId === 'unsched-x2')).toBe(true)

    await performCanonicalScheduleSave({ jobId: 'unsched-x2', ...todayAt(11) })

    expect(getPendingEntries(getCalendarEntries()).some((e) => e.jobId === 'unsched-x2')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. scheduled job appears in correct day/grid
// ═══════════════════════════════════════════════════════════════════════════

describe('5. scheduled job appears in correct scheduled day/grid', () => {
  it('appears in getTimedEntriesForDay with correct time labels', async () => {
    const job = makeJob({ id: 'grid-x1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'grid-x1', ...todayAt(14) })

    const timedEntries = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    const entry = timedEntries.find((e) => e.jobId === 'grid-x1')
    expect(entry).toBeDefined()
    expect(entry!.startsAtLabel).toBe('14:00')
    expect(entry!.endsAtLabel).toBe('16:00')
    expect(entry!.status).toBe('scheduled')
  })

  it('appears in TodayBlock items when scheduled for today', async () => {
    const job = makeJob({ id: 'grid-x2', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'grid-x2', ...todayAt(10) })

    const todayBlock = deriveTodayBlock(getCalendarEntries(), TODAY)
    expect(todayBlock.mode).toBe('today_has_items')
    expect(todayBlock.items.some((i) => i.jobId === 'grid-x2')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. cancel leaves UI truth unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('6. cancel leaves UI truth unchanged', () => {
  it('no mutation when user never calls performCanonicalScheduleSave', async () => {
    const job = makeJob({ id: 'cancel-x1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // "Cancel" = user dismisses panel without calling save
    expect(getScheduleByJobId('cancel-x1')).toBeUndefined()
    expect(getCalendarEntryByJobId('cancel-x1')!.status).toBe('pending')
    expect(getUnscheduledJobIds(['cancel-x1'], getSchedules())).toContain('cancel-x1')

    // Action queue still shows plan_appointment
    const queue = deriveActionQueue([job], [], [])
    const item = queue.comingUp.find((i) => i.job.id === 'cancel-x1')
    expect(item?.primaryAction?.id).toBe('plan_appointment')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. failed save leaves UI truth unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('7. failed save leaves UI truth unchanged', () => {
  it('failed save does not create false scheduled UI', async () => {
    const result = await performCanonicalScheduleSave({
      jobId: 'nonexistent-fail',
      ...todayAt(9),
    })

    expect(result.success).toBe(false)
    expect(getScheduleByJobId('nonexistent-fail')).toBeUndefined()

    // No false entry in timed grid
    const timedEntries = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    expect(timedEntries.some((e) => e.jobId === 'nonexistent-fail')).toBe(false)

    // TodayBlock doesn't show the item
    const todayBlock = deriveTodayBlock(getCalendarEntries(), TODAY)
    expect(todayBlock.items.some((i) => i.jobId === 'nonexistent-fail')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. DayTimeGrid blocks show denser operational information
// ═══════════════════════════════════════════════════════════════════════════

describe('8. DayTimeGrid blocks use adaptive density', () => {
  it('DayTimeGrid has compact, medium, and full rendering paths', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // Adaptive rendering based on block height
    expect(source).toContain('isCompact')
    expect(source).toContain('isMedium')
    // Compact mode: single-line time + title
    expect(source).toContain('h-full')
    // Full mode: time + status badge + title + location + worker
    expect(source).toContain('getCalendarStatusLabel')
    expect(source).toContain('entry.title')
    expect(source).toContain('entry.location')
    expect(source).toContain('assigneeNames')
  })

  it('DayTimeGrid event blocks show time, title, location, and worker names', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('startsAtLabel')
    expect(source).toContain('endsAtLabel')
    expect(source).toContain('entry.title')
    expect(source).toContain('entry.location')
    expect(source).toContain('assigneeNames')
    expect(source).toContain('memberNameMap')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. visible names do not leak raw internal IDs
// ═══════════════════════════════════════════════════════════════════════════

describe('9. human-readable names over raw IDs', () => {
  it('DayTimeGrid filters out IDs when no matching name exists', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/calendar/DayTimeGrid.tsx', import.meta.url),
      'utf-8',
    )
    // Uses .filter to exclude undefined names — never falls back to raw ID
    expect(source).toContain('.filter((name): name is string => !!name)')
    expect(source).not.toContain('?? id')
  })

  // ScheduledRow + UpcomingRow source-string assertions removed: those
  // components are deleted along with CraftsmanScheduleScreen. The
  // equivalent name-resolution invariant is enforced on the surviving
  // surface (DayTimeGrid) by the tests above and below.

  it('DayTimeGrid does not render raw internal IDs and still renders names when available', () => {
    withTeamMembers([{ id: 'tm-visible', name: 'Leon Becker', role: 'Elektriker' }])
    const entry = makeEntry({
      id: 'grid-name-1',
      assignedMemberIds: ['tm-visible', MISSING_MEMBER_ID_1],
    })

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(DayTimeGrid, { entries: [entry], isToday: false }),
      ),
    )

    expect(html).toContain('Leon Becker')
    expect(html).not.toContain(MISSING_MEMBER_ID_1)
  })

  // ScheduledRow + UpcomingRow SSR render-tests removed: those components
  // were deleted along with CraftsmanScheduleScreen. The same name-resolution
  // invariant is verified above against DayTimeGrid (the surviving runtime
  // surface that renders worker names).
})

// Section 10 (list-mode row density) removed: the orphan ScheduleScreen and its
// ScheduledRow/UpcomingRow components no longer exist. Density of the planning
// surface (DayTimeGrid) is covered by Section 8 above.

// ═══════════════════════════════════════════════════════════════════════════
// 11. no calendar/list truth regressions
// ═══════════════════════════════════════════════════════════════════════════

describe('11. no calendar/list truth regressions', () => {
  it('getTimedEntriesForDay still excludes pending entries', () => {
    const timed = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    for (const entry of timed) {
      expect(entry.status).not.toBe('pending')
    }
    // Also check explicitly with a known pending
    const job = makeJob({ id: 'regr-1', status: 'booked' })
    ensureCalendarEntryForJob(job)
    const result = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    expect(result.some((e) => e.jobId === 'regr-1')).toBe(false)
  })

  it('getPendingEntries still returns only pending status entries', () => {
    const job = makeJob({ id: 'regr-2', status: 'booked' })
    ensureCalendarEntryForJob(job)
    const pending = getPendingEntries(getCalendarEntries())
    expect(pending.every((e) => e.status === 'pending')).toBe(true)
  })

  it('deriveActionQueue backward compatible when scheduledJobIds is omitted', () => {
    const job = makeJob({ id: 'compat-1', status: 'booked', assignedMemberIds: ['w1'] })
    // No 4th argument — backward compat
    const queue = deriveActionQueue([job], [], [])
    const item = queue.comingUp.find((i) => i.job.id === 'compat-1')
    expect(item?.primaryAction?.id).toBe('plan_appointment')
  })

  it('deriveWorkEntrySummary backward compatible when scheduledJobIds is omitted', () => {
    const job = makeJob({ id: 'compat-2', status: 'booked', assignedMemberIds: ['w1'] })
    // No 4th argument — backward compat
    const summary = deriveWorkEntrySummary([job], [], [])
    expect(summary.subtitle).toContain('wartet auf Terminplanung')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. no duplicate scheduling affordance after success
// ═══════════════════════════════════════════════════════════════════════════

describe('12. no duplicate scheduling affordance remains after success', () => {
  it('after save, only view_schedule action remains — no plan_appointment', async () => {
    const job = makeJob({ id: 'nodup-1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'nodup-1', ...todayAt(9) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const queue = deriveActionQueue([job], [], [], scheduledJobIds)

    // No plan_appointment action anywhere in the queue
    const allItems = [
      ...queue.needsAction,
      ...queue.inProgress,
      ...queue.waiting,
      ...queue.comingUp,
    ]
    const dups = allItems.filter(
      (i) => i.job.id === 'nodup-1' && i.primaryAction?.id === 'plan_appointment',
    )
    expect(dups).toHaveLength(0)
  })

  it('work entry summary does not double-count scheduled booked jobs', async () => {
    const job = makeJob({ id: 'nodup-2', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'nodup-2', ...todayAt(10) })

    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const summary = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    // Should show as "terminiert", not as "wartet auf Terminplanung"
    expect(summary.subtitle).not.toContain('wartet auf Terminplanung')
    expect(summary.subtitle).toContain('terminiert')
  })

  it('save button does not remain visible: action transitions from direct to contextual', async () => {
    const job = makeJob({ id: 'nodup-3', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: direct action (plan_appointment)
    const before = deriveActionQueue([job], [], [])
    expect(before.comingUp[0]?.primaryAction?.actionType).toBe('direct')

    // After: contextual action (view_schedule)
    await performCanonicalScheduleSave({ jobId: 'nodup-3', ...todayAt(15) })
    const scheduledJobIds = new Set(getSchedules().map((s) => s.jobId))
    const after = deriveActionQueue([job], [], [], scheduledJobIds)
    expect(after.comingUp[0]?.primaryAction?.actionType).toBe('contextual')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. action queue cannot contradict Home / Today / Kalender after save
// ═══════════════════════════════════════════════════════════════════════════

describe('13. action queue truth agrees with Home/Kalender after save', () => {
  it('action queue and dashboard agree on scheduledJobIds after canonical save', async () => {
    const job = makeJob({ id: 'agree-1', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'agree-1', ...todayAt(9) })

    // Dashboard-style scheduledJobIds: schedules + calendarEntries with scheduled/in_progress
    const entries = getCalendarEntries()
    const dashboardScheduledJobIds = new Set([
      ...getSchedules().map((s) => s.jobId),
      ...entries.filter((e) => e.status === 'scheduled' || e.status === 'in_progress').map((e) => e.jobId),
    ])

    // Action queue uses the same dual-source derivation — both must agree
    const aqQueue = deriveActionQueue([job], [], [], dashboardScheduledJobIds)
    const item = aqQueue.comingUp.find((i) => i.job.id === 'agree-1')

    expect(item).toBeDefined()
    expect(item?.primaryAction?.id).toBe('view_schedule')
    expect(item?.primaryAction?.id).not.toBe('plan_appointment')
    expect(item?.phaseLabel).toBe('Geplant')
  })

  it('action queue does not show plan_appointment when only CalendarEntry truth exists', async () => {
    // Edge case: CalendarEntry is scheduled but no JobSchedule exists (e.g. data import edge case)
    // After the fix, the Action Queue must read CalendarEntry truth and suppress plan_appointment.
    const job = makeJob({ id: 'agree-2', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Manually set CalendarEntry to scheduled (as if the calendar was updated directly)
    // — this simulates the split-brain: Dashboard sees it, old Action Queue did not.
    const entry = getCalendarEntryByJobId('agree-2')!
    const { getCalendarRepository } = await import('../../src/lib/calendar')
    getCalendarRepository().replace({
      ...entry,
      status: 'scheduled',
      startsAtLabel: '09:00',
      endsAtLabel: '11:00',
    })

    // With calendar truth included, scheduledJobIds must contain the job
    const entries = getCalendarEntries()
    const scheduledJobIds = new Set([
      ...getSchedules().map((s) => s.jobId),
      ...entries.filter((e) => e.status === 'scheduled' || e.status === 'in_progress').map((e) => e.jobId),
    ])

    expect(scheduledJobIds.has('agree-2')).toBe(true)

    const queue = deriveActionQueue([job], [], [], scheduledJobIds)
    const item = queue.comingUp.find((i) => i.job.id === 'agree-2')

    expect(item?.primaryAction?.id).not.toBe('plan_appointment')
    expect(item?.primaryAction?.id).toBe('view_schedule')
  })

  it('action queue and Home work entry agree: both use dual-source scheduledJobIds', async () => {
    const job = makeJob({ id: 'agree-3', status: 'booked', assignedMemberIds: ['w1'] })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    await performCanonicalScheduleSave({ jobId: 'agree-3', ...todayAt(11) })

    const entries = getCalendarEntries()
    const scheduledJobIds = new Set([
      ...getSchedules().map((s) => s.jobId),
      ...entries.filter((e) => e.status === 'scheduled' || e.status === 'in_progress').map((e) => e.jobId),
    ])

    // Both action queue and work entry summary must reflect schedule truth
    const queue = deriveActionQueue([job], [], [], scheduledJobIds)
    const summary = deriveWorkEntrySummary([job], [], [], scheduledJobIds)

    const queueItem = queue.comingUp.find((i) => i.job.id === 'agree-3')
    expect(queueItem?.primaryAction?.id).toBe('view_schedule')
    expect(summary.subtitle).not.toContain('wartet auf Terminplanung')
    expect(summary.subtitle).toContain('terminiert')
  })

  it('unified jobs screen source uses calendar entries in scheduledJobIds derivation', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanJobsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Must subscribe to calendar store
    expect(source).toContain('subscribeCalendar')
    expect(source).toContain('setCalendarEntries(getCalendarEntries())')
    // Must include calendar entries in scheduledJobIds (status-filtered)
    expect(source).toContain("e.status === 'scheduled' || e.status === 'in_progress'")
    // Must use same dual-source pattern as Dashboard
    expect(source).toContain('calendarEntries')
    expect(source).toContain('schedules.map((s) => s.jobId)')
  })
})
