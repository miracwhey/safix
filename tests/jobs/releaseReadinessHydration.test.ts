/**
 * Block B: Payment Truth / Hydration / Readiness
 *
 * Verifies fail-closed semantics for payment-critical selectors when the
 * Payment repository is not yet hydrated.
 *
 * Invariants:
 * - deriveReleaseReadiness must not enable CTAs from a stale job.paymentState
 *   mirror while the Payment repository is still loading.
 * - deriveJobOutcome must not declare a terminal payment outcome while the
 *   Payment repository is still loading.
 * - Normal paths (payment entity present, or repo hydrated) must be unaffected.
 */

import { describe, it, expect } from 'vitest'
import { deriveReleaseReadiness } from '../../src/lib/jobs/releaseReadinessSelectors'
import { deriveJobOutcome } from '../../src/lib/jobs/jobOutcomeSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-hydration-test',
    projectId: 'project-hydration-test',
    title: 'Hydration Test Job',
    customer: 'Tester',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'in_progress',
    amount: '2.000 €',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makePayment(state: Payment['state']): Payment {
  return {
    id: 'pay-hydration-test',
    jobId: 'job-hydration-test',
    state,
    amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// deriveReleaseReadiness — hydration guard
// ---------------------------------------------------------------------------

describe('deriveReleaseReadiness — payment hydration guard', () => {
  it('returns null when payment repo not hydrated and no payment entity — no CTA from stale mirror', () => {
    const job = makeJob({ status: 'in_progress', paymentState: 'in_escrow' })

    const vm = deriveReleaseReadiness(job, undefined, false)

    expect(vm).toBeNull()
  })

  it('returns null for waiting_payment job with stale release_pending mirror when not hydrated', () => {
    const job = makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })

    const vm = deriveReleaseReadiness(job, undefined, false)

    expect(vm).toBeNull()
  })

  it('returns execution_active when repo hydrated and no payment — job.paymentState fallback is safe', () => {
    const job = makeJob({ status: 'in_progress', paymentState: 'in_escrow' })

    const vm = deriveReleaseReadiness(job, undefined, true)

    expect(vm?.phase).toBe('execution_active')
    expect(vm?.canMarkComplete).toBe(true)
  })

  it('returns execution_active when payment is provided regardless of hydration flag', () => {
    const job = makeJob({ status: 'in_progress', paymentState: 'deposit_required' })
    const payment = makePayment('work_in_progress')

    const vm = deriveReleaseReadiness(job, payment, false)

    expect(vm?.phase).toBe('execution_active')
    expect(vm?.canMarkComplete).toBe(true)
    expect(vm?.canReleasePayment).toBe(false)
  })

  it('returns work_completed phase but canReleasePayment=false when not hydrated and no payment', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workCompletedAt: Date.now() - 1000,
      paymentState: 'release_pending',
    })

    const vm = deriveReleaseReadiness(job, undefined, false)

    // Work status is visible (phase derived from job facts)
    expect(vm?.phase).toBe('work_completed')
    // But release CTA is blocked — no payment truth loaded yet
    expect(vm?.canReleasePayment).toBe(false)
    expect(vm?.canMarkComplete).toBe(false)
  })

  it('enables canReleasePayment when workCompletedAt set and payment is loaded', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workCompletedAt: Date.now() - 1000,
    })
    const payment = makePayment('release_pending')

    const vm = deriveReleaseReadiness(job, payment, false)

    expect(vm?.phase).toBe('work_completed')
    expect(vm?.canReleasePayment).toBe(true)
  })

  it('enables canReleasePayment when workCompletedAt set and repo hydrated (no payment entity)', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workCompletedAt: Date.now() - 1000,
    })

    const vm = deriveReleaseReadiness(job, undefined, true)

    expect(vm?.phase).toBe('work_completed')
    expect(vm?.canReleasePayment).toBe(true)
  })

  it('blocks canReleasePayment for work_completed when dispute open and not hydrated', () => {
    const job = makeJob({
      status: 'waiting_payment',
      workCompletedAt: Date.now() - 1000,
      disputeStatus: 'open',
    })

    // Dispute blocks release regardless of hydration
    const vm = deriveReleaseReadiness(job, undefined, false)

    expect(vm?.phase).toBe('work_completed')
    expect(vm?.canReleasePayment).toBe(false)
  })

  it('returns payment_released when job.paymentReleasedAt is set — no payment state needed', () => {
    const now = Date.now()
    const job = makeJob({
      status: 'completed',
      workCompletedAt: now - 7200_000,
      paymentReleasedAt: now - 3600_000,
    })

    const vm = deriveReleaseReadiness(job, undefined, false)

    expect(vm?.phase).toBe('payment_released')
    expect(vm?.canMarkComplete).toBe(false)
    expect(vm?.canReleasePayment).toBe(false)
  })

  it('defaults paymentHydrated to true — existing callers without arg are unaffected', () => {
    const job = makeJob({ status: 'in_progress', paymentState: 'work_in_progress' })
    const payment = makePayment('work_in_progress')

    const vm = deriveReleaseReadiness(job, payment)

    expect(vm?.phase).toBe('execution_active')
  })
})

// ---------------------------------------------------------------------------
// deriveJobOutcome — hydration guard
// ---------------------------------------------------------------------------

describe('deriveJobOutcome — payment hydration guard', () => {
  it('returns isTerminal=false when payment repo not hydrated and no payment', () => {
    const job = makeJob({ status: 'completed', paymentState: 'released' })

    const vm = deriveJobOutcome(job, undefined, false)

    expect(vm.isTerminal).toBe(false)
    expect(vm.outcomeType).toBe('none')
  })

  it('returns isTerminal=false for stale refunded mirror when not hydrated', () => {
    const job = makeJob({ status: 'completed', paymentState: 'refunded' })

    const vm = deriveJobOutcome(job, undefined, false)

    expect(vm.isTerminal).toBe(false)
  })

  it('returns released terminal outcome when payment.state=released regardless of hydration', () => {
    const job = makeJob({ status: 'completed', paymentState: 'deposit_required' })
    const payment = makePayment('released')

    const vm = deriveJobOutcome(job, payment, false)

    expect(vm.isTerminal).toBe(true)
    expect(vm.outcomeType).toBe('released')
  })

  it('returns cancelled terminal outcome even without payment and without hydration', () => {
    const job = makeJob({ status: 'cancelled', paymentState: 'deposit_required' })

    const vm = deriveJobOutcome(job, undefined, false)

    expect(vm.isTerminal).toBe(true)
    expect(vm.outcomeType).toBe('cancelled')
  })

  it('returns released outcome when repo hydrated and job.paymentState fallback is released', () => {
    const job = makeJob({ status: 'completed', paymentState: 'released' })

    const vm = deriveJobOutcome(job, undefined, true)

    expect(vm.isTerminal).toBe(true)
    expect(vm.outcomeType).toBe('released')
  })

  it('defaults paymentHydrated to true — existing callers without arg are unaffected', () => {
    const job = makeJob({ status: 'cancelled' })

    const vm = deriveJobOutcome(job)

    expect(vm.outcomeType).toBe('cancelled')
  })
})
