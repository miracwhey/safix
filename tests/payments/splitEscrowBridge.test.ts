/**
 * Split Escrow Bridge Tests
 *
 * Validates that dispute split resolution actually triggers the escrow bridge
 * (requestServerTrancheRelease) with the correct splitRatio, instead of
 * skipping the bridge and leaving tranches in eligible_for_release.
 *
 * Also validates that non-split (full release) continues to work.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { resolveDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import * as releaseClient from '../../src/lib/payments/releaseClient'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
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

async function setupFundedEscrowPlan(jobId: string) {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    customerUserId: `cust-${jobId}`,
    providerId: `prov-${jobId}`,
    totalAmount: 1000,
  })
  await confirmFunding(plan.id)
  await recordWorkStarted(plan.id, 'provider')
  await recordWorkCompleted(plan.id, 'provider')
  return plan
}

function mockServerRelease(planId: string) {
  return vi.spyOn(releaseClient, 'requestServerTrancheRelease').mockResolvedValue({
    ok: true,
    data: {
      status: 'released',
      trancheId: 'mock-tranche',
      planId,
      planStatus: 'fully_released',
      releasedAt: new Date().toISOString(),
      externalReleaseRef: 'tr_mock_123',
    },
  })
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Split Escrow Bridge', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('split resolution invokes requestServerTrancheRelease with splitRatio', async () => {
    const jobId = 'job-bridge-split-1'
    const plan = await setupFundedEscrowPlan(jobId)

    // Verify tranches are eligible
    const tranches = getEscrowTranches(plan.id)
    const eligible = tranches.filter((t) => t.status === 'eligible_for_release')
    expect(eligible.length).toBeGreaterThanOrEqual(1)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const spy = mockServerRelease(plan.id)

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    // Bridge must have been called for each eligible tranche with splitRatio
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls.length).toBe(eligible.length)
    for (const call of spy.mock.calls) {
      // Args: (trancheId, planId, actor, externalReleaseRef, splitRatio)
      expect(call[1]).toBe(plan.id)
      expect(call[4]).toBe(0.7)
    }

    spy.mockRestore()
  })

  it('full (non-split) release invokes bridge WITHOUT splitRatio', async () => {
    const jobId = 'job-bridge-full-1'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const spy = mockServerRelease(plan.id)

    await resolveDisputeWorkflow(dispute.id, 'release')

    expect(spy).toHaveBeenCalled()
    for (const call of spy.mock.calls) {
      // 5th arg (splitRatio) must be undefined for non-split
      expect(call[4]).toBeUndefined()
    }

    spy.mockRestore()
  })

  it('split with 50/50 default ratio invokes bridge with 0.5', async () => {
    const jobId = 'job-bridge-split-default'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const spy = mockServerRelease(plan.id)

    // No explicit ratio → defaults to 0.5
    await resolveDisputeWorkflow(dispute.id, 'split')

    expect(spy).toHaveBeenCalled()
    for (const call of spy.mock.calls) {
      expect(call[4]).toBe(0.5)
    }

    spy.mockRestore()
  })

  it('payment reaches released state after split with bridge', async () => {
    const jobId = 'job-bridge-split-state'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const spy = mockServerRelease(plan.id)

    await resolveDisputeWorkflow(dispute.id, 'split', 0.6)

    const payment = getPaymentRepository().getByJobId(jobId)
    expect(payment?.state).toBe('released')

    spy.mockRestore()
  })

  it('dispute settlement completes after split bridge succeeds', async () => {
    const jobId = 'job-bridge-split-settle'
    const plan = await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    const spy = mockServerRelease(plan.id)

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    const updated = getDisputeRepository().getByJobId(jobId)
    expect(updated?.status).toBe('resolved')
    expect(updated?.decision).toBe('split')
    expect(updated?.settlementStatus).toBe('settled')

    spy.mockRestore()
  })

  it('bridge failure leaves the corridor payment un-released and settlement pending (fail-closed)', async () => {
    const jobId = 'job-bridge-split-fail'
    await setupFundedEscrowPlan(jobId)

    seedJob(jobId)
    seedPayment(jobId, 'disputed')
    const dispute = seedDispute(jobId, 'under_review')

    // Mock bridge failure
    const spy = vi.spyOn(releaseClient, 'requestServerTrancheRelease').mockResolvedValue({
      ok: false,
      message: 'Simulated server error',
      statusCode: 502,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    // Corridor (C1): there is NO capture-first — the bridge IS the money
    // movement. A failed bridge must leave the canonical payment un-released
    // and the dispute settlement pending for retry/webhook reconciliation.
    const payment = getPaymentRepository().getByJobId(jobId)
    expect(payment?.state).toBe('disputed')

    const updated = getDisputeRepository().getByJobId(jobId)
    expect(updated?.status).toBe('resolved')
    expect(updated?.settlementStatus).not.toBe('settled')

    spy.mockRestore()
  })
})
