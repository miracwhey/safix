/**
 * Split resolution tests
 *
 * Validates the full payment lifecycle when a dispute is resolved with a split
 * decision: the escrow is captured (released) and the customer's share is
 * partially refunded.  Both ledger entries must be present and the payment must
 * end in the 'released' state (not 'refunded').
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { resolveDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'
import { MockProvider } from '../../src/lib/payments/providers/MockProvider'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

describe('Split Resolution', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('payment transitions to released (not refunded) after split', async () => {
    seedPayment('job-s1', 'disputed')
    const dispute = seedDispute('job-s1', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    const payment = getPaymentRepository().getByJobId('job-s1')
    expect(payment?.state).toBe('released')
  })

  it('dispute status becomes resolved with decision=split', async () => {
    seedPayment('job-s2', 'disputed')
    const dispute = seedDispute('job-s2', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.6)

    const updated = getDisputeRepository().getByJobId('job-s2')
    expect(updated?.status).toBe('resolved')
    expect(updated?.decision).toBe('split')
    expect(updated?.resolutionType).toBe('split')
    expect(updated?.splitRatio).toBe(0.6)
  })

  it('creates dispute_resolved_release ledger entry for craftsman share', async () => {
    seedPayment('job-s3', 'disputed')
    const dispute = seedDispute('job-s3', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    const entries = getLedgerRepository().getForJob('job-s3')
    const releaseEntry = entries.find((e) => e.type === 'dispute_resolved_release')
    expect(releaseEntry).toBeDefined()
    // Craftsman net = 70 % * 91 % of 1000 = 637 (9 % default fee, no commercialOrigin)
    expect(releaseEntry!.amount).toBeCloseTo(637, 0)
    expect(releaseEntry!.disputeId).toBe('dispute-job-s3')
  })

  it('creates dispute_resolved_refund ledger entry for customer share', async () => {
    seedPayment('job-s4', 'disputed')
    const dispute = seedDispute('job-s4', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    const entries = getLedgerRepository().getForJob('job-s4')
    const refundEntry = entries.find((e) => e.type === 'dispute_resolved_refund')
    expect(refundEntry).toBeDefined()
    // Customer refund = 30% of 1000 = 300
    expect(refundEntry!.amount).toBeCloseTo(300, 0)
    expect(refundEntry!.disputeId).toBe('dispute-job-s4')
  })

  it('creates platform_fee ledger entry proportional to craftsman share', async () => {
    seedPayment('job-s5', 'disputed')
    const dispute = seedDispute('job-s5', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    const entries = getLedgerRepository().getForJob('job-s5')
    const feeEntry = entries.find((e) => e.type === 'platform_fee')
    expect(feeEntry).toBeDefined()
    // Platform fee = 70% * 9% of 1000 = 63 (9 % default fee, no commercialOrigin)
    expect(feeEntry!.amount).toBeCloseTo(63, 0)
  })

  it('split ledger entries sum to totalAmount', async () => {
    seedPayment('job-s6', 'disputed')
    const dispute = seedDispute('job-s6', 'under_review')
    const totalAmount = 1000

    await resolveDisputeWorkflow(dispute.id, 'split', 0.6)

    const entries = getLedgerRepository().getForJob('job-s6')
    const releaseEntry = entries.find((e) => e.type === 'dispute_resolved_release')
    const refundEntry = entries.find((e) => e.type === 'dispute_resolved_refund')
    const feeEntry = entries.find((e) => e.type === 'platform_fee')

    expect(releaseEntry).toBeDefined()
    expect(refundEntry).toBeDefined()
    expect(feeEntry).toBeDefined()

    // dispute_resolved_release + platform_fee + dispute_resolved_refund = totalAmount
    const sum = releaseEntry!.amount + feeEntry!.amount + refundEntry!.amount
    expect(sum).toBeCloseTo(totalAmount, 1)
  })

  it('defaults to 50/50 split when no ratio is given', async () => {
    seedPayment('job-s7', 'disputed')
    const dispute = seedDispute('job-s7', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split')

    const updated = getDisputeRepository().getByJobId('job-s7')
    expect(updated?.splitRatio).toBe(0.5)

    const payment = getPaymentRepository().getByJobId('job-s7')
    expect(payment?.state).toBe('released')
  })

  it('full release creates payout entry (not split entries)', async () => {
    seedPayment('job-s8', 'disputed')
    const dispute = seedDispute('job-s8', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'release')

    const entries = getLedgerRepository().getForJob('job-s8')
    const types = entries.map((e) => e.type)

    // Full release via dispute → dispute_resolved_release, NOT dispute_resolved_refund
    expect(types).toContain('dispute_resolved_release')
    expect(types).not.toContain('dispute_resolved_refund')

    const payment = getPaymentRepository().getByJobId('job-s8')
    expect(payment?.state).toBe('released')
  })

  it('payment advances to released even when split partial refund fails (Bug #5)', async () => {
    // Simulate a transient refundEscrow failure by spying on the mock provider.
    const mockProvider = new MockProvider()
    vi.spyOn(mockProvider, 'refundEscrow').mockRejectedValueOnce(new Error('network error'))
    // Inject the spy-wrapped provider via the module's providers map.
    const providerModule = await import('../../src/lib/payments/providers/registry')
    vi.spyOn(providerModule, 'getPaymentProvider').mockReturnValueOnce(mockProvider)

    seedPayment('job-s9', 'disputed')
    const dispute = seedDispute('job-s9', 'under_review')

    // Must NOT throw even though refundEscrow rejects.
    await expect(resolveDisputeWorkflow(dispute.id, 'split', 0.7)).resolves.not.toThrow()

    // Payment must still advance to 'released' — the capture outcome is recorded.
    const payment = getPaymentRepository().getByJobId('job-s9')
    expect(payment?.state).toBe('released')

    vi.restoreAllMocks()
  })
})
