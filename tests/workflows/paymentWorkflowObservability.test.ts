/**
 * Payment workflow observability coverage.
 *
 * Verifies that the key guard/failure paths in paymentWorkflow.ts emit the
 * expected structured observability events so that production failures are
 * visible in Sentry/logging without relying on trust alone.
 */

// vi.mock is hoisted by Vitest before any imports, so the mock is in place
// when the workflow modules import from the observability module.
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as observability from '../../src/lib/observability'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedJob(id: string, status: Job['status'] = 'waiting_payment'): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status,
    amount: '1.000 €',
    description: 'Test job description',
    paymentState: 'release_pending',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
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
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// releaseEscrowWorkflow – logError paths
// ---------------------------------------------------------------------------

describe('releaseEscrowWorkflow – observability: blocked by dispute', () => {
  it('emits logError with event workflow.payment.release_blocked_by_dispute', async () => {
    seedJob('job-obs-r1', 'waiting_payment')
    seedPayment('job-obs-r1', 'disputed')
    seedDispute('job-obs-r1', 'open')

    await expect(releaseEscrowWorkflow('job-obs-r1')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.payment.release_blocked_by_dispute',
      expect.any(Error),
      expect.objectContaining({ jobId: 'job-obs-r1' })
    )
  })

  it('includes disputeId and disputeStatus in the error context', async () => {
    seedJob('job-obs-r2', 'waiting_payment')
    seedPayment('job-obs-r2', 'disputed')
    const dispute = seedDispute('job-obs-r2', 'customer_waiting')

    await expect(releaseEscrowWorkflow('job-obs-r2')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.payment.release_blocked_by_dispute',
      expect.any(Error),
      expect.objectContaining({
        jobId: 'job-obs-r2',
        disputeId: dispute.id,
        disputeStatus: 'customer_waiting',
      })
    )
  })

  it('does not emit logWarning when the error path is taken instead', async () => {
    seedJob('job-obs-r3', 'waiting_payment')
    seedPayment('job-obs-r3', 'disputed')
    seedDispute('job-obs-r3', 'open')

    await expect(releaseEscrowWorkflow('job-obs-r3')).rejects.toThrow()

    expect(observability.logWarning).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// releaseEscrowWorkflow – logWarning paths
// ---------------------------------------------------------------------------

describe('releaseEscrowWorkflow – observability: invalid job status', () => {
  it('emits logWarning with event workflow.payment.release_rejected_invalid_status', async () => {
    seedJob('job-obs-r4', 'in_progress')
    seedPayment('job-obs-r4', 'release_pending')

    await releaseEscrowWorkflow('job-obs-r4')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.payment.release_rejected_invalid_status',
      expect.objectContaining({ jobId: 'job-obs-r4' })
    )
  })

  it('includes jobStatus and expected in the warning context', async () => {
    seedJob('job-obs-r5', 'in_progress')
    seedPayment('job-obs-r5', 'release_pending')

    await releaseEscrowWorkflow('job-obs-r5')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.payment.release_rejected_invalid_status',
      expect.objectContaining({
        jobId: 'job-obs-r5',
        jobStatus: 'in_progress',
        expected: 'waiting_payment',
      })
    )
  })

  it('does not emit logError when only the status guard fires', async () => {
    seedJob('job-obs-r6', 'in_progress')
    seedPayment('job-obs-r6', 'work_in_progress')

    await releaseEscrowWorkflow('job-obs-r6')

    expect(observability.logError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// refundEscrowWorkflow – logWarning paths
// ---------------------------------------------------------------------------

describe('refundEscrowWorkflow – observability: invalid job status', () => {
  it('emits logWarning with event workflow.payment.refund_rejected_invalid_status', async () => {
    seedJob('job-obs-ref1', 'in_progress')
    seedPayment('job-obs-ref1', 'release_pending')

    await refundEscrowWorkflow('job-obs-ref1')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.payment.refund_rejected_invalid_status',
      expect.objectContaining({ jobId: 'job-obs-ref1' })
    )
  })

  it('includes jobStatus and expected in the warning context', async () => {
    seedJob('job-obs-ref2', 'scheduled')
    seedPayment('job-obs-ref2', 'deposit_paid')

    await refundEscrowWorkflow('job-obs-ref2')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.payment.refund_rejected_invalid_status',
      expect.objectContaining({
        jobId: 'job-obs-ref2',
        jobStatus: 'scheduled',
        expected: 'waiting_payment',
      })
    )
  })

  it('does not emit logError when only the status guard fires', async () => {
    seedJob('job-obs-ref3', 'in_progress')
    seedPayment('job-obs-ref3', 'work_in_progress')

    await refundEscrowWorkflow('job-obs-ref3')

    expect(observability.logError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// disputePaymentWorkflow – raisedBy propagation (Bug #2 fix)
// ---------------------------------------------------------------------------

import { disputePaymentWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'

describe('disputePaymentWorkflow – raisedBy propagation', () => {
  it('creates a dispute with the supplied raisedByUserId', async () => {
    const jobId = 'job-dpw-rb-1'
    seedJob(jobId, 'waiting_payment')
    seedPayment(jobId, 'in_escrow')

    await disputePaymentWorkflow(jobId, 'user-craftsman-42')

    const dispute = getDisputeRepository().getByJobId(jobId)
    expect(dispute).toBeDefined()
    expect(dispute?.raisedBy).toBe('user-craftsman-42')
  })

  it('creates a dispute with undefined raisedBy when no userId given', async () => {
    const jobId = 'job-dpw-rb-2'
    seedJob(jobId, 'waiting_payment')
    seedPayment(jobId, 'in_escrow')

    await disputePaymentWorkflow(jobId)

    const dispute = getDisputeRepository().getByJobId(jobId)
    expect(dispute).toBeDefined()
    // raisedBy is optional; it should be absent when not provided
    expect(dispute?.raisedBy).toBeUndefined()
  })
})
