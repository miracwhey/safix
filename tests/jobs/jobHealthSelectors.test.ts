import { describe, it, expect } from 'vitest'
import { deriveJobHealth } from '../../src/lib/jobs/jobHealthSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

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
    createdAt: NOW - 10 * HOUR_MS,
    updatedAt: NOW - 10 * HOUR_MS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// healthy – baseline
// ---------------------------------------------------------------------------

describe('deriveJobHealth – healthy', () => {
  it('returns healthy for a clean new job with no payment or dispute', () => {
    expect(deriveJobHealth(makeJob(), undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy for an in_progress job within thresholds', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 50 * HOUR_MS,
    })
    expect(deriveJobHealth(job, makePayment(), undefined, NOW)).toBe('healthy')
  })

  it('returns healthy when proposalSentAt is set but well within 48h', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy for a completed job', () => {
    const job = makeJob({ status: 'completed' })
    expect(deriveJobHealth(job, makePayment({ state: 'released' }), undefined, NOW)).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// blocked – open dispute
// ---------------------------------------------------------------------------

describe('deriveJobHealth – blocked by dispute', () => {
  it('returns blocked when dispute status is open', () => {
    expect(deriveJobHealth(makeJob(), undefined, makeDispute({ status: 'open' }), NOW)).toBe('blocked')
  })

  it('returns blocked when dispute status is customer_waiting', () => {
    expect(deriveJobHealth(makeJob(), undefined, makeDispute({ status: 'customer_waiting' }), NOW)).toBe('blocked')
  })

  it('returns blocked when dispute status is provider_waiting', () => {
    expect(deriveJobHealth(makeJob(), undefined, makeDispute({ status: 'provider_waiting' }), NOW)).toBe('blocked')
  })

  it('returns blocked when dispute status is under_review', () => {
    expect(deriveJobHealth(makeJob(), undefined, makeDispute({ status: 'under_review' }), NOW)).toBe('blocked')
  })

  it('returns healthy when dispute is resolved (decision=release)', () => {
    expect(
      deriveJobHealth(
        makeJob(),
        undefined,
        makeDispute({ status: 'resolved', decision: 'release', resolutionType: 'release_full' }),
        NOW,
      ),
    ).toBe('healthy')
  })

  it('returns healthy when dispute is resolved (decision=reject)', () => {
    expect(
      deriveJobHealth(
        makeJob(),
        undefined,
        makeDispute({ status: 'resolved', decision: 'reject', resolutionType: 'rejected' }),
        NOW,
      ),
    ).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// blocked – disputed payment
// ---------------------------------------------------------------------------

describe('deriveJobHealth – blocked by disputed payment', () => {
  it('returns blocked when payment.state is disputed', () => {
    const payment = makePayment({ state: 'disputed' })
    expect(deriveJobHealth(makeJob(), payment, undefined, NOW)).toBe('blocked')
  })

  it('returns healthy when payment is in_escrow (not disputed)', () => {
    const payment = makePayment({ state: 'in_escrow' })
    expect(deriveJobHealth(makeJob(), payment, undefined, NOW)).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// blocked takes priority over attention
// ---------------------------------------------------------------------------

describe('deriveJobHealth – blocked takes priority over attention', () => {
  it('returns blocked not attention when both a stale proposal and an open dispute exist', () => {
    const job = makeJob({
      proposalSentAt: NOW - 60 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    const dispute = makeDispute({ status: 'open' })
    expect(deriveJobHealth(job, undefined, dispute, NOW)).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------
// attention – proposal pending > 48h
// ---------------------------------------------------------------------------

describe('deriveJobHealth – attention (proposal pending)', () => {
  it('returns attention when proposalSentAt is > 48h ago with no acceptance', () => {
    const job = makeJob({
      proposalSentAt: NOW - 50 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('attention')
  })

  it('returns healthy at the 48h boundary (not yet exceeded)', () => {
    const job = makeJob({
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: undefined,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy when proposal has been accepted even if > 48h ago', () => {
    const job = makeJob({
      proposalSentAt: NOW - 60 * HOUR_MS,
      proposalAcceptedAt: NOW - 10 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// attention – scheduling pending > 72h
// ---------------------------------------------------------------------------

describe('deriveJobHealth – attention (scheduling pending)', () => {
  it('returns attention when proposalAcceptedAt is > 72h ago and job not executing', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('attention')
  })

  it('returns healthy at the 72h boundary (not yet exceeded)', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalAcceptedAt: NOW - 72 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy for in_progress regardless of age', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy for waiting_payment regardless of age', () => {
    const job = makeJob({
      status: 'waiting_payment',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })

  it('returns healthy for completed regardless of age', () => {
    const job = makeJob({
      status: 'completed',
      proposalAcceptedAt: NOW - 100 * HOUR_MS,
    })
    expect(deriveJobHealth(job, undefined, undefined, NOW)).toBe('healthy')
  })
})
