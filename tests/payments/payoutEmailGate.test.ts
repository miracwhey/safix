/**
 * Block 3 review-fix — payout email gate.
 *
 * Protects the job-level `payout_completed` email from firing on a
 * partial payout (e.g. only the 25 % deposit tranche arrived on the
 * bank while the 75 % tranche has not yet released). The gate must
 * require the plan to be `fully_released` AND every released transfer
 * to carry its own `payout_completed` timeline signal.
 */

import { describe, it, expect } from 'vitest'

import {
  deriveJobsFullyPaidOut,
  buildPayoutCompletedSignalIds,
  extractTransferRefFromCompletedSignalId,
} from '../../src/lib/payments/payoutEmailGate'

describe('payoutEmailGate — signal id contract', () => {
  it('builds deterministic signal ids matching the webhook upsert key', () => {
    const ids = buildPayoutCompletedSignalIds(['tr_a', 'tr_b'])
    expect(ids).toEqual([
      'timeline_payout_completed__tr_a',
      'timeline_payout_completed__tr_b',
    ])
  })

  it('round-trips extract to recover the original transfer id', () => {
    const id = 'timeline_payout_completed__tr_x'
    expect(extractTransferRefFromCompletedSignalId(id)).toBe('tr_x')
  })

  it('returns null for unrelated signal ids', () => {
    expect(extractTransferRefFromCompletedSignalId('timeline_payout_failed__tr_x')).toBeNull()
    expect(extractTransferRefFromCompletedSignalId('timeline_payment_released')).toBeNull()
  })
})

describe('payoutEmailGate — deriveJobsFullyPaidOut', () => {
  it('does NOT mark a job eligible when only the 25 % tranche payout arrived', () => {
    // Plan is partially released (75 % tranche still released=false on the
    // other branch in reality, but here the 25 % is released with proof
    // while the 75 % is not) — the plan.status disqualifies it even before
    // the signal check runs.
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-1', jobId: 'job-1', status: 'partially_released' }],
      tranches: [
        { planId: 'plan-1', externalReleaseRef: 'tr_25', status: 'released' },
        { planId: 'plan-1', externalReleaseRef: null, status: 'funded' },
      ],
      completedSignalIds: ['timeline_payout_completed__tr_25'],
    })
    expect(eligible.has('job-1')).toBe(false)
    expect(eligible.size).toBe(0)
  })

  it('does NOT mark a job eligible when plan is fully_released but a later tranche has no payout_completed yet', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-2', jobId: 'job-2', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-2', externalReleaseRef: 'tr_25', status: 'released' },
        { planId: 'plan-2', externalReleaseRef: 'tr_75', status: 'released' },
      ],
      completedSignalIds: ['timeline_payout_completed__tr_25'],
    })
    expect(eligible.has('job-2')).toBe(false)
  })

  it('marks a job eligible only when plan fully_released AND all released tranches have payout_completed', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-3', jobId: 'job-3', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-3', externalReleaseRef: 'tr_25', status: 'released' },
        { planId: 'plan-3', externalReleaseRef: 'tr_75', status: 'released' },
      ],
      completedSignalIds: [
        'timeline_payout_completed__tr_25',
        'timeline_payout_completed__tr_75',
      ],
    })
    expect(eligible.has('job-3')).toBe(true)
    expect(eligible.size).toBe(1)
  })

  it('ignores unrelated jobs with the same completed refs', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [
        { id: 'plan-a', jobId: 'job-a', status: 'fully_released' },
        { id: 'plan-b', jobId: 'job-b', status: 'partially_released' },
      ],
      tranches: [
        { planId: 'plan-a', externalReleaseRef: 'tr_a1', status: 'released' },
        { planId: 'plan-b', externalReleaseRef: 'tr_b1', status: 'released' },
      ],
      completedSignalIds: [
        'timeline_payout_completed__tr_a1',
        'timeline_payout_completed__tr_b1',
      ],
    })
    expect(eligible.has('job-a')).toBe(true)
    expect(eligible.has('job-b')).toBe(false)
  })

  it('ignores non-released tranches when checking completeness', () => {
    // Final tranche was cancelled → plan considered fully released for
    // email purposes only when all released ones are completed; the
    // cancelled tranche has no payout and is skipped.
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-4', jobId: 'job-4', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-4', externalReleaseRef: 'tr_dep', status: 'released' },
        { planId: 'plan-4', externalReleaseRef: null, status: 'cancelled' },
      ],
      completedSignalIds: ['timeline_payout_completed__tr_dep'],
    })
    expect(eligible.has('job-4')).toBe(true)
  })

  it('returns empty for empty inputs', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [],
      tranches: [],
      completedSignalIds: [],
    })
    expect(eligible.size).toBe(0)
  })

  it('does NOT fire when a plan has no released tranches (guard against empty-set match)', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-empty', jobId: 'job-empty', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-empty', externalReleaseRef: null, status: 'funded' },
      ],
      completedSignalIds: [],
    })
    expect(eligible.has('job-empty')).toBe(false)
  })
})

// =========================================================================
// Item E — destination-charge payout corridor (po_* proving ref)
//
// Corridor tranches carry external_payout_ref (po_*) instead of
// external_release_ref (tr_*). A released corridor tranche must count as
// paid-out via its po_* proving ref, gated by the SAME
// `timeline_payout_completed__{ref}` signal. Flag-OFF rows (tr_* only,
// externalPayoutRef omitted/NULL) must behave exactly as before.
// =========================================================================

describe('payoutEmailGate — corridor (po_*) proving ref', () => {
  it('marks a job eligible when a released corridor tranche proves via po_* and its signal is present', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-c1', jobId: 'job-c1', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-c1', externalReleaseRef: null, externalPayoutRef: 'po_x', status: 'released' },
      ],
      completedSignalIds: ['timeline_payout_completed__po_x'],
    })
    expect(eligible.has('job-c1')).toBe(true)
    expect(eligible.size).toBe(1)
  })

  it('does NOT mark eligible when the po_* corridor tranche has no payout_completed signal yet', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-c2', jobId: 'job-c2', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-c2', externalReleaseRef: null, externalPayoutRef: 'po_y', status: 'released' },
      ],
      completedSignalIds: [],
    })
    expect(eligible.has('job-c2')).toBe(false)
    expect(eligible.size).toBe(0)
  })

  it('requires BOTH proving signals on a mixed tr_*/po_* plan', () => {
    const tranches = [
      { planId: 'plan-c3', externalReleaseRef: 'tr_dep', status: 'released' },
      { planId: 'plan-c3', externalReleaseRef: null, externalPayoutRef: 'po_final', status: 'released' },
    ]
    const plans = [{ id: 'plan-c3', jobId: 'job-c3', status: 'fully_released' }]

    const bothPresent = deriveJobsFullyPaidOut({
      plans,
      tranches,
      completedSignalIds: [
        'timeline_payout_completed__tr_dep',
        'timeline_payout_completed__po_final',
      ],
    })
    expect(bothPresent.has('job-c3')).toBe(true)

    const poMissing = deriveJobsFullyPaidOut({
      plans,
      tranches,
      completedSignalIds: ['timeline_payout_completed__tr_dep'],
    })
    expect(poMissing.has('job-c3')).toBe(false)
  })

  it('does NOT count a released tranche carrying neither proving ref', () => {
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-c4', jobId: 'job-c4', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-c4', externalReleaseRef: null, externalPayoutRef: null, status: 'released' },
      ],
      completedSignalIds: ['timeline_payout_completed__'],
    })
    expect(eligible.has('job-c4')).toBe(false)
  })

  it('REGRESSION: tr_*-only plans (externalPayoutRef omitted) yield identical results to the pre-Item-E suite', () => {
    // Same shape as the canonical tr_25/tr_75 eligible case above, with NO
    // externalPayoutRef field — proving the optional field defaults inertly.
    const eligible = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-r', jobId: 'job-r', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-r', externalReleaseRef: 'tr_25', status: 'released' },
        { planId: 'plan-r', externalReleaseRef: 'tr_75', status: 'released' },
      ],
      completedSignalIds: [
        'timeline_payout_completed__tr_25',
        'timeline_payout_completed__tr_75',
      ],
    })
    expect(eligible.has('job-r')).toBe(true)
    expect(eligible.size).toBe(1)

    const partial = deriveJobsFullyPaidOut({
      plans: [{ id: 'plan-r', jobId: 'job-r', status: 'fully_released' }],
      tranches: [
        { planId: 'plan-r', externalReleaseRef: 'tr_25', status: 'released' },
        { planId: 'plan-r', externalReleaseRef: 'tr_75', status: 'released' },
      ],
      completedSignalIds: ['timeline_payout_completed__tr_25'],
    })
    expect(partial.has('job-r')).toBe(false)
  })
})
