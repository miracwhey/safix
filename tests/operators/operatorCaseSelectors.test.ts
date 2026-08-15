import { describe, it, expect } from 'vitest'
import {
  deriveOperatorCases,
} from '../../src/lib/operators/operatorCaseSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'
import type { JobSchedule } from '../../src/lib/operations/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000

const HOUR_MS = 1000 * 60 * 60

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Fliesen verlegen',
    customer: 'Erika Muster',
    location: 'Hamburg',
    dateLabel: 'Heute',
    status: 'new',
    amount: '1.500 €',
    description: 'Bad renovieren',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    jobId: 'job-1',
    state: 'in_escrow',
    amounts: { totalAmount: 1500, depositAmount: 300, finalAmount: 1200 },
    createdAt: NOW - 30 * HOUR_MS,
    updatedAt: NOW - 30 * HOUR_MS,
    ...overrides,
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-1',
    jobId: 'job-1',
    status: 'open',
    reason: 'work_quality',
    title: 'Schlechte Arbeit',
    description: 'Das Ergebnis entspricht nicht den Vereinbarungen.',
    createdAt: new Date(NOW - 10 * HOUR_MS).toISOString(),
    updatedAt: new Date(NOW - 10 * HOUR_MS).toISOString(),
    ...overrides,
  }
}

function makeSchedule(overrides: Partial<JobSchedule> = {}): JobSchedule {
  return {
    id: 'schedule-1',
    jobId: 'job-1',
    scheduledStart: NOW - 10 * HOUR_MS,
    scheduledEnd: NOW - 2 * HOUR_MS,
    executionWindow: 480,
    schedulingStatus: 'scheduled',
    createdAt: NOW - 12 * HOUR_MS,
    updatedAt: NOW - 12 * HOUR_MS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// stuck_inquiry
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – stuck_inquiry', () => {
  it('classifies a new job with no proposal as stuck_inquiry', () => {
    const job = makeJob({ status: 'new', proposalSentAt: undefined })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    const c = cases.find((x) => x.type === 'stuck_inquiry')
    expect(c).toBeDefined()
    expect(c!.jobId).toBe('job-1')
    expect(c!.severity).toBe('medium')
  })

  it('does not classify a job with a proposal already sent as stuck_inquiry', () => {
    const job = makeJob({ status: 'new', proposalSentAt: NOW - 10 * HOUR_MS })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'stuck_inquiry')).toBeUndefined()
  })

  it('does not classify a non-new job as stuck_inquiry', () => {
    const job = makeJob({ status: 'in_progress', proposalSentAt: undefined })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'stuck_inquiry')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// proposal_pending
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – proposal_pending', () => {
  it('classifies a proposal sent >48h ago with no acceptance as proposal_pending', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 50 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    const c = cases.find((x) => x.type === 'proposal_pending')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('medium')
    expect(c!.ageHours).toBe(50)
  })

  it('does not classify a proposal sent <48h ago as proposal_pending', () => {
    const job = makeJob({
      proposalSentAt: NOW - 40 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'proposal_pending')).toBeUndefined()
  })

  it('does not classify a proposal that has been accepted', () => {
    const job = makeJob({
      proposalSentAt: NOW - 50 * HOUR_MS,
      proposalAcceptedAt: NOW - 10 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'proposal_pending')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// scheduling_stuck
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – scheduling_stuck', () => {
  it('classifies a job with accepted proposal but no execution after 72h', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalSentAt: NOW - 80 * HOUR_MS,
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    const c = cases.find((x) => x.type === 'scheduling_stuck')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('medium')
    expect(c!.ageHours).toBe(80)
  })

  it('does not classify a scheduling_stuck case within 72h', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 60 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'scheduling_stuck')).toBeUndefined()
  })

  it('does not classify an in_progress job as scheduling_stuck', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'scheduling_stuck')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// execution_stuck
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – execution_stuck', () => {
  it('classifies an in_progress job with no signal for 72h as execution_stuck', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    const c = cases.find((x) => x.type === 'execution_stuck')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('high')
    expect(c!.ageHours).toBe(80)
  })

  it('does not classify an in_progress job with recent signal', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 50 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'execution_stuck')).toBeUndefined()
  })

  it('does not classify a non-in_progress job as execution_stuck', () => {
    const job = makeJob({
      status: 'waiting_payment',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'execution_stuck')).toBeUndefined()
  })

  it('does not classify execution_stuck when an overdue schedule is present (execution_overdue takes priority)', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const schedule = makeSchedule({ jobId: 'job-1', schedulingStatus: 'execution_started' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_stuck')).toBeUndefined()
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// execution_overdue
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – execution_overdue', () => {
  it('classifies a job with overdue schedule (never started) as critical', () => {
    const job = makeJob({ status: 'scheduled' })
    const schedule = makeSchedule({ jobId: 'job-1', schedulingStatus: 'scheduled' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    const c = cases.find((x) => x.type === 'execution_overdue')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('critical')
    expect(c!.jobId).toBe('job-1')
    expect(c!.ageHours).toBe(2)
  })

  it('classifies a job with overdue running schedule as high', () => {
    const job = makeJob({ status: 'in_progress' })
    const schedule = makeSchedule({ jobId: 'job-1', schedulingStatus: 'execution_started' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    const c = cases.find((x) => x.type === 'execution_overdue')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('high')
  })

  it('does not classify a completed job with overdue schedule', () => {
    const job = makeJob({ status: 'completed' })
    const schedule = makeSchedule({ jobId: 'job-1' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('does not classify a cancelled job with overdue schedule', () => {
    const job = makeJob({ status: 'cancelled' })
    const schedule = makeSchedule({ jobId: 'job-1' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('does not classify a waiting_payment job with overdue schedule', () => {
    const job = makeJob({ status: 'waiting_payment' })
    const schedule = makeSchedule({ jobId: 'job-1' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('does not classify when schedule is execution_completed', () => {
    const job = makeJob({ status: 'in_progress' })
    const schedule = makeSchedule({
      jobId: 'job-1',
      schedulingStatus: 'execution_completed',
    })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('does not classify when schedule is cancelled', () => {
    const job = makeJob({ status: 'scheduled' })
    const schedule = makeSchedule({
      jobId: 'job-1',
      schedulingStatus: 'cancelled',
    })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('does not classify when schedule end is still in the future', () => {
    const job = makeJob({ status: 'scheduled' })
    const schedule = makeSchedule({
      jobId: 'job-1',
      scheduledStart: NOW + HOUR_MS,
      scheduledEnd: NOW + 4 * HOUR_MS,
    })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })

  it('suppresses scheduling_stuck when overdue schedule is present', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const schedule = makeSchedule({ jobId: 'job-1', schedulingStatus: 'scheduled' })
    const cases = deriveOperatorCases([job], [], [], [schedule], NOW)
    expect(cases.find((x) => x.type === 'scheduling_stuck')).toBeUndefined()
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeDefined()
  })

  it('returns empty with empty schedules array', () => {
    const job = makeJob({ status: 'scheduled' })
    const cases = deriveOperatorCases([job], [], [], [], NOW)
    expect(cases.find((x) => x.type === 'execution_overdue')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// payment_release_pending
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – payment_release_pending', () => {
  it('classifies a release_pending payment older than 24h', () => {
    const payment = makePayment({
      state: 'release_pending',
      updatedAt: NOW - 30 * HOUR_MS,
    })
    const cases = deriveOperatorCases([makeJob()], [payment], [], [], NOW)
    const c = cases.find((x) => x.type === 'payment_release_pending')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('high')
    expect(c!.ageHours).toBe(30)
  })

  it('does not classify a release_pending payment younger than 24h', () => {
    const payment = makePayment({
      state: 'release_pending',
      updatedAt: NOW - 10 * HOUR_MS,
    })
    const cases = deriveOperatorCases([makeJob()], [payment], [], [], NOW)
    expect(cases.find((x) => x.type === 'payment_release_pending')).toBeUndefined()
  })

  it('does not classify non-release_pending payments', () => {
    const payment = makePayment({ state: 'in_escrow', updatedAt: NOW - 30 * HOUR_MS })
    const cases = deriveOperatorCases([makeJob()], [payment], [], [], NOW)
    expect(cases.find((x) => x.type === 'payment_release_pending')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// open_dispute
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – open_dispute', () => {
  it('classifies a dispute with status open as open_dispute', () => {
    const dispute = makeDispute({ status: 'open' })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    const c = cases.find((x) => x.type === 'open_dispute')
    expect(c).toBeDefined()
    expect(c!.severity).toBe('critical')
  })

  it('classifies a dispute with status customer_waiting as open_dispute', () => {
    const dispute = makeDispute({ status: 'customer_waiting' })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    expect(cases.find((x) => x.type === 'open_dispute')).toBeDefined()
  })

  it('classifies a dispute with status provider_waiting as open_dispute', () => {
    const dispute = makeDispute({ status: 'provider_waiting' })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    expect(cases.find((x) => x.type === 'open_dispute')).toBeDefined()
  })

  it('classifies a dispute with status under_review as open_dispute', () => {
    const dispute = makeDispute({ status: 'under_review' })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    expect(cases.find((x) => x.type === 'open_dispute')).toBeDefined()
  })

  it('does not classify a resolved dispute as open_dispute', () => {
    const dispute = makeDispute({
      status: 'resolved',
      decision: 'release',
      resolutionType: 'release_full',
    })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    expect(cases.find((x) => x.type === 'open_dispute')).toBeUndefined()
  })

  it('does not classify a rejected dispute as open_dispute', () => {
    const dispute = makeDispute({
      status: 'resolved',
      decision: 'reject',
      resolutionType: 'rejected',
    })
    const cases = deriveOperatorCases([makeJob()], [], [dispute], [], NOW)
    expect(cases.find((x) => x.type === 'open_dispute')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – severity ordering', () => {
  it('sorts critical before high before medium', () => {
    const job = makeJob({ status: 'new', proposalSentAt: undefined })

    const paymentStuck = makePayment({
      id: 'payment-stuck',
      jobId: 'job-1',
      state: 'release_pending',
      updatedAt: NOW - 30 * HOUR_MS,
    })

    const dispute = makeDispute({ jobId: 'job-1' })

    const cases = deriveOperatorCases([job], [paymentStuck], [dispute], [], NOW)

    expect(cases.length).toBeGreaterThanOrEqual(3)

    const severities = cases.map((c) => c.severity)
    const criticalIdx = severities.indexOf('critical')
    const highIdx = severities.indexOf('high')
    const mediumIdx = severities.indexOf('medium')

    expect(criticalIdx).toBeLessThan(highIdx)
    expect(highIdx).toBeLessThan(mediumIdx)
  })

  it('sorts equal-severity cases by ageHours DESC', () => {
    const olderJob = makeJob({
      id: 'job-older',
      title: 'Older',
      status: 'new',
      proposalSentAt: NOW - 60 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    const newerJob = makeJob({
      id: 'job-newer',
      title: 'Newer',
      status: 'new',
      proposalSentAt: NOW - 50 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })

    const cases = deriveOperatorCases([newerJob, olderJob], [], [], [], NOW)
    const pending = cases.filter((c) => c.type === 'proposal_pending')

    expect(pending.length).toBe(2)
    expect(pending[0].ageHours).toBeGreaterThanOrEqual(pending[1].ageHours)
  })

  it('execution_overdue (critical) sorts before open_dispute (critical) by ageHours', () => {
    const job = makeJob({ status: 'scheduled' })
    // Schedule overdue by 5h
    const schedule = makeSchedule({
      jobId: 'job-1',
      scheduledEnd: NOW - 5 * HOUR_MS,
      schedulingStatus: 'scheduled',
    })
    // Dispute open for 3h (less than schedule overdue)
    const dispute = makeDispute({ jobId: 'job-2', createdAt: new Date(NOW - 3 * HOUR_MS).toISOString() })
    const job2 = makeJob({ id: 'job-2', title: 'Other job', status: 'in_progress' })

    const cases = deriveOperatorCases([job, job2], [], [dispute], [schedule], NOW)
    const criticals = cases.filter((c) => c.severity === 'critical')
    expect(criticals.length).toBe(2)
    expect(criticals[0].ageHours).toBeGreaterThanOrEqual(criticals[1].ageHours)
  })
})

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe('deriveOperatorCases – empty inputs', () => {
  it('returns empty array for empty inputs', () => {
    expect(deriveOperatorCases([], [], [], [], NOW)).toEqual([])
  })
})
