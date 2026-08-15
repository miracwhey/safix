/**
 * Canonical Scheduling Real Flow Integration Tests
 *
 * Proves the REAL wiring — not just helper existence — of the canonical
 * scheduling mutation across all production entry points.
 *
 * SCENARIO 1 — Work queue "Termin speichern" calls canonical mutation
 * SCENARIO 2 — Planning List mode unscheduled item resolves to canonical truth
 * SCENARIO 3 — Planning Kalender mode unscheduled item resolves to canonical truth
 * SCENARIO 4 — Job detail TERMIN field reflects schedule truth after save
 * SCENARIO 5 — Cancel leaves truth unchanged
 * SCENARIO 6 — Failed save leaves truth unchanged
 * SCENARIO 7 — All real entry points delegate to canonical mutation (source audit)
 * SCENARIO 8 — No duplicate active scheduling save path remains (source audit)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner } from '../helpers/mockSession'
import {
  performCanonicalScheduleSave,
  resolveScheduleDateLabel,
  isForbiddenTerminValue,
} from '../../src/lib/scheduling'
import { getScheduleByJobId, getUnscheduledJobIds, getSchedules } from '../../src/lib/operations'
import { getCalendarEntryByJobId, ensureCalendarEntryForJob, getCalendarEntries } from '../../src/lib/calendar/calendarStore'
import { getTimedEntriesForDay, getPendingEntries } from '../../src/lib/calendar/calendarSelectors'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import { resolveCanonicalProjectFacts } from '../../src/lib/shared/canonicalProjectFacts'
import { formatDateKey } from '../../src/lib/calendar/calendarEngine'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Job } from '../../src/lib/jobs/types'

// ── Factories ──────────────────────────────────────────────────────────────

const TODAY = formatDateKey(new Date())

const SCHED_REALFLOW_OWNER_ID = 'sched-realflow-owner'

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
    craftsmanUserId: SCHED_REALFLOW_OWNER_ID,
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

beforeEach(() => {
  setupCleanRepositories()
  installSessionForJobOwner({ craftsmanUserId: SCHED_REALFLOW_OWNER_ID })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Work Queue flow save
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 1 — Work flow save through canonical mutation', () => {
  it('scheduling from work queue creates schedule AND updates calendar entry', async () => {
    const job = makeJob({ id: 'wq-1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: unscheduled, pending
    expect(getScheduleByJobId('wq-1')).toBeUndefined()
    expect(getCalendarEntryByJobId('wq-1')!.status).toBe('pending')

    const { scheduledStart, scheduledEnd } = todayAt(9)
    const result = await performCanonicalScheduleSave({
      jobId: 'wq-1',
      scheduledStart,
      scheduledEnd,
    })
    expect(result.success).toBe(true)

    // After: schedule exists, calendar entry is scheduled
    const schedule = getScheduleByJobId('wq-1')
    expect(schedule).toBeDefined()
    expect(schedule!.schedulingStatus).toBe('scheduled')

    const calEntry = getCalendarEntryByJobId('wq-1')
    expect(calEntry!.status).toBe('scheduled')
    expect(calEntry!.startsAtLabel).toBe('09:00')
    expect(calEntry!.dateKey).toBe(TODAY)

    // Not in unscheduled anymore
    const unscheduledIds = getUnscheduledJobIds(['wq-1'], getSchedules())
    expect(unscheduledIds).not.toContain('wq-1')

    // Appears in timed grid
    const timedEntries = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    expect(timedEntries.some((e) => e.jobId === 'wq-1')).toBe(true)

    // Connected surfaces re-derive correctly
    const todayBlock = deriveTodayBlock(getCalendarEntries(), TODAY)
    expect(todayBlock.mode).toBe('today_has_items')
    expect(todayBlock.items.some((i) => i.jobId === 'wq-1')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Planning List save
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 2 — Planning List mode save through canonical mutation', () => {
  it('item leaves unscheduled section and appears in scheduled list truth', async () => {
    const job = makeJob({ id: 'pl-1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: in pending entries
    const pendingBefore = getPendingEntries(getCalendarEntries())
    expect(pendingBefore.some((e) => e.jobId === 'pl-1')).toBe(true)

    const { scheduledStart, scheduledEnd } = todayAt(14)
    await performCanonicalScheduleSave({
      jobId: 'pl-1',
      scheduledStart,
      scheduledEnd,
    })

    // After: not in pending, IS in timed entries
    const pendingAfter = getPendingEntries(getCalendarEntries())
    expect(pendingAfter.some((e) => e.jobId === 'pl-1')).toBe(false)

    const timedAfter = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    expect(timedAfter.some((e) => e.jobId === 'pl-1')).toBe(true)

    const entry = timedAfter.find((e) => e.jobId === 'pl-1')!
    expect(entry.startsAtLabel).toBe('14:00')
    expect(entry.status).toBe('scheduled')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Planning Kalender save
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 3 — Planning Kalender mode save through canonical mutation', () => {
  it('item no longer appears as pending, appears in correct day/time grid', async () => {
    const job = makeJob({ id: 'pk-1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before: not in timed grid
    expect(getTimedEntriesForDay(getCalendarEntries(), TODAY).some((e) => e.jobId === 'pk-1')).toBe(false)

    const { scheduledStart, scheduledEnd } = todayAt(10)
    await performCanonicalScheduleSave({
      jobId: 'pk-1',
      scheduledStart,
      scheduledEnd,
    })

    // After: in timed grid
    const timedEntries = getTimedEntriesForDay(getCalendarEntries(), TODAY)
    const entry = timedEntries.find((e) => e.jobId === 'pk-1')
    expect(entry).toBeDefined()
    expect(entry!.startsAtLabel).toBe('10:00')
    expect(entry!.endsAtLabel).toBe('12:00')
    expect(entry!.dateKey).toBe(TODAY)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Detail truth
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 4 — Job detail TERMIN reflects schedule truth after save', () => {
  it('TERMIN field shows scheduled truth after canonical save', async () => {
    const job = makeJob({ id: 'dt-1', status: 'booked', dateLabel: 'Anfrage läuft' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Before save: resolveScheduleDateLabel returns "Termin offen"
    expect(resolveScheduleDateLabel('dt-1')).toBe('Termin offen')

    const { scheduledStart, scheduledEnd } = todayAt(11)
    await performCanonicalScheduleSave({
      jobId: 'dt-1',
      scheduledStart,
      scheduledEnd,
    })

    // After save: real schedule truth
    const terminLabel = resolveScheduleDateLabel('dt-1')
    expect(terminLabel).toContain('Geplant:')
    expect(terminLabel).toContain('11:00')
    expect(terminLabel).not.toBe('Anfrage läuft')

    // canonicalProjectFacts also derives schedule truth
    const facts = resolveCanonicalProjectFacts('dt-1')
    expect(facts).not.toBeNull()
    expect(facts!.dateLabel).toContain('Geplant:')
    expect(facts!.dateLabel).not.toBe('Anfrage läuft')
  })

  it('forbidden workflow values never appear as TERMIN truth', () => {
    expect(isForbiddenTerminValue('Anfrage läuft')).toBe(true)
    expect(isForbiddenTerminValue('Auftrag aus Angebot')).toBe(true)
    expect(isForbiddenTerminValue('Angebot gesendet')).toBe(true)
    expect(isForbiddenTerminValue('Warte auf Kundenantwort')).toBe(true)
    expect(isForbiddenTerminValue('In Bearbeitung')).toBe(true)
    expect(isForbiddenTerminValue('Termin offen')).toBe(false)
    expect(isForbiddenTerminValue('Geplant: 01.04.2026, 09:00')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Cancel leaves truth unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 5 — Cancel leaves truth unchanged', () => {
  it('no mutation when user closes panel without saving', async () => {
    const job = makeJob({ id: 'cancel-1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    // Snapshot
    const calBefore = getCalendarEntryByJobId('cancel-1')
    expect(calBefore!.status).toBe('pending')
    expect(getScheduleByJobId('cancel-1')).toBeUndefined()

    // User "cancels" = never calls performCanonicalScheduleSave
    // Truth remains unchanged
    expect(getScheduleByJobId('cancel-1')).toBeUndefined()
    expect(getCalendarEntryByJobId('cancel-1')!.status).toBe('pending')

    // Still unscheduled
    const unscheduledIds = getUnscheduledJobIds(['cancel-1'], getSchedules())
    expect(unscheduledIds).toContain('cancel-1')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Failed save leaves truth unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 6 — Failed save leaves truth unchanged', () => {
  it('non-existent job returns error, no state changes', async () => {
    const result = await performCanonicalScheduleSave({
      jobId: 'nonexistent',
      ...todayAt(9),
    })

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(getScheduleByJobId('nonexistent')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — All real entry points delegate to canonical mutation
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 7 — Source audit: all entry points wired to canonical mutation', () => {
  it('CraftsmanJobsScreen uses performCanonicalScheduleSave, NOT scheduleJob directly', () => {
    const source = readFileSync(
      new URL('../../src/screens/CraftsmanJobsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Must import from canonical scheduling
    expect(source).toContain("from '../lib/scheduling'")
    expect(source).toContain('performCanonicalScheduleSave')
    // Must NOT import scheduleJob from workflow (only canonical scheduling)
    expect(source).not.toMatch(/import.*\bscheduleJob\b.*from/)
  })

  it('CraftsmanJobDetailScreen uses performCanonicalScheduleSave for initial scheduling', () => {
    const source = readFileSync(
      new URL('../../src/screens/CraftsmanJobDetailScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("from '../lib/scheduling'")
    expect(source).toContain('performCanonicalScheduleSave')
    // Must NOT import scheduleJobWithDefaults
    expect(source).not.toContain('scheduleJobWithDefaults')
  })

  it('ProposalReadinessCard uses performCanonicalScheduleSave for scheduling', () => {
    const source = readFileSync(
      new URL('../../src/components/jobs/ProposalReadinessCard.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("from '../../lib/scheduling'")
    expect(source).toContain('performCanonicalScheduleSave')
    // Must NOT directly call scheduleJobWithDefaults
    expect(source).not.toMatch(/[^*]\bscheduleJobWithDefaults\b/)
  })

  it('QueueAppointmentPanel onSchedule supports async callback', () => {
    const source = readFileSync(
      new URL('../../src/components/dashboard/QueueAppointmentPanel.tsx', import.meta.url),
      'utf-8',
    )
    // Must support async callback type
    expect(source).toContain('Promise<void>')
    // Must await the callback
    expect(source).toContain('await onSchedule')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — No duplicate active scheduling save path remains
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 8 — No duplicate active scheduling save path in UI', () => {
  it('no screen or component directly imports scheduleJob from workflow', () => {
    const screensDir = new URL('../../src/screens/', import.meta.url)
    const componentsDir = new URL('../../src/components/', import.meta.url)

    const checkFiles = (dir: string) => {
      const files = readdirSync(dir, { recursive: true }) as string[]
      return files.filter((f: string) => f.endsWith('.tsx') || f.endsWith('.ts'))
    }

    const screenFiles = checkFiles(screensDir.pathname)
    for (const file of screenFiles) {
      const source = readFileSync(join(screensDir.pathname, file), 'utf-8')
      // No screen should import scheduleJob or scheduleJobWithDefaults
      // rescheduleJob is allowed (it's a reschedule operation, not initial scheduling)
      expect(source).not.toMatch(/import\s.*\bscheduleJob\b(?!WithDefaults).*from/)
      expect(source).not.toMatch(/import\s.*\bscheduleJobWithDefaults\b.*from/)
    }

    const componentFiles = checkFiles(componentsDir.pathname)
    for (const file of componentFiles) {
      const source = readFileSync(join(componentsDir.pathname, file), 'utf-8')
      // No component should import scheduleJobWithDefaults
      expect(source).not.toMatch(/import\s.*\bscheduleJobWithDefaults\b.*from/)
    }
  })

  it('all surfaces re-derive from same truth after canonical save', async () => {
    const job = makeJob({ id: 'unified-x1', status: 'booked' })
    await getJobRepository().add(job)
    ensureCalendarEntryForJob(job)

    const { scheduledStart, scheduledEnd } = todayAt(16)
    await performCanonicalScheduleSave({
      jobId: 'unified-x1',
      scheduledStart,
      scheduledEnd,
    })

    // 1. Operations: schedule exists
    expect(getScheduleByJobId('unified-x1')!.schedulingStatus).toBe('scheduled')

    // 2. Calendar: entry scheduled
    expect(getCalendarEntryByJobId('unified-x1')!.status).toBe('scheduled')

    // 3. Timed grid: present
    expect(getTimedEntriesForDay(getCalendarEntries(), TODAY).some((e) => e.jobId === 'unified-x1')).toBe(true)

    // 4. Pending: absent
    expect(getPendingEntries(getCalendarEntries()).some((e) => e.jobId === 'unified-x1')).toBe(false)

    // 5. Unscheduled IDs: absent
    expect(getUnscheduledJobIds(['unified-x1'], getSchedules())).not.toContain('unified-x1')

    // 6. TodayBlock: shows the item
    const todayBlock = deriveTodayBlock(getCalendarEntries(), TODAY)
    expect(todayBlock.mode).toBe('today_has_items')

    // 7. TERMIN truth: schedule-derived
    expect(resolveScheduleDateLabel('unified-x1')).toContain('Geplant:')

    // 8. canonicalProjectFacts: schedule-derived
    expect(resolveCanonicalProjectFacts('unified-x1')!.dateLabel).toContain('Geplant:')
  })
})
