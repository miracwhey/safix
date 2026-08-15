/**
 * Escrow Plan — Attribution Gate (Finding M1)
 *
 * The escrow plan locks the platform fee rate IMMUTABLY at creation time.
 * Root cause: ensureEscrowPlan used the display-safe resolver, which returns
 * the 9 % default for a job whose commercial attribution is still unresolved
 * ('unknown_pending_resolution' / attribution_status pending|retrying). A
 * merchant_brought job (5 %) whose attribution had not yet finalized would
 * therefore get 9 % frozen into its plan forever.
 *
 * Fix: ensureEscrowPlan now fails closed on unresolved attribution, mirroring
 * the server gate (api/_attributionGuard.ts / api/_feeRate.ts). It throws and
 * is retried idempotently once attribution finalizes.
 *
 * Cases:
 *   1. merchant_brought + attribution pending  → no 9 % lock (throws)
 *   2. merchant_brought + attribution retrying → no lock (throws)
 *   3. origin unknown_pending_resolution       → no lock (throws)
 *   4. finalized merchant_brought              → 5 % correctly locked
 *   5. finalized platform_acquired             → 9 % correctly locked
 *   6. legacy job (no attribution fields)      → 9 % default (backward compat)
 *   7. defer-then-retry: throws while pending, then locks 5 % after finalize
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobRepository } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import { ensureEscrowPlan } from '../../src/lib/payments/escrow'
import { getEscrowPlanByOfferId } from '../../src/lib/payments/escrow'

function makeJob(id: string, overrides?: Partial<Job>): Job {
  return {
    id,
    projectId: `project_${id}`,
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'booked',
    amount: '€4.000',
    description: 'Test description',
    paymentState: 'deposit_required',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    ...overrides,
  }
}

describe('escrow plan — attribution finalized gate (M1)', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('1 — merchant_brought + attribution pending → throws, no 9 % lock', async () => {
    await addJob(
      makeJob('job-mb-pending', {
        commercialOrigin: 'unknown_pending_resolution',
        attributionStatus: 'pending',
      }),
    )

    await expect(
      ensureEscrowPlan({
        sourceOfferId: 'offer-mb-pending',
        jobId: 'job-mb-pending',
        customerUserId: 'customer-1',
        providerId: 'provider-1',
        totalAmount: 4000,
      }),
    ).rejects.toThrow('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')

    // No plan was created — nothing was frozen.
    expect(getEscrowPlanByOfferId('offer-mb-pending')).toBeUndefined()
  })

  it('2 — attribution retrying → throws, no lock', async () => {
    await addJob(
      makeJob('job-retrying', {
        commercialOrigin: 'unknown_pending_resolution',
        attributionStatus: 'retrying',
      }),
    )

    await expect(
      ensureEscrowPlan({
        sourceOfferId: 'offer-retrying',
        jobId: 'job-retrying',
        customerUserId: 'customer-1',
        providerId: 'provider-1',
        totalAmount: 4000,
      }),
    ).rejects.toThrow('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
    expect(getEscrowPlanByOfferId('offer-retrying')).toBeUndefined()
  })

  it('3 — origin unknown_pending_resolution alone → throws', async () => {
    await addJob(
      makeJob('job-unknown-origin', {
        commercialOrigin: 'unknown_pending_resolution',
      }),
    )

    await expect(
      ensureEscrowPlan({
        sourceOfferId: 'offer-unknown-origin',
        jobId: 'job-unknown-origin',
        customerUserId: 'customer-1',
        providerId: 'provider-1',
        totalAmount: 4000,
      }),
    ).rejects.toThrow('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
  })

  it('4 — finalized merchant_brought → 5 % correctly locked', async () => {
    await addJob(
      makeJob('job-mb-final', {
        commercialOrigin: 'merchant_brought',
        attributionStatus: 'finalized',
      }),
    )

    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-mb-final',
      jobId: 'job-mb-final',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 4000,
    })

    expect(plan.platformFeeRate).toBe(0.05)
    expect(plan.platformFeeAmount).toBe(200)
  })

  it('5 — finalized platform_acquired → 9 % correctly locked', async () => {
    await addJob(
      makeJob('job-pa-final', {
        commercialOrigin: 'platform_acquired',
        attributionStatus: 'finalized',
      }),
    )

    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-pa-final',
      jobId: 'job-pa-final',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 4000,
    })

    expect(plan.platformFeeRate).toBe(0.09)
    expect(plan.platformFeeAmount).toBe(360)
  })

  it('6 — legacy job (no attribution fields) → 9 % default (backward compat)', async () => {
    await addJob(makeJob('job-legacy'))

    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-legacy',
      jobId: 'job-legacy',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 4000,
    })

    expect(plan.platformFeeRate).toBe(0.09)
  })

  it('7 — defer then retry: throws while pending, locks 5 % after finalize', async () => {
    await addJob(
      makeJob('job-defer', {
        commercialOrigin: 'unknown_pending_resolution',
        attributionStatus: 'pending',
      }),
    )

    // First attempt is deferred — nothing frozen.
    await expect(
      ensureEscrowPlan({
        sourceOfferId: 'offer-defer',
        jobId: 'job-defer',
        customerUserId: 'customer-1',
        providerId: 'provider-1',
        totalAmount: 4000,
      }),
    ).rejects.toThrow('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')

    // Attribution Finalizer resolves the job to merchant_brought.
    await getJobRepository().update('job-defer', (j) => ({
      ...j,
      commercialOrigin: 'merchant_brought',
      attributionStatus: 'finalized',
    }))

    // Idempotent retry now succeeds and locks the correct 5 %.
    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-defer',
      jobId: 'job-defer',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 4000,
    })

    expect(plan.platformFeeRate).toBe(0.05)
    expect(plan.platformFeeAmount).toBe(200)
  })
})
