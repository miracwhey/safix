/**
 * Block 7 / Sub-block 7.3 — Queue-Sortierung + Schedule-Proximity-Badges
 *
 * Tests the coming_up enrichment and sorting layer:
 *   A. Sortierung     — comingUp is sorted by dateKey ascending, unknown-date last
 *   B. Badge-Ableitung — imminent/soon/later thresholds and boundary cases
 *   C. Days-until     — correct computation for future dates
 *   D. No-date safety — items without schedule date get no badge, sort last
 *   E. Regression     — other groups unchanged; disputes still override
 */

import { describe, it, expect } from 'vitest'
import { deriveActionQueue } from '../../src/lib/dashboard/actionQueueSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Dispute } from '../../src/lib/disputes/types'

// ── Factories ─────────────────────────────────────────────────────────────────

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
    description: 'Test',
    paymentState: undefined,
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  } as Job
}

function makeDispute(jobId: string, status: Dispute['status'] = 'open'): Dispute {
  return {
    id: `dispute-${Math.random().toString(36).slice(2, 8)}`,
    jobId,
    status,
    reason: 'work_quality',
    title: 'Streitfall',
    description: 'Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Creates a fixed `nowMs` from a dateKey string ('YYYY-MM-DD').
 * Sets it to noon on that day to avoid midnight-boundary ambiguity.
 */
function noonMs(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0).getTime()
}

// ── A. Sortierung ─────────────────────────────────────────────────────────────

describe('A. comingUp-Sortierung — deterministisch nach Termin-Nähe', () => {
  it('sortiert drei Jobs aufsteigend nach dateKey', () => {
    const jobA = makeJob({ id: 'ja', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobB = makeJob({ id: 'jb', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobC = makeJob({ id: 'jc', status: 'scheduled', assignedMemberIds: ['w1'] })

    const schedDates = new Map([
      ['ja', '2026-04-20'],
      ['jb', '2026-04-10'],
      ['jc', '2026-04-15'],
    ])

    // Pass in reverse input order to confirm sort is not insertion-order
    const result = deriveActionQueue(
      [jobA, jobC, jobB],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.comingUp).toHaveLength(3)
    expect(result.comingUp[0].job.id).toBe('jb') // 2026-04-10 earliest
    expect(result.comingUp[1].job.id).toBe('jc') // 2026-04-15
    expect(result.comingUp[2].job.id).toBe('ja') // 2026-04-20
  })

  it('frühester Termin landet an erster Stelle', () => {
    const jobNear = makeJob({ id: 'near', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobFar = makeJob({ id: 'far', status: 'scheduled', assignedMemberIds: ['w1'] })

    const schedDates = new Map([
      ['near', '2026-04-05'],
      ['far', '2026-04-30'],
    ])

    const result = deriveActionQueue(
      [jobFar, jobNear], // far first in input
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.comingUp[0].job.id).toBe('near')
    expect(result.comingUp[1].job.id).toBe('far')
  })

  it('Jobs ohne dateKey landen nach Jobs mit dateKey', () => {
    const jobWithDate = makeJob({ id: 'dated', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobNoDate = makeJob({ id: 'nodated', status: 'scheduled', assignedMemberIds: ['w1'] })

    const schedDates = new Map([
      ['dated', '2026-04-10'],
      // 'nodated' intentionally absent
    ])

    const result = deriveActionQueue(
      [jobNoDate, jobWithDate], // no-date first in input
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.comingUp[0].job.id).toBe('dated')
    expect(result.comingUp[1].job.id).toBe('nodated')
  })

  it('Sortierung bleibt stabil bei nur einem Job', () => {
    const job = makeJob({ id: 'solo', status: 'scheduled', assignedMemberIds: ['w1'] })
    const schedDates = new Map([['solo', '2026-04-10']])

    const result = deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.comingUp).toHaveLength(1)
    expect(result.comingUp[0].job.id).toBe('solo')
  })

  it('leere comingUp — kein Fehler', () => {
    const result = deriveActionQueue(
      [],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
      noonMs('2026-04-04'),
    )
    expect(result.comingUp).toHaveLength(0)
  })
})

// ── B. Badge-Ableitung ────────────────────────────────────────────────────────

describe('B. scheduleProximity-Ableitung — imminent / soon / later', () => {
  function singleScheduledJob(dateKey: string, nowDate: string) {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const schedDates = new Map([['j1', dateKey]])
    return deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs(nowDate),
    ).comingUp[0]
  }

  it('today → imminent (daysUntil = 0)', () => {
    const item = singleScheduledJob('2026-04-04', '2026-04-04')
    expect(item.scheduleProximity).toBe('imminent')
  })

  it('tomorrow → imminent (daysUntil = 1)', () => {
    const item = singleScheduledJob('2026-04-05', '2026-04-04')
    expect(item.scheduleProximity).toBe('imminent')
  })

  it('2 days → soon (boundary: daysUntil = 2)', () => {
    const item = singleScheduledJob('2026-04-06', '2026-04-04')
    expect(item.scheduleProximity).toBe('soon')
  })

  it('7 days → soon (boundary: daysUntil = 7)', () => {
    const item = singleScheduledJob('2026-04-11', '2026-04-04')
    expect(item.scheduleProximity).toBe('soon')
  })

  it('8 days → later (boundary: daysUntil = 8)', () => {
    const item = singleScheduledJob('2026-04-12', '2026-04-04')
    expect(item.scheduleProximity).toBe('later')
  })

  it('30 days → later', () => {
    const item = singleScheduledJob('2026-05-04', '2026-04-04')
    expect(item.scheduleProximity).toBe('later')
  })

  it('past date (not in overdueIds) → imminent (clamped daysUntil = 0)', () => {
    const item = singleScheduledJob('2026-04-01', '2026-04-04')
    expect(item.scheduleProximity).toBe('imminent')
    expect(item.daysUntil).toBe(0)
  })

  it('Job ohne schedDates-Eintrag → kein scheduleProximity', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    // no entry in schedDates
    const result = deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
      noonMs('2026-04-04'),
    )
    expect(result.comingUp[0].scheduleProximity).toBeUndefined()
    expect(result.comingUp[0].daysUntil).toBeUndefined()
  })
})

// ── C. Days-until / Zeitnähe ──────────────────────────────────────────────────

describe('C. daysUntil — korrekte Berechnung', () => {
  function getDaysUntil(dateKey: string, nowDate: string): number | undefined {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const schedDates = new Map([['j1', dateKey]])
    return deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs(nowDate),
    ).comingUp[0].daysUntil
  }

  it('daysUntil = 0 wenn Termin heute', () => {
    expect(getDaysUntil('2026-04-04', '2026-04-04')).toBe(0)
  })

  it('daysUntil = 1 für morgen', () => {
    expect(getDaysUntil('2026-04-05', '2026-04-04')).toBe(1)
  })

  it('daysUntil = 7 für eine Woche', () => {
    expect(getDaysUntil('2026-04-11', '2026-04-04')).toBe(7)
  })

  it('daysUntil = 30 für einen Monat', () => {
    expect(getDaysUntil('2026-05-04', '2026-04-04')).toBe(30)
  })

  it('daysUntil ist nicht negativ bei Vergangenheitsdatum', () => {
    const days = getDaysUntil('2026-03-01', '2026-04-04')
    expect(days).toBe(0)
  })

  it('daysUntil undefined wenn kein schedDates-Eintrag vorhanden', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
      noonMs('2026-04-04'),
    )
    expect(result.comingUp[0].daysUntil).toBeUndefined()
  })
})

// ── D. No-date safety ─────────────────────────────────────────────────────────

describe('D. Jobs ohne Termin-Datum — kein Fehler, sortieren zuletzt', () => {
  it('booked-Jobs ohne dateKey-Eintrag landen in comingUp ohne Proximity', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })

    const result = deriveActionQueue(
      [job],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(), // no schedule date
      noonMs('2026-04-04'),
    )

    expect(result.comingUp).toHaveLength(1)
    expect(result.comingUp[0].scheduleProximity).toBeUndefined()
    expect(result.comingUp[0].daysUntil).toBeUndefined()
  })

  it('Mix: Job mit Termin + Job ohne Termin → datierter zuerst, undatierter zuletzt', () => {
    const jobDated = makeJob({ id: 'dated', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobUndated = makeJob({ id: 'undated', status: 'booked', assignedMemberIds: ['w1'] })

    const schedDates = new Map([['dated', '2026-04-20']])

    const result = deriveActionQueue(
      [jobUndated, jobDated], // undated first in input
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.comingUp).toHaveLength(2)
    expect(result.comingUp[0].job.id).toBe('dated')
    expect(result.comingUp[1].job.id).toBe('undated')
  })

  it('kein comingUpScheduleDates-Argument → keine Proximity, Reihenfolge = Einfügereihenfolge', () => {
    const jobA = makeJob({ id: 'ja', status: 'scheduled', assignedMemberIds: ['w1'] })
    const jobB = makeJob({ id: 'jb', status: 'scheduled', assignedMemberIds: ['w1'] })

    // No comingUpScheduleDates passed at all
    const result = deriveActionQueue([jobA, jobB], [], [])

    expect(result.comingUp).toHaveLength(2)
    expect(result.comingUp[0].scheduleProximity).toBeUndefined()
    expect(result.comingUp[1].scheduleProximity).toBeUndefined()
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — andere Gruppen bleiben unverändert', () => {
  it('needs_action, waiting, in_progress werden nicht durch Proximity-Logik berührt', () => {
    const newJob = makeJob({ id: 'new', status: 'new' })
    const inProgressJob = makeJob({ id: 'ip', status: 'in_progress', assignedMemberIds: ['w1'] })
    const waitingJob = makeJob({ id: 'wp', status: 'waiting_payment', assignedMemberIds: ['w1'] })
    const scheduledJob = makeJob({ id: 'sched', status: 'scheduled', assignedMemberIds: ['w1'] })

    const schedDates = new Map([['sched', '2026-05-01']])

    const result = deriveActionQueue(
      [newJob, inProgressJob, waitingJob, scheduledJob],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].job.id).toBe('new')

    expect(result.inProgress).toHaveLength(1)
    expect(result.inProgress[0].job.id).toBe('ip')

    expect(result.waiting).toHaveLength(1)
    expect(result.waiting[0].job.id).toBe('wp')

    expect(result.comingUp).toHaveLength(1)
    expect(result.comingUp[0].job.id).toBe('sched')
    expect(result.comingUp[0].scheduleProximity).toBe('later')
    expect(result.comingUp[0].daysUntil).toBe(27)

    // Non-comingUp items have no proximity fields
    expect(result.needsAction[0].scheduleProximity).toBeUndefined()
    expect(result.inProgress[0].scheduleProximity).toBeUndefined()
    expect(result.waiting[0].scheduleProximity).toBeUndefined()
  })

  it('Dispute überschreibt weiterhin coming_up-Klassifikation', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1')
    const schedDates = new Map([['j1', '2026-04-06']])

    const result = deriveActionQueue(
      [job],
      [dispute],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.needsAction).toHaveLength(1)
    expect(result.comingUp).toHaveLength(0)
    expect(result.needsAction[0].hasDispute).toBe(true)
    // Dispute items don't get proximity fields
    expect(result.needsAction[0].scheduleProximity).toBeUndefined()
  })

  it('needs_action-Reihenfolge bleibt durch 7.2-Sortierung geregelt', () => {
    const disputeJob = makeJob({ id: 'dispute', status: 'scheduled', assignedMemberIds: ['w1'] })
    const overdueJob = makeJob({ id: 'overdue', status: 'scheduled', assignedMemberIds: ['w1'] })
    const newReqJob = makeJob({ id: 'newreq', status: 'new' })

    const dispute = makeDispute('dispute')
    const overdueIds = new Set(['overdue'])

    const result = deriveActionQueue(
      [newReqJob, overdueJob, disputeJob],
      [dispute],
      [],
      undefined,
      undefined,
      overdueIds,
      undefined,
      undefined,
      new Map(),
      noonMs('2026-04-04'),
    )

    expect(result.needsAction).toHaveLength(3)
    expect(result.needsAction[0].job.id).toBe('dispute')   // disputes first
    expect(result.needsAction[1].job.id).toBe('overdue')   // overdue second
    expect(result.needsAction[2].job.id).toBe('newreq')    // new request last
  })

  it('totalItems bleibt korrekt über alle Gruppen', () => {
    const jobs = [
      makeJob({ id: 'a', status: 'new' }),
      makeJob({ id: 'b', status: 'in_progress', assignedMemberIds: ['w1'] }),
      makeJob({ id: 'c', status: 'waiting_payment', assignedMemberIds: ['w1'] }),
      makeJob({ id: 'd', status: 'scheduled', assignedMemberIds: ['w1'] }),
    ]

    const schedDates = new Map([['d', '2026-04-10']])
    const result = deriveActionQueue(
      jobs,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      schedDates,
      noonMs('2026-04-04'),
    )

    expect(result.totalItems).toBe(4)
  })
})
