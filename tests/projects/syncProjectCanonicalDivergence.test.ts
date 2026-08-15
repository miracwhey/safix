/**
 * syncProjectFromJob — Canonical Payment Divergence Tests
 *
 * Closes LOGIC-ONLY gap from Payment Sync Guards block:
 *
 * When canonical payment.state diverges from job.paymentState (stale mirror),
 * syncProjectFromJob must use the canonical value — not the mirror.
 *
 * Previously syncProjectFromJob always copied job.paymentState.
 * After the guard fix, it accepts an optional canonicalPaymentState parameter
 * that takes precedence.
 */

import { describe, it, expect } from 'vitest'
import {
  syncProjectFromJob,
} from '../../src/lib/projects/projectStatusSync'
import type { Job } from '../../src/lib/jobs/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '€2.000',
    description: 'Test',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Canonical divergence
// ---------------------------------------------------------------------------

describe('syncProjectFromJob — canonical payment state divergence', () => {
  it('uses canonical payment state when it diverges from job mirror', () => {
    // RISK: job.paymentState is "none" (stale), canonical payment is "deposit_paid".
    // Old code would propagate "none" to project — wrong.
    const job = makeJob({ paymentState: 'none' })
    const result = syncProjectFromJob(job, 'deposit_paid')

    expect(result.paymentState).toBe('deposit_paid')
    expect(result.status).toBe('in_progress')
  })

  it('uses canonical "released" even when job mirror says "work_in_progress"', () => {
    const job = makeJob({ status: 'completed', paymentState: 'work_in_progress' })
    const result = syncProjectFromJob(job, 'released')

    expect(result.paymentState).toBe('released')
    expect(result.status).toBe('completed')
  })

  it('uses canonical "disputed" even when job mirror says "release_pending"', () => {
    const job = makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })
    const result = syncProjectFromJob(job, 'disputed')

    expect(result.paymentState).toBe('disputed')
    expect(result.status).toBe('review')
  })

  it('uses canonical "refunded" even when job mirror says "in_escrow"', () => {
    const job = makeJob({ status: 'cancelled', paymentState: 'in_escrow' })
    const result = syncProjectFromJob(job, 'refunded')

    expect(result.paymentState).toBe('refunded')
    expect(result.status).toBe('cancelled')
  })

  // ── Fallback: no canonical available ────────────────────────────────

  it('falls back to job.paymentState when canonicalPaymentState is undefined', () => {
    const job = makeJob({ paymentState: 'work_in_progress' })
    const result = syncProjectFromJob(job)

    expect(result.paymentState).toBe('work_in_progress')
  })

  it('falls back to job.paymentState when canonicalPaymentState is explicitly undefined', () => {
    const job = makeJob({ paymentState: 'deposit_required' })
    const result = syncProjectFromJob(job, undefined)

    expect(result.paymentState).toBe('deposit_required')
  })

  // ── Agreement case: canonical matches mirror ──────────────────────────

  it('works correctly when canonical and mirror agree', () => {
    const job = makeJob({ status: 'in_progress', paymentState: 'work_in_progress' })
    const result = syncProjectFromJob(job, 'work_in_progress')

    expect(result.paymentState).toBe('work_in_progress')
    expect(result.status).toBe('in_progress')
  })

  // ── Status derivation is independent of payment state ─────────────────

  it('status derivation does not change based on canonical payment state', () => {
    // Status is derived from job.status, not payment state.
    const job = makeJob({ status: 'waiting_payment', paymentState: 'none' })

    const withCanonical = syncProjectFromJob(job, 'released')
    const withoutCanonical = syncProjectFromJob(job)

    // Status is the same regardless
    expect(withCanonical.status).toBe('review')
    expect(withoutCanonical.status).toBe('review')

    // Payment state differs
    expect(withCanonical.paymentState).toBe('released')
    expect(withoutCanonical.paymentState).toBe('none')
  })

  // ── Backward compatibility: old callers still work ────────────────────

  it('old signature (no second arg) still returns correct result', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: 1_700_000_000_000,
      proposalAcceptedAt: 1_700_000_100_000,
    })
    const result = syncProjectFromJob(job)

    expect(result.status).toBe('accepted')
    expect(result.paymentState).toBe('deposit_required')
  })
})
