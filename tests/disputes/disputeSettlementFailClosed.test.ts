/**
 * A3: Dispute settlement fail-closed contract
 *
 * A dispute may only reach settlementStatus='settled' when ALL required money
 * movements fully succeeded.  Bridge failure (SPLIT_PROVIDER_QUOTA_EXHAUSTED)
 * or refund failure must leave the dispute in settlementStatus='pending' so
 * the operator can reconcile.
 */

// vi.mock is hoisted above imports by Vitest
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../src/lib/workflow/paymentWorkflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/workflow/paymentWorkflow')>()
  return {
    ...actual,
    releaseEscrowWorkflow: vi.fn(),
    refundEscrowWorkflow: vi.fn(),
  }
})

vi.mock('../../src/lib/disputes/disputesService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/disputes/disputesService')>()
  return {
    ...actual,
    settleDispute: vi.fn(),
  }
})

vi.mock('../../src/lib/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/jobs')>()
  return {
    ...actual,
    updateJobDisputeStatus: vi.fn(),
  }
})

vi.mock('../../src/lib/disputes/disputeTimeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/disputes/disputeTimeline')>()
  return {
    ...actual,
    emitDisputeResolvedEvent: vi.fn(),
    emitDisputeResolvedWithDecision: vi.fn(),
  }
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as observability from '../../src/lib/observability'
import * as paymentWorkflow from '../../src/lib/workflow/paymentWorkflow'
import * as disputesService from '../../src/lib/disputes/disputesService'
import * as jobs from '../../src/lib/jobs'
import * as disputeTimeline from '../../src/lib/disputes/disputeTimeline'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  resolveDisputeWorkflow,
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import type { Dispute } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedJob(id: string): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status: 'waiting_payment',
    amount: '1.000 €',
    description: 'Test job description',
    paymentState: 'disputed',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state: 'disputed',
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

function seedDispute(jobId: string): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status: 'under_review',
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

function mockPayment(jobId: string): Payment {
  return {
    id: `pay-${jobId}`,
    jobId,
    state: 'released',
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Split path: bridge failure (SPLIT_PROVIDER_QUOTA_EXHAUSTED)
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – bridge failure → fail-closed', () => {
  it('does not call settleDispute when bridge fails (SPLIT_PROVIDER_QUOTA_EXHAUSTED)', async () => {
    seedJob('job-a3-s1')
    seedPayment('job-a3-s1')
    const dispute = seedDispute('job-a3-s1')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-s1'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('logs logError with SPLIT_PROVIDER_QUOTA_EXHAUSTED when bridge fails', async () => {
    seedJob('job-a3-s2')
    seedPayment('job-a3-s2')
    const dispute = seedDispute('job-a3-s2')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-s2'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.split_settlement_failed',
      undefined,
      expect.objectContaining({
        jobId: 'job-a3-s2',
        disputeId: dispute.id,
        failedStep: 'bridge_partial_failure',
        errorCode: 'DISPUTE_SPLIT_BRIDGE_FAILED',
      })
    )
  })

  it('dispute remains resolved_split but settlementStatus stays pending after bridge failure', async () => {
    seedJob('job-a3-s3')
    seedPayment('job-a3-s3')
    const dispute = seedDispute('job-a3-s3')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-s3'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    const result = await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(result?.status).toBe('resolved')
    expect(result?.settlementStatus).not.toBe('settled')
  })
})

// ---------------------------------------------------------------------------
// Split path: payment not found → fail-closed
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – payment release fails → fail-closed', () => {
  it('does not call settleDispute when releaseEscrowWorkflow returns no payment', async () => {
    seedJob('job-a3-s4')
    seedPayment('job-a3-s4')
    const dispute = seedDispute('job-a3-s4')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: undefined,
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('logs logError with RELEASE_PAYMENT_NOT_FOUND when release returns no payment', async () => {
    seedJob('job-a3-s5')
    seedPayment('job-a3-s5')
    const dispute = seedDispute('job-a3-s5')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: undefined,
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.split_settlement_failed',
      undefined,
      expect.objectContaining({
        errorCode: 'RELEASE_PAYMENT_NOT_FOUND',
        failedStep: 'release_payment_not_found',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Split path: both money movements succeed → settle
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – full success → settled', () => {
  it('calls settleDispute when both payment and bridge succeed', async () => {
    seedJob('job-a3-s6')
    seedPayment('job-a3-s6')
    const dispute = seedDispute('job-a3-s6')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-s6'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-a3-s6')
  })

  it('does not log settlement error when both succeed', async () => {
    seedJob('job-a3-s7')
    seedPayment('job-a3-s7')
    const dispute = seedDispute('job-a3-s7')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-s7'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(observability.logError).not.toHaveBeenCalledWith(
      'workflow.dispute.split_settlement_failed',
      expect.anything(),
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// Release path: bridge failure → fail-closed
// ---------------------------------------------------------------------------

describe('resolveDisputeReleaseWorkflow – bridge failure → fail-closed', () => {
  it('does not call settleDispute when release bridge fails', async () => {
    seedJob('job-a3-r1')
    seedPayment('job-a3-r1')
    seedDispute('job-a3-r1')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-r1'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-r1')

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('logs logError with RELEASE_BRIDGE_FAILED when release bridge fails', async () => {
    seedJob('job-a3-r2')
    seedPayment('job-a3-r2')
    seedDispute('job-a3-r2')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-r2'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-r2')

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.resolve_release_settlement_bridge_failed',
      undefined,
      expect.objectContaining({
        jobId: 'job-a3-r2',
        failedStep: 'release_bridge',
        errorCode: 'RELEASE_BRIDGE_FAILED',
      })
    )
  })

  it('calls settleDispute when release bridge succeeds', async () => {
    seedJob('job-a3-r3')
    seedPayment('job-a3-r3')
    seedDispute('job-a3-r3')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-r3'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-r3')

    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-a3-r3')
  })
})

// ---------------------------------------------------------------------------
// Refund path: refund failure → fail-closed
// ---------------------------------------------------------------------------

describe('resolveDisputeRefundWorkflow – refund failure → fail-closed', () => {
  it('does not call settleDispute when refund returns no payment', async () => {
    seedJob('job-a3-rf1')
    seedPayment('job-a3-rf1')
    seedDispute('job-a3-rf1')

    vi.mocked(paymentWorkflow.refundEscrowWorkflow).mockResolvedValue(undefined)

    await resolveDisputeRefundWorkflow('job-a3-rf1')

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('logs logError with REFUND_BLOCKED when refund fails', async () => {
    seedJob('job-a3-rf2')
    seedPayment('job-a3-rf2')
    seedDispute('job-a3-rf2')

    vi.mocked(paymentWorkflow.refundEscrowWorkflow).mockResolvedValue(undefined)

    await resolveDisputeRefundWorkflow('job-a3-rf2')

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.refund_settlement_failed',
      undefined,
      expect.objectContaining({
        jobId: 'job-a3-rf2',
        failedStep: 'refund_failed',
        errorCode: 'REFUND_BLOCKED',
      })
    )
  })

  it('calls settleDispute when refund succeeds', async () => {
    seedJob('job-a3-rf3')
    seedPayment('job-a3-rf3')
    seedDispute('job-a3-rf3')

    vi.mocked(paymentWorkflow.refundEscrowWorkflow).mockResolvedValue(mockPayment('job-a3-rf3'))

    await resolveDisputeRefundWorkflow('job-a3-rf3')

    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-a3-rf3')
  })
})

// ---------------------------------------------------------------------------
// Idempotent: already settled → returns settled dispute immediately
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – idempotent already settled', () => {
  it('returns settled dispute immediately without re-calling settleDispute', async () => {
    seedJob('job-a3-idem')
    seedPayment('job-a3-idem')
    const dispute: Dispute = {
      id: 'dispute-job-a3-idem',
      jobId: 'job-a3-idem',
      paymentId: 'pay-job-a3-idem',
      status: 'resolved',
      settlementStatus: 'settled',
      splitRatio: 0.7,
      decision: 'split',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(dispute)

    const result = await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(result?.settlementStatus).toBe('settled')
    expect(paymentWorkflow.releaseEscrowWorkflow).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Job-level mirror gating: resolved_* status and events must NOT fire on failure
// ---------------------------------------------------------------------------

describe('resolveDisputeReleaseWorkflow – job mirror not set when bridge fails', () => {
  it('does not call updateJobDisputeStatus with resolved_release when bridge fails', async () => {
    seedJob('job-a3-mirror-r1')
    seedPayment('job-a3-mirror-r1')
    seedDispute('job-a3-mirror-r1')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-mirror-r1'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-mirror-r1')

    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-a3-mirror-r1', 'resolved')
  })

  it('does not emit emitDisputeResolvedEvent when bridge fails', async () => {
    seedJob('job-a3-mirror-r2')
    seedPayment('job-a3-mirror-r2')
    seedDispute('job-a3-mirror-r2')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-mirror-r2'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-mirror-r2')

    expect(disputeTimeline.emitDisputeResolvedEvent).not.toHaveBeenCalled()
    expect(disputeTimeline.emitDisputeResolvedWithDecision).not.toHaveBeenCalledWith('job-a3-mirror-r2', 'release')
  })

  it('calls updateJobDisputeStatus with resolved_release and emits event on success', async () => {
    seedJob('job-a3-mirror-r3')
    seedPayment('job-a3-mirror-r3')
    seedDispute('job-a3-mirror-r3')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-mirror-r3'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-mirror-r3')

    expect(jobs.updateJobDisputeStatus).toHaveBeenCalledWith('job-a3-mirror-r3', 'resolved')
    expect(disputeTimeline.emitDisputeResolvedEvent).toHaveBeenCalledWith('job-a3-mirror-r3')
  })
})

describe('resolveDisputeRefundWorkflow – job mirror not set when refund fails', () => {
  it('does not call updateJobDisputeStatus with resolved_refund when refund fails', async () => {
    seedJob('job-a3-mirror-rf1')
    seedPayment('job-a3-mirror-rf1')
    seedDispute('job-a3-mirror-rf1')

    vi.mocked(paymentWorkflow.refundEscrowWorkflow).mockResolvedValue(undefined)

    await resolveDisputeRefundWorkflow('job-a3-mirror-rf1')

    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-a3-mirror-rf1', 'resolved')
  })

  it('does not emit emitDisputeResolvedEvent when refund fails', async () => {
    seedJob('job-a3-mirror-rf2')
    seedPayment('job-a3-mirror-rf2')
    seedDispute('job-a3-mirror-rf2')

    vi.mocked(paymentWorkflow.refundEscrowWorkflow).mockResolvedValue(undefined)

    await resolveDisputeRefundWorkflow('job-a3-mirror-rf2')

    expect(disputeTimeline.emitDisputeResolvedEvent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Retry: released-but-bridge-failed → bridge must be retried or remain false
// ---------------------------------------------------------------------------

describe('resolveDisputeReleaseWorkflow – retry after bridge failure', () => {
  it('retry with bridge still failing: settleDispute still not called', async () => {
    seedJob('job-a3-retry1')
    seedPayment('job-a3-retry1')
    // Simulate dispute already decided (resolved+release) but not yet settled (retry path)
    const retryDispute: Dispute = {
      id: 'dispute-job-a3-retry1',
      jobId: 'job-a3-retry1',
      paymentId: 'pay-job-a3-retry1',
      status: 'resolved',
      decision: 'release',
      resolutionType: 'release_full',
      settlementStatus: 'pending',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(retryDispute)

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-retry1'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-retry1')

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-a3-retry1', 'resolved')
  })

  it('retry with bridge now succeeding: settleDispute IS called and job mirror set', async () => {
    seedJob('job-a3-retry2')
    seedPayment('job-a3-retry2')
    const retryDispute: Dispute = {
      id: 'dispute-job-a3-retry2',
      jobId: 'job-a3-retry2',
      paymentId: 'pay-job-a3-retry2',
      status: 'resolved',
      decision: 'release',
      resolutionType: 'release_full',
      settlementStatus: 'pending',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(retryDispute)

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-retry2'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeReleaseWorkflow('job-a3-retry2')

    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-a3-retry2')
    expect(jobs.updateJobDisputeStatus).toHaveBeenCalledWith('job-a3-retry2', 'resolved')
  })
})

// ---------------------------------------------------------------------------
// Fix 1: Persisted split ratio — retry must use stored ratio, not parameter
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – persisted ratio is source of truth on retry', () => {
  function seedRetryDispute(id: string, storedRatio: number): Dispute {
    const d: Dispute = {
      id: `dispute-${id}`,
      jobId: id,
      paymentId: `pay-${id}`,
      status: 'resolved',
      settlementStatus: 'pending',
      splitRatio: storedRatio,
      decision: 'split',
      resolutionType: 'split',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(d)
    return d
  }

  it('retry with different parameter 0.5 → releaseEscrowWorkflow called with stored 0.7', async () => {
    seedJob('job-ratio-r1')
    seedPayment('job-ratio-r1')
    const dispute = seedRetryDispute('job-ratio-r1', 0.7)

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-ratio-r1'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.5)

    expect(paymentWorkflow.releaseEscrowWorkflow).toHaveBeenCalledWith(
      'job-ratio-r1',
      dispute.id,
      0.7,
      'operator',
    )
  })

  it('retry without parameter → releaseEscrowWorkflow called with stored 0.7, not default 0.5', async () => {
    seedJob('job-ratio-r2')
    seedPayment('job-ratio-r2')
    const dispute = seedRetryDispute('job-ratio-r2', 0.7)

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-ratio-r2'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split')

    expect(paymentWorkflow.releaseEscrowWorkflow).toHaveBeenCalledWith(
      'job-ratio-r2',
      dispute.id,
      0.7,
      'operator',
    )
  })

  it('retry with no stored splitRatio → fail-closed, settleDispute not called', async () => {
    seedJob('job-ratio-r3')
    seedPayment('job-ratio-r3')
    // Dispute at resolved+split but splitRatio not stored (data integrity issue)
    const noRatioDispute: Dispute = {
      id: 'dispute-job-ratio-r3',
      jobId: 'job-ratio-r3',
      paymentId: 'pay-job-ratio-r3',
      status: 'resolved',
      decision: 'split',
      resolutionType: 'split',
      settlementStatus: 'pending',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(noRatioDispute)

    await resolveDisputeWorkflow(noRatioDispute.id, 'split', 0.7)

    expect(paymentWorkflow.releaseEscrowWorkflow).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('retry with no stored splitRatio → logs PERSISTED_RATIO_INVALID', async () => {
    seedJob('job-ratio-r4')
    seedPayment('job-ratio-r4')
    const noRatioDispute: Dispute = {
      id: 'dispute-job-ratio-r4',
      jobId: 'job-ratio-r4',
      paymentId: 'pay-job-ratio-r4',
      status: 'resolved',
      decision: 'split',
      resolutionType: 'split',
      settlementStatus: 'pending',
      settlementStatus: undefined,
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test dispute description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    getDisputeRepository().add(noRatioDispute)

    await resolveDisputeWorkflow(noRatioDispute.id, 'split', 0.7)

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.split_retry_missing_persisted_ratio',
      undefined,
      expect.objectContaining({
        jobId: 'job-ratio-r4',
        errorCode: 'PERSISTED_RATIO_INVALID',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Fix 2: Refund completion — settleDispute gated on refundFullySucceeded
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – refund failure → fail-closed', () => {
  it('does not call settleDispute when refundFullySucceeded=false even if bridge succeeds', async () => {
    seedJob('job-a3-ref1')
    seedPayment('job-a3-ref1')
    const dispute = seedDispute('job-a3-ref1')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-ref1'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: false,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('logs SPLIT_REFUND_FAILED when refund fails', async () => {
    seedJob('job-a3-ref2')
    seedPayment('job-a3-ref2')
    const dispute = seedDispute('job-a3-ref2')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-ref2'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: false,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.split_settlement_failed',
      undefined,
      expect.objectContaining({
        jobId: 'job-a3-ref2',
        failedStep: 'refund_partial_failure',
        errorCode: 'SPLIT_REFUND_FAILED',
      }),
    )
  })

  it('does not call updateJobDisputeStatus with resolved_split when refund fails', async () => {
    seedJob('job-a3-ref3')
    seedPayment('job-a3-ref3')
    const dispute = seedDispute('job-a3-ref3')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-ref3'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: false,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-a3-ref3', 'resolved')
  })

  it('settles when refund and bridge both succeed', async () => {
    seedJob('job-a3-ref4')
    seedPayment('job-a3-ref4')
    const dispute = seedDispute('job-a3-ref4')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-a3-ref4'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-a3-ref4')
    expect(jobs.updateJobDisputeStatus).toHaveBeenCalledWith('job-a3-ref4', 'resolved')
  })
})
