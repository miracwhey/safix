/**
 * Block 7 / Sub-block 7.2 — Action Queue auf gehärtete Next-Action-Wahrheit umstellen
 *
 * Tests the three alignment areas between the queue and 7.1 truth:
 *   A. Schedule-overdue — überfällige Jobs landen in needs_action, nicht coming_up
 *   B. Payout-setup-required — released + blocked landet in needs_action
 *   C. Funding-In-Progress — booked + funding in flight landet in waiting
 *   D. Dispute-Priorität — Disputes überschreiben weiterhin alles
 *   E. Regression — bestehende Queue-Klassifikation unverändert
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

// ── A. Schedule-overdue ───────────────────────────────────────────────────────

describe('A. Schedule-overdue — überfällige Jobs landen in needs_action', () => {
  it('scheduled + assigned + overdue → needs_action, not coming_up', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const overdueIds = new Set(['j1'])

    const result = deriveActionQueue([job], [], [], undefined, undefined, overdueIds)

    expect(result.needsAction).toHaveLength(1)
    expect(result.comingUp).toHaveLength(0)
    expect(result.needsAction[0].phaseLabel).toBe('Termin überfällig')
  })

  it('overdue job has "Ausführung starten oder Termin verschieben" nextStepLabel', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const overdueIds = new Set(['j1'])

    const result = deriveActionQueue([job], [], [], undefined, undefined, overdueIds)

    expect(result.needsAction[0].nextStepLabel).toContain('Ausführung')
  })

  it('overdue job has contextual open_job action', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const overdueIds = new Set(['j1'])

    const result = deriveActionQueue([job], [], [], undefined, undefined, overdueIds)

    expect(result.needsAction[0].primaryAction?.id).toBe('open_job')
    expect(result.needsAction[0].primaryAction?.actionType).toBe('contextual')
  })

  it('non-overdue scheduled + assigned stays in coming_up', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    // overdueScheduledJobIds is empty — job is not overdue

    const result = deriveActionQueue([job], [], [], undefined, undefined, new Set())

    expect(result.comingUp).toHaveLength(1)
    expect(result.needsAction).toHaveLength(0)
    expect(result.comingUp[0].phaseLabel).toBe('Geplant')
  })

  it('scheduled unassigned + overdue → still needs_action via assignment path (assignment takes same group)', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: [] })
    const overdueIds = new Set(['j1'])

    const result = deriveActionQueue([job], [], [job], undefined, undefined, overdueIds)

    // Unassigned check runs before overdue check — assignment is the primary bottleneck
    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Zuteilung nötig')
  })

  it('overdue scheduled + dispute → dispute wins, phaseLabel is Streitfall offen', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1', 'open')
    const overdueIds = new Set(['j1'])

    const result = deriveActionQueue([job], [dispute], [], undefined, undefined, overdueIds)

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
    expect(result.needsAction[0].hasDispute).toBe(true)
  })

  it('needs_action sort: dispute(0) > zuteilung(1) > overdue(2)', () => {
    const disputeJob = makeJob({ id: 'j-dispute', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j-dispute', 'open')
    const unassignedJob = makeJob({ id: 'j-unassigned', status: 'booked', assignedMemberIds: [] })
    const overdueJob = makeJob({ id: 'j-overdue', status: 'scheduled', assignedMemberIds: ['w1'] })

    const result = deriveActionQueue(
      [overdueJob, unassignedJob, disputeJob],
      [dispute],
      [unassignedJob],
      undefined,
      undefined,
      new Set(['j-overdue']),
    )

    const ids = result.needsAction.map((i) => i.job.id)
    expect(ids[0]).toBe('j-dispute')
    expect(ids[1]).toBe('j-unassigned')
    expect(ids[2]).toBe('j-overdue')
  })
})

// ── B. Payout-setup-required ──────────────────────────────────────────────────

describe('B. Payout-setup-required — released + blocked landet in needs_action', () => {
  it('completed job in payoutBlockedJobIds → included in queue as needs_action', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    const payoutBlockedIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, payoutBlockedIds
    )

    expect(result.needsAction).toHaveLength(1)
    expect(result.totalItems).toBe(1)
  })

  it('completed job in payoutBlockedJobIds → phaseLabel "Auszahlung einrichten"', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    const payoutBlockedIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, payoutBlockedIds
    )

    expect(result.needsAction[0].phaseLabel).toBe('Auszahlung einrichten')
  })

  it('completed job in payoutBlockedJobIds → view_payout_setup action', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    const payoutBlockedIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, payoutBlockedIds
    )

    expect(result.needsAction[0].primaryAction?.id).toBe('view_payout_setup')
    expect(result.needsAction[0].primaryAction?.actionType).toBe('contextual')
    expect(result.needsAction[0].primaryAction?.label).toContain('öffnen')
  })

  it('completed job NOT in payoutBlockedJobIds → excluded from queue', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    // Not in payoutBlockedJobIds

    const result = deriveActionQueue([job], [], [])

    expect(result.totalItems).toBe(0)
  })

  it('cancelled job in payoutBlockedJobIds → still excluded (cancelled is never shown)', () => {
    const job = makeJob({ id: 'j1', status: 'cancelled' })
    const payoutBlockedIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, payoutBlockedIds
    )

    expect(result.totalItems).toBe(0)
  })

  it('payout blocked job + active dispute → dispute wins', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    const dispute = makeDispute('j1', 'open')
    const payoutBlockedIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, undefined, payoutBlockedIds
    )

    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
    expect(result.needsAction[0].hasDispute).toBe(true)
  })

  it('needs_action sort: payout(3) sorts after overdue(2)', () => {
    const overdueJob = makeJob({ id: 'j-overdue', status: 'scheduled', assignedMemberIds: ['w1'] })
    const payoutJob = makeJob({ id: 'j-payout', status: 'completed', paymentState: 'released' })

    const result = deriveActionQueue(
      [payoutJob, overdueJob],
      [],
      [],
      undefined,
      undefined,
      new Set(['j-overdue']),
      new Set(['j-payout']),
    )

    const ids = result.needsAction.map((i) => i.job.id)
    expect(ids[0]).toBe('j-overdue')   // overdue first (urgency 2)
    expect(ids[1]).toBe('j-payout')    // payout second (urgency 3)
  })
})

// ── C. Funding-In-Progress ────────────────────────────────────────────────────

describe('C. Funding-In-Progress — booked assigned + funding in flight → waiting', () => {
  it('booked + assigned + fundingInProgressJobIds → waiting, not coming_up', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const fundingInProgressIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, undefined, fundingInProgressIds
    )

    expect(result.waiting).toHaveLength(1)
    expect(result.comingUp).toHaveLength(0)
    expect(result.waiting[0].phaseLabel).toBe('Zahlung wird verarbeitet')
  })

  it('booked + assigned + funding in progress → view_payment action', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const fundingInProgressIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, undefined, fundingInProgressIds
    )

    expect(result.waiting[0].primaryAction?.id).toBe('view_payment')
    expect(result.waiting[0].primaryAction?.actionType).toBe('contextual')
  })

  it('booked + assigned + funding in progress → nextStepLabel mentions waiting for confirmation', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const fundingInProgressIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [], undefined, undefined, undefined, undefined, fundingInProgressIds
    )

    expect(result.waiting[0].nextStepLabel).toContain('Bestätigung')
  })

  it('booked + assigned + NOT in fundingInProgressJobIds → coming_up (normal flow)', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })

    const result = deriveActionQueue([job], [], [])

    expect(result.comingUp).toHaveLength(1)
    expect(result.waiting).toHaveLength(0)
    expect(result.comingUp[0].phaseLabel).toBe('Termin offen')
  })

  it('booked + UNASSIGNED + fundingInProgressJobIds → still needs_action (assignment overrides)', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] })
    const fundingInProgressIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [], [job], undefined, undefined, undefined, undefined, fundingInProgressIds
    )

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Zuteilung nötig')
    expect(result.waiting).toHaveLength(0)
  })

  it('booked + funding in progress + dispute → dispute wins', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1', 'open')
    const fundingInProgressIds = new Set(['j1'])

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, undefined, undefined, fundingInProgressIds
    )

    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
    expect(result.waiting).toHaveLength(0)
  })
})

// ── D. Dispute-Priorität ──────────────────────────────────────────────────────

describe('D. Dispute-Priorität — Disputes überschreiben alle neuen Fälle', () => {
  it('overdue + dispute → dispute wins (open)', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1', 'open')

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, new Set(['j1'])
    )

    expect(result.needsAction[0].hasDispute).toBe(true)
    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
  })

  it('overdue + dispute under_review → dispute wins (under_review also active)', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1', 'under_review')

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, new Set(['j1'])
    )

    expect(result.needsAction[0].hasDispute).toBe(true)
  })

  it('payout blocked + dispute → dispute wins', () => {
    const job = makeJob({ id: 'j1', status: 'completed', paymentState: 'released' })
    const dispute = makeDispute('j1', 'open')

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, undefined, new Set(['j1'])
    )

    expect(result.needsAction[0].hasDispute).toBe(true)
    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
  })

  it('resolved dispute does NOT override overdue', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j1', 'resolved_release')

    const result = deriveActionQueue(
      [job], [dispute], [], undefined, undefined, new Set(['j1'])
    )

    // resolved dispute is not active → overdue logic applies
    expect(result.needsAction[0].phaseLabel).toBe('Termin überfällig')
    expect(result.needsAction[0].hasDispute).toBe(false)
  })

  it('all three new cases simultaneously with disputes: disputes sort first', () => {
    const disputeJob = makeJob({ id: 'j-d', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute('j-d', 'open')
    const overdueJob = makeJob({ id: 'j-o', status: 'scheduled', assignedMemberIds: ['w1'] })
    const payoutJob = makeJob({ id: 'j-p', status: 'completed', paymentState: 'released' })

    const result = deriveActionQueue(
      [overdueJob, payoutJob, disputeJob],
      [dispute],
      [],
      undefined,
      undefined,
      new Set(['j-o']),
      new Set(['j-p']),
    )

    expect(result.needsAction[0].job.id).toBe('j-d') // dispute first
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — bestehende Queue-Klassifikation unverändert', () => {
  it('new request (no proposal) → needs_action "Neue Anfrage"', () => {
    const job = makeJob({ status: 'new' })
    const result = deriveActionQueue([job], [], [])
    expect(result.needsAction[0].phaseLabel).toBe('Neue Anfrage')
  })

  it('new with proposal → waiting "Angebot gesendet"', () => {
    const job = makeJob({ status: 'new', proposalSentAt: Date.now() })
    const result = deriveActionQueue([job], [], [])
    expect(result.waiting[0].phaseLabel).toBe('Angebot gesendet')
  })

  it('in_progress → inProgress group', () => {
    const job = makeJob({ status: 'in_progress' })
    const result = deriveActionQueue([job], [], [])
    expect(result.inProgress).toHaveLength(1)
  })

  it('waiting_payment → waiting group', () => {
    const job = makeJob({ status: 'waiting_payment' })
    const result = deriveActionQueue([job], [], [])
    expect(result.waiting).toHaveLength(1)
    expect(result.waiting[0].phaseLabel).toBe('Warte auf Freigabe')
  })

  it('scheduled + assigned (not overdue) → coming_up "Geplant"', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveActionQueue([job], [], [])
    expect(result.comingUp[0].phaseLabel).toBe('Geplant')
  })

  it('completed (not in payoutBlocked) → excluded from queue', () => {
    const job = makeJob({ status: 'completed' })
    const result = deriveActionQueue([job], [], [])
    expect(result.totalItems).toBe(0)
  })

  it('cancelled → excluded from queue regardless of sets', () => {
    const job = makeJob({ id: 'j1', status: 'cancelled' })
    const result = deriveActionQueue(
      [job], [], [],
      new Set(['j1']),
      undefined,
      new Set(['j1']),
      new Set(['j1']),
      new Set(['j1']),
    )
    expect(result.totalItems).toBe(0)
  })

  it('future-scheduled job without dispute is excluded', () => {
    const job = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveActionQueue([job], [], [], undefined, new Set(['j1']))
    expect(result.totalItems).toBe(0)
  })

  it('new params default to empty sets (backwards compatible)', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    // Call with only the original 5 parameters
    const result = deriveActionQueue([job], [], [])
    expect(result.comingUp).toHaveLength(1)
    expect(result.totalItems).toBe(1)
  })

  it('all new Sets empty: no classification changes vs original behaviour', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'new' }),
      makeJob({ id: 'j2', status: 'in_progress' }),
      makeJob({ id: 'j3', status: 'waiting_payment' }),
      makeJob({ id: 'j4', status: 'scheduled', assignedMemberIds: ['w1'] }),
      makeJob({ id: 'j5', status: 'booked', assignedMemberIds: ['w2'] }),
    ]
    const result = deriveActionQueue(
      jobs, [], [],
      undefined, undefined,
      new Set(),  // no overdue
      new Set(),  // no payout blocked
      new Set(),  // no funding in progress
    )
    expect(result.needsAction).toHaveLength(1)   // j1
    expect(result.inProgress).toHaveLength(1)    // j2
    expect(result.waiting).toHaveLength(1)       // j3
    expect(result.comingUp).toHaveLength(2)      // j4, j5
    expect(result.totalItems).toBe(5)
  })
})
