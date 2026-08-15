import { describe, it, expect } from 'vitest'
import {
  isProposalStuck,
  isSchedulingStuck,
  isExecutionSilent,
  isPaymentReleasePending,
} from '../../src/lib/jobs/customerStuckStateSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const HOUR_MS = 1000 * 60 * 60

const INTAKE_CONTEXT: Job['intakeContext'] = {
  origin: 'inquiry_reel',
  originLabel: 'Explore-Reel',
}

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

// ---------------------------------------------------------------------------
// isProposalStuck
// ---------------------------------------------------------------------------

describe('isProposalStuck', () => {
  it('returns true for a new job with no proposal and an intakeContext', () => {
    const job = makeJob({ status: 'new', proposalSentAt: undefined, intakeContext: INTAKE_CONTEXT })
    expect(isProposalStuck(job)).toBe(true)
  })

  it('returns false when a proposal has already been sent', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 10 * HOUR_MS,
      intakeContext: INTAKE_CONTEXT,
    })
    expect(isProposalStuck(job)).toBe(false)
  })

  it('returns false when there is no intakeContext (not a real inquiry)', () => {
    const job = makeJob({ status: 'new', proposalSentAt: undefined, intakeContext: undefined })
    expect(isProposalStuck(job)).toBe(false)
  })

  it('returns false when the job is not in new status', () => {
    const job = makeJob({ status: 'in_progress', proposalSentAt: undefined, intakeContext: INTAKE_CONTEXT })
    expect(isProposalStuck(job)).toBe(false)
  })

  it('returns false for a completed job even if proposalSentAt is absent', () => {
    const job = makeJob({ status: 'completed', proposalSentAt: undefined, intakeContext: INTAKE_CONTEXT })
    expect(isProposalStuck(job)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isSchedulingStuck
// ---------------------------------------------------------------------------

describe('isSchedulingStuck', () => {
  it('returns false when proposalAcceptedAt is absent', () => {
    const job = makeJob({ status: 'scheduled', proposalAcceptedAt: undefined })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })

  it('returns true when accepted > 72h ago and job not yet in_progress', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 73 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(true)
  })

  it('returns false when accepted exactly at the 72h boundary (not yet exceeded)', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 72 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })

  it('returns false when accepted 71h ago (just below threshold)', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 71 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })

  it('returns false when job is in_progress regardless of age', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })

  it('returns false when job is waiting_payment regardless of age', () => {
    const job = makeJob({
      status: 'waiting_payment',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })

  it('returns false when job is completed regardless of age', () => {
    const job = makeJob({
      status: 'completed',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(isSchedulingStuck(job, NOW)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isExecutionSilent
// ---------------------------------------------------------------------------

describe('isExecutionSilent', () => {
  it('returns false when job is not in_progress', () => {
    const job = makeJob({ status: 'waiting_payment', proposalAcceptedAt: NOW - 100 * HOUR_MS })
    expect(isExecutionSilent(job, NOW)).toBe(false)
  })

  it('returns false when there is no last signal (no proposalAcceptedAt)', () => {
    const job = makeJob({ status: 'in_progress', proposalAcceptedAt: undefined })
    expect(isExecutionSilent(job, NOW)).toBe(false)
  })

  it('returns true when proposalAcceptedAt is more than 72h ago', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    expect(isExecutionSilent(job, NOW)).toBe(true)
  })

  it('returns false when proposalAcceptedAt is less than 72h ago', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 50 * HOUR_MS,
    })
    expect(isExecutionSilent(job, NOW)).toBe(false)
  })

  it('uses workCompletedAt as the last signal when present', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 100 * HOUR_MS, // old
      workCompletedAt: NOW - 10 * HOUR_MS,     // recent signal
    })
    expect(isExecutionSilent(job, NOW)).toBe(false)
  })

  it('flags as silent when workCompletedAt is also more than 72h ago', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
      workCompletedAt: NOW - 80 * HOUR_MS,
    })
    expect(isExecutionSilent(job, NOW)).toBe(true)
  })

  it('returns false at the 72h boundary (not yet exceeded)', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 72 * HOUR_MS,
    })
    expect(isExecutionSilent(job, NOW)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPaymentReleasePending
// ---------------------------------------------------------------------------

describe('isPaymentReleasePending', () => {
  it('returns true when payment.state is release_pending', () => {
    const payment = makePayment({ state: 'release_pending' })
    expect(isPaymentReleasePending(payment)).toBe(true)
  })

  it('returns false when payment.state is in_escrow', () => {
    const payment = makePayment({ state: 'in_escrow' })
    expect(isPaymentReleasePending(payment)).toBe(false)
  })

  it('returns false when payment.state is released', () => {
    const payment = makePayment({ state: 'released' })
    expect(isPaymentReleasePending(payment)).toBe(false)
  })

  it('returns false when payment.state is disputed', () => {
    const payment = makePayment({ state: 'disputed' })
    expect(isPaymentReleasePending(payment)).toBe(false)
  })

  it('returns false when payment is undefined', () => {
    expect(isPaymentReleasePending(undefined)).toBe(false)
  })
})
