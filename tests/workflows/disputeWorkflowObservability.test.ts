/**
 * Dispute workflow observability coverage.
 *
 * Verifies that the invalid-transition guard paths and missing-entity paths in
 * disputeWorkflow.ts emit the expected structured observability events so that
 * production failures are visible in Sentry/logging without relying on trust alone.
 */

// vi.mock is hoisted by Vitest before any imports.
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as observability from '../../src/lib/observability'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  reviewDisputeWorkflow,
  rejectDisputeWorkflow,
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
  resolveDisputeWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
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

function seedDispute(
  jobId: string,
  status: Dispute['status'],
  idOverride?: string
): Dispute {
  const dispute: Dispute = {
    id: idOverride ?? `dispute-${jobId}`,
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
// reviewDisputeWorkflow – logError on invalid transition
// ---------------------------------------------------------------------------

describe('reviewDisputeWorkflow – observability: invalid transition', () => {
  it('emits logError with event workflow.dispute.review_invalid_transition', async () => {
    // under_review → under_review is NOT a valid transition
    const dispute = seedDispute('job-dobs-rv1', 'under_review', 'dispute-rv1')

    await expect(reviewDisputeWorkflow(dispute.id)).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.review_invalid_transition',
      expect.any(Error),
      expect.objectContaining({ disputeId: dispute.id })
    )
  })

  it('includes fromStatus and toStatus in the error context', async () => {
    const dispute = seedDispute('job-dobs-rv2', 'under_review', 'dispute-rv2')

    await expect(reviewDisputeWorkflow(dispute.id)).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.review_invalid_transition',
      expect.any(Error),
      expect.objectContaining({
        disputeId: dispute.id,
        fromStatus: 'under_review',
        toStatus: 'under_review',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// rejectDisputeWorkflow – logError on invalid transition
// ---------------------------------------------------------------------------

describe('rejectDisputeWorkflow – observability: invalid transition', () => {
  it('emits logError with event workflow.dispute.reject_invalid_transition', async () => {
    // open → rejected is NOT a valid transition (open only allows awaiting_evidence, under_review)
    seedJob('job-dobs-rej1', 'waiting_payment')
    const dispute = seedDispute('job-dobs-rej1', 'open')

    await expect(rejectDisputeWorkflow('job-dobs-rej1')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.reject_invalid_transition',
      expect.any(Error),
      expect.objectContaining({ jobId: 'job-dobs-rej1', disputeId: dispute.id })
    )
  })

  it('includes fromStatus and toStatus in the error context', async () => {
    seedJob('job-dobs-rej2', 'waiting_payment')
    const dispute = seedDispute('job-dobs-rej2', 'open')

    await expect(rejectDisputeWorkflow('job-dobs-rej2')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.reject_invalid_transition',
      expect.any(Error),
      expect.objectContaining({
        jobId: 'job-dobs-rej2',
        disputeId: dispute.id,
        fromStatus: 'open',
        toStatus: 'resolved',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// rejectDisputeWorkflow – logWarning when payment not found
// ---------------------------------------------------------------------------

describe('rejectDisputeWorkflow – observability: payment not found', () => {
  it('emits logWarning with event workflow.dispute.reject_release_payment_not_found', async () => {
    // Dispute in under_review (valid for → rejected), but NO payment seeded
    seedJob('job-dobs-rej3', 'waiting_payment')
    const dispute = seedDispute('job-dobs-rej3', 'under_review')

    const result = await rejectDisputeWorkflow('job-dobs-rej3')

    // With persist-first ordering, the dispute IS rejected even though no
    // payment was found — this is the safe direction.
    expect(result).toBeDefined()
    expect(result!.status).toBe('resolved')
    expect(result!.decision).toBe('reject')
    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.dispute.reject_release_payment_not_found',
      expect.objectContaining({ jobId: 'job-dobs-rej3', disputeId: dispute.id })
    )
  })
})

// ---------------------------------------------------------------------------
// resolveDisputeReleaseWorkflow – logError on invalid transition
// ---------------------------------------------------------------------------

describe('resolveDisputeReleaseWorkflow – observability: invalid transition', () => {
  it('emits logError with event workflow.dispute.resolve_release_invalid_transition', async () => {
    // open → resolved_release is NOT a valid transition
    seedJob('job-dobs-rr1', 'waiting_payment')
    seedPayment('job-dobs-rr1', 'disputed')
    const dispute = seedDispute('job-dobs-rr1', 'open')

    await expect(resolveDisputeReleaseWorkflow('job-dobs-rr1')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.resolve_release_invalid_transition',
      expect.any(Error),
      expect.objectContaining({
        jobId: 'job-dobs-rr1',
        disputeId: dispute.id,
        fromStatus: 'open',
        toStatus: 'resolved',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// resolveDisputeRefundWorkflow – logError on invalid transition
// ---------------------------------------------------------------------------

describe('resolveDisputeRefundWorkflow – observability: invalid transition', () => {
  it('emits logError with event workflow.dispute.resolve_refund_invalid_transition', async () => {
    // open → resolved_refund is NOT a valid transition
    seedJob('job-dobs-rrf1', 'waiting_payment')
    seedPayment('job-dobs-rrf1', 'disputed')
    const dispute = seedDispute('job-dobs-rrf1', 'open')

    await expect(resolveDisputeRefundWorkflow('job-dobs-rrf1')).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.resolve_refund_invalid_transition',
      expect.any(Error),
      expect.objectContaining({
        jobId: 'job-dobs-rrf1',
        disputeId: dispute.id,
        fromStatus: 'open',
        toStatus: 'resolved',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// resolveDisputeWorkflow (split) – logError on invalid transition
// ---------------------------------------------------------------------------

describe('resolveDisputeWorkflow split – observability: invalid transition', () => {
  it('emits logError with event workflow.dispute.resolve_split_invalid_transition', async () => {
    // open → resolved_split is NOT a valid transition
    seedJob('job-dobs-split1', 'waiting_payment')
    seedPayment('job-dobs-split1', 'disputed')
    const dispute = seedDispute('job-dobs-split1', 'open', 'dispute-split1')

    await expect(resolveDisputeWorkflow(dispute.id, 'split', 0.5)).rejects.toThrow()

    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.resolve_split_invalid_transition',
      expect.any(Error),
      expect.objectContaining({
        disputeId: dispute.id,
        fromStatus: 'open',
        toStatus: 'resolved',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// resolveDisputeReleaseWorkflow – logWarning when payment not found
// ---------------------------------------------------------------------------

describe('resolveDisputeReleaseWorkflow – observability: payment not found', () => {
  it('emits logWarning with event workflow.dispute.resolve_release_payment_not_found', async () => {
    // Dispute in under_review (valid → resolved_release), but NO payment seeded
    seedJob('job-dobs-rr2', 'waiting_payment')
    const dispute = seedDispute('job-dobs-rr2', 'under_review')

    const result = await resolveDisputeReleaseWorkflow('job-dobs-rr2')

    // With persist-first ordering, the dispute IS resolved even though no
    // payment was found — this is the safe direction.
    expect(result).toBeDefined()
    expect(result!.status).toBe('resolved')
    expect(result!.decision).toBe('release')
    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.dispute.resolve_release_payment_not_found',
      expect.objectContaining({ jobId: 'job-dobs-rr2', disputeId: dispute.id })
    )
  })
})

// ---------------------------------------------------------------------------
// resolveDisputeRefundWorkflow – logWarning when payment not found
// ---------------------------------------------------------------------------

describe('resolveDisputeRefundWorkflow – observability: payment not found', () => {
  it('emits logWarning with event workflow.dispute.resolve_refund_payment_not_found', async () => {
    // Dispute in under_review (valid → resolved_refund), but NO payment seeded
    seedJob('job-dobs-rrf2', 'waiting_payment')
    const dispute = seedDispute('job-dobs-rrf2', 'under_review')

    const result = await resolveDisputeRefundWorkflow('job-dobs-rrf2')

    // With persist-first ordering, the dispute IS resolved even though no
    // payment was found — this is the safe direction.
    expect(result).toBeDefined()
    expect(result!.status).toBe('resolved')
    expect(result!.decision).toBe('refund')
    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.dispute.resolve_refund_payment_not_found',
      expect.objectContaining({ jobId: 'job-dobs-rrf2', disputeId: dispute.id })
    )
  })
})
