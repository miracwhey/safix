import { describe, it, expect } from 'vitest'
import { deriveOperatorPriorityCases } from '../../src/lib/jobs/operatorPrioritySelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

const NOW = 1_700_000_000_000
const DAY = 1000 * 60 * 60 * 24

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Badrenovierung',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'in_progress',
    amount: '2.500 €',
    description: 'Anfrage',
    paymentState: 'in_escrow',
    documentationStatus: '—',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    jobId: 'job-1',
    state: 'in_escrow',
    amounts: { totalAmount: 1000, depositAmount: 500, finalAmount: 500 },
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    ...overrides,
  }
}

describe('deriveOperatorPriorityCases — Worker-Mark-Visibility (Block 7.2.1g)', () => {
  it('flags HIGH when Worker marked complete >7d ago and Admin never confirmed (in_progress)', () => {
    const job = makeJob({
      status: 'in_progress',
      workMarkedCompleteAt: NOW - 8 * DAY,
      // workConfirmedCompleteAt absent
    })
    const payment = makePayment({ state: 'in_escrow', updatedAt: NOW - 30 * DAY })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({
      jobId: 'job-1',
      type: 'stale_payment',
      severity: 'high',
    })
  })

  it('does NOT flag when Worker marked complete <7d ago (countdown still running)', () => {
    const job = makeJob({
      status: 'in_progress',
      workMarkedCompleteAt: NOW - 6 * DAY,
    })
    const payment = makePayment({ state: 'in_escrow', updatedAt: NOW - 30 * DAY })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(0)
  })

  it('flags HIGH when Admin confirmed >7d ago, status waiting_payment (existing behavior)', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workMarkedCompleteAt: NOW - 10 * DAY,
      workConfirmedCompleteAt: NOW - 8 * DAY,
      workCompletedAt: NOW - 8 * DAY,
    })
    const payment = makePayment({ state: 'in_escrow' })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(1)
    expect(cases[0].severity).toBe('high')
  })

  it('uses workMarkedCompleteAt (earliest) as primary signal — fires earlier than workConfirmedCompleteAt would', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workMarkedCompleteAt: NOW - 8 * DAY,         // 8d → fires
      workConfirmedCompleteAt: NOW - 5 * DAY,      // 5d → would NOT fire alone
      workCompletedAt: NOW - 5 * DAY,
    })
    const payment = makePayment({ state: 'in_escrow' })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(1)
  })

  it('does NOT flag in_progress without any completion stamp (active job, not stuck)', () => {
    const job = makeJob({
      status: 'in_progress',
      // no completion stamps
    })
    const payment = makePayment({ state: 'in_escrow', updatedAt: NOW - 30 * DAY })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(0)
  })

  it('falls back to workCompletedAt (legacy alias) when neither marked nor confirmed stamps present', () => {
    const job = makeJob({
      status: 'completed',
      workCompletedAt: NOW - 8 * DAY,
    })
    const payment = makePayment({ state: 'in_escrow' })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    expect(cases).toHaveLength(1)
    expect(cases[0].severity).toBe('high')
  })
})

describe('deriveOperatorPriorityCases — release_pending semantic preserved', () => {
  it('flags MEDIUM when release_pending stuck >2d using workConfirmedCompleteAt', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workConfirmedCompleteAt: NOW - 3 * DAY,
    })
    const payment = makePayment({ state: 'release_pending', updatedAt: NOW - 1 * DAY })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    const releasePending = cases.filter((c) => c.label.startsWith('Release Pending'))
    expect(releasePending).toHaveLength(1)
    expect(releasePending[0].severity).toBe('medium')
  })

  it('release_pending ignores workMarkedCompleteAt (predates customer release)', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workMarkedCompleteAt: NOW - 10 * DAY,    // would fire if used
      workConfirmedCompleteAt: NOW - 1 * DAY,  // 1d → does NOT fire
    })
    const payment = makePayment({ state: 'release_pending', updatedAt: NOW - 1 * DAY })

    const cases = deriveOperatorPriorityCases([job], [payment], [], NOW)

    const releasePending = cases.filter((c) => c.label.startsWith('Release Pending'))
    expect(releasePending).toHaveLength(0)
  })
})

describe('deriveOperatorPriorityCases — unrelated case-types unchanged', () => {
  it('flags HIGH for active disputes', () => {
    const job = makeJob({ status: 'in_progress' })
    const dispute: Dispute = {
      id: 'd1',
      jobId: 'job-1',
      paymentId: 'pay-1',
      status: 'open',
      createdAt: NOW - 1 * DAY,
      updatedAt: NOW - 1 * DAY,
    } as Dispute

    const cases = deriveOperatorPriorityCases([job], [], [dispute], NOW)

    expect(cases.find((c) => c.type === 'dispute')?.severity).toBe('high')
  })

  it('flags MEDIUM for jobs stuck in scheduled >3d since proposal acceptance', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 4 * DAY,
    })

    const cases = deriveOperatorPriorityCases([job], [], [], NOW)

    expect(cases.find((c) => c.type === 'stuck_job')?.severity).toBe('medium')
  })

  it('sorts high before medium', () => {
    const disputeJob = makeJob({ id: 'job-d', status: 'in_progress' })
    const stuckJob = makeJob({ id: 'job-s', status: 'scheduled', proposalAcceptedAt: NOW - 4 * DAY })
    const dispute: Dispute = {
      id: 'd1',
      jobId: 'job-d',
      paymentId: 'pay-d',
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
    } as Dispute

    const cases = deriveOperatorPriorityCases([disputeJob, stuckJob], [], [dispute], NOW)

    expect(cases[0].severity).toBe('high')
    expect(cases[1].severity).toBe('medium')
  })
})
