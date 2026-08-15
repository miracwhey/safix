/**
 * C1 — Release money-leg routing: tranche corridor instead of legacy capture.
 *
 * Prod facts behind the finding: corridor payments carry NO providerRef
 * (payments.provider_ref is a legacy column, 0/10 set) and /api/capture-escrow
 * is retired (410 unless ALLOW_LEGACY_ESCROW='1'). releaseEscrowWorkflow used
 * to route EVERY release — all dispute resolutions (release/split/reject/
 * consensus) and "Accept & Release" — through releaseEscrowPayment, which
 * throws without providerRef and would hit the dead endpoint anyway. Money was
 * never auto-released; disputes stayed settlementStatus='pending' forever.
 *
 * Contract under the fix:
 *  1. Escrow-plan (corridor) jobs NEVER call provider.releaseEscrow (the
 *     capture-escrow path). Money moves exclusively via
 *     requestServerTrancheRelease → api/release-tranche.ts.
 *  2. A missing providerRef must NOT crash the release.
 *  3. Synchronous server release ('released') → canonical payment flips to
 *     'released' AFTER the bridge confirms; dispute settles; job completes.
 *  4. Async corridor release ('release_pending') → payment stays un-released,
 *     settlement stays 'pending', job is NOT completed — the payout.paid
 *     webhook performs the authoritative settlement server-side.
 *  5. Split refund leg (customer share) runs BEFORE the bridge, uses the
 *     plan's funding PI (not payment.providerRef), and gates the bridge
 *     fail-closed.
 *  6. Legacy jobs (no escrow plan) keep the provider capture as the complete
 *     release.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { resolveDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { releaseEscrowWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import * as releaseClient from '../../src/lib/payments/releaseClient'
import { getPaymentProvider } from '../../src/lib/payments/providers'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getJobById } from '../../src/lib/jobs'
import {
  ensureEscrowPlan,
  confirmFunding,
  getEscrowTranches,
  recordWorkStarted,
  recordWorkCompleted,
} from '../../src/lib/payments/escrow'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'
import type { Job } from '../../src/lib/jobs/types'

// ── Seed helpers ─────────────────────────────────────────────────────────

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: overrides.status ?? 'waiting_payment',
    amount: '1.000 €',
    description: 'Testarbeit',
    paymentState: overrides.paymentState ?? 'disputed',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

// Deliberately NO providerRef — mirrors prod corridor payments (provider_ref
// is a legacy column, 0/10 set). The release must not throw because of this.
function seedPayment(jobId: string, state: Payment['state']): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

function seedDispute(jobId: string, status: Dispute['status']): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test Dispute',
    description: 'Test dispute description',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

const FUNDING_PI = 'pi_corridor_funding_123'

async function setupFundedEscrowPlan(jobId: string) {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    customerUserId: `cust-${jobId}`,
    providerId: `prov-${jobId}`,
    totalAmount: 1000,
  })
  await confirmFunding(plan.id, { externalFundingRef: FUNDING_PI })
  await recordWorkStarted(plan.id, 'provider')
  await recordWorkCompleted(plan.id, 'provider')
  return plan
}

function mockServerRelease(
  planId: string,
  status: 'released' | 'release_pending' = 'released',
) {
  return vi.spyOn(releaseClient, 'requestServerTrancheRelease').mockResolvedValue({
    ok: true,
    data: {
      status,
      trancheId: 'mock-tranche',
      planId,
      planStatus: status === 'released' ? 'fully_released' : 'partially_released',
      releasedAt: status === 'released' ? new Date().toISOString() : null,
      externalReleaseRef: status === 'released' ? 'tr_mock_123' : 'po_mock_123',
    },
  })
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('C1 — corridor release routing (no legacy capture path)', () => {
  let releaseEscrowSpy: ReturnType<typeof vi.spyOn>
  let refundEscrowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setupCleanRepositories()
    const provider = getPaymentProvider()
    releaseEscrowSpy = vi.spyOn(provider, 'releaseEscrow')
    refundEscrowSpy = vi.spyOn(provider, 'refundEscrow')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolve release → NO provider.releaseEscrow (capture-escrow), tranche release invoked instead', async () => {
    const jobId = 'job-c1-release-1'
    const plan = await setupFundedEscrowPlan(jobId)
    const eligible = getEscrowTranches(plan.id).filter((t) => t.status === 'eligible_for_release')
    expect(eligible.length).toBeGreaterThanOrEqual(1)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const bridgeSpy = mockServerRelease(plan.id)

    await resolveDisputeWorkflow(dispute.id, 'release')

    // The dead legacy path must NEVER fire for corridor jobs.
    expect(releaseEscrowSpy).not.toHaveBeenCalled()
    // Money leg routed via the server tranche release (per eligible tranche).
    expect(bridgeSpy).toHaveBeenCalledTimes(eligible.length)
    for (const call of bridgeSpy.mock.calls) {
      expect(call[1]).toBe(plan.id)
      expect(call[4]).toBeUndefined() // non-split: no ratio
    }
  })

  it('resolve release with missing providerRef does not throw and settles on sync release', async () => {
    const jobId = 'job-c1-release-2'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed') // no providerRef — prod corridor shape
    const dispute = seedDispute(jobId, 'under_review')

    mockServerRelease(plan.id)

    const result = await resolveDisputeWorkflow(dispute.id, 'release')

    expect(result?.status).toBe('resolved')
    expect(result?.settlementStatus).toBe('settled')

    // Canonical payment flipped only AFTER the bridge confirmed.
    const payment = getPaymentRepository().getByJobId(jobId)
    expect(payment?.state).toBe('released')
    expect(getJobById(jobId)?.status).toBe('completed')
  })

  it('resolve release async corridor (release_pending) → payment un-released, settlement pending, job not completed', async () => {
    const jobId = 'job-c1-release-async'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    mockServerRelease(plan.id, 'release_pending')

    const result = await resolveDisputeWorkflow(dispute.id, 'release')

    // Payout is in flight — the payout.paid webhook settles authoritatively.
    expect(releaseEscrowSpy).not.toHaveBeenCalled()
    expect(result?.status).toBe('resolved')
    expect(result?.settlementStatus).not.toBe('settled')

    const payment = getPaymentRepository().getByJobId(jobId)
    expect(payment?.state).toBe('disputed')

    const job = getJobById(jobId)
    expect(job?.status).not.toBe('completed')
    expect(job?.paymentReleasedAt).toBeUndefined()
  })

  it('resolve reject → routed via tranche release, settles on sync release', async () => {
    const jobId = 'job-c1-reject-1'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const bridgeSpy = mockServerRelease(plan.id)

    const result = await resolveDisputeWorkflow(dispute.id, 'reject')

    expect(releaseEscrowSpy).not.toHaveBeenCalled()
    expect(bridgeSpy).toHaveBeenCalled()
    expect(result?.decision).toBe('reject')
    expect(result?.settlementStatus).toBe('settled')
    expect(getPaymentRepository().getByJobId(jobId)?.state).toBe('released')
  })

  it('resolve split → customer refund via plan funding PI BEFORE bridge, no capture call', async () => {
    const jobId = 'job-c1-split-1'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const bridgeSpy = mockServerRelease(plan.id)

    const result = await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(releaseEscrowSpy).not.toHaveBeenCalled()

    // Customer-share refund leg: exact share, addressed by the plan's funding
    // PI (corridor payments have no providerRef to fall back on).
    expect(refundEscrowSpy).toHaveBeenCalledTimes(1)
    expect(refundEscrowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowId: FUNDING_PI,
        amount: 300, // 1000 × (1 − 0.7)
        disputeId: dispute.id,
      }),
    )

    // Refund leg runs BEFORE any bridge call (fail-closed ordering).
    expect(refundEscrowSpy.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeSpy.mock.invocationCallOrder[0],
    )

    for (const call of bridgeSpy.mock.calls) {
      expect(call[4]).toBe(0.7)
    }
    expect(result?.settlementStatus).toBe('settled')
  })

  it('resolve split with failed customer refund → bridge NOT invoked, settlement pending (fail-closed)', async () => {
    const jobId = 'job-c1-split-refund-fail'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    refundEscrowSpy.mockRejectedValue(new Error('Stripe backend error (502)'))
    const bridgeSpy = mockServerRelease(plan.id)

    const result = await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    // No payout signal may fire when the customer refund is unconfirmed.
    expect(bridgeSpy).not.toHaveBeenCalled()
    expect(result?.settlementStatus).not.toBe('settled')
    expect(getPaymentRepository().getByJobId(jobId)?.state).toBe('disputed')
  })

  it('non-dispute release (Accept & Release money leg) → bridge instead of capture; sync release completes job', async () => {
    const jobId = 'job-c1-accept-1'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId, { paymentState: 'release_pending' })
    seedPayment(jobId, 'release_pending')

    const bridgeSpy = mockServerRelease(plan.id)

    const { payment, bridgeFullySucceeded } = await releaseEscrowWorkflow(
      jobId, undefined, undefined, 'customer',
    )

    expect(releaseEscrowSpy).not.toHaveBeenCalled()
    expect(bridgeSpy).toHaveBeenCalled()
    expect(bridgeFullySucceeded).toBe(true)
    expect(payment?.state).toBe('released')
    expect(getJobById(jobId)?.status).toBe('completed')
    expect(getJobById(jobId)?.paymentReleasedAt).toBeDefined()
  })

  it('non-dispute release async corridor → payment un-released, stamp deferred', async () => {
    const jobId = 'job-c1-accept-async'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId, { paymentState: 'release_pending' })
    seedPayment(jobId, 'release_pending')

    mockServerRelease(plan.id, 'release_pending')

    const { payment, bridgeFullySucceeded } = await releaseEscrowWorkflow(
      jobId, undefined, undefined, 'customer',
    )

    expect(bridgeFullySucceeded).toBe(false)
    expect(payment?.state).toBe('release_pending')

    const job = getJobById(jobId)
    expect(job?.status).toBe('waiting_payment')
    expect(job?.paymentReleasedAt).toBeUndefined()
  })

  it('legacy job (no escrow plan) keeps the provider capture as the complete release', async () => {
    const jobId = 'job-c1-legacy-1'
    // NO escrow plan for this job.
    seedJob(jobId, { paymentState: 'release_pending' })
    seedPayment(jobId, 'release_pending')

    const bridgeSpy = vi.spyOn(releaseClient, 'requestServerTrancheRelease')

    const { payment, bridgeFullySucceeded } = await releaseEscrowWorkflow(
      jobId, undefined, undefined, 'customer',
    )

    expect(releaseEscrowSpy).toHaveBeenCalledTimes(1)
    expect(bridgeSpy).not.toHaveBeenCalled()
    expect(bridgeFullySucceeded).toBe(true)
    expect(payment?.state).toBe('released')
    expect(getJobById(jobId)?.status).toBe('completed')
  })
})
