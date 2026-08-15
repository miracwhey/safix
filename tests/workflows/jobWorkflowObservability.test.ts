/**
 * Job workflow observability coverage.
 *
 * Verifies that the lifecycle milestone events and invalid-state guard paths in
 * jobWorkflow.ts emit the expected structured observability events so that
 * production failures and milestones are visible in Sentry/logging.
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
import { installSessionForJobOwner, installSessionForJobCustomer } from '../helpers/mockSession'
import {
  startJobWorkflow,
  markWorkCompleteWorkflow,
  customerReleasePaymentWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status: 'new',
    amount: '1.000 €',
    description: 'Test job description',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'cust-jwobs',
    craftsmanUserId: 'craft-jwobs',
    ...overrides,
  }
  // Block 7.2.1b: tests that seed `workCompletedAt` directly are simulating
  // a job that has already passed admin-confirm; mirror the new stamps so
  // `customerReleasePaymentWorkflow` sees a confirmed completion.
  if (job.workCompletedAt && !job.workConfirmedCompleteAt) {
    job.workMarkedCompleteAt = job.workMarkedCompleteAt ?? job.workCompletedAt
    job.workConfirmedCompleteAt = job.workCompletedAt
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
  installSessionForJobOwner({ craftsmanUserId: 'craft-jwobs' })
})

// ---------------------------------------------------------------------------
// startJobWorkflow – logWarning on invalid job state
// ---------------------------------------------------------------------------

describe('startJobWorkflow – observability: invalid state guard', () => {
  it('emits logWarning with event workflow.job.invalid_state when job is in waiting_payment', async () => {
    seedJob('job-jws1', { status: 'waiting_payment' })

    await startJobWorkflow('job-jws1')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.job.invalid_state',
      expect.objectContaining({ jobId: 'job-jws1' })
    )
  })

  it('includes status and expectedStatus in the warning context', async () => {
    seedJob('job-jws2', { status: 'waiting_payment' })

    await startJobWorkflow('job-jws2')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.job.invalid_state',
      expect.objectContaining({
        jobId: 'job-jws2',
        status: 'waiting_payment',
        expectedStatus: 'new|scheduled|booked',
      })
    )
  })

  it('emits logWarning when job is already completed', async () => {
    seedJob('job-jws3', { status: 'completed' })

    await startJobWorkflow('job-jws3')

    expect(observability.logWarning).toHaveBeenCalledWith(
      'workflow.job.invalid_state',
      expect.objectContaining({ jobId: 'job-jws3', status: 'completed' })
    )
  })

  it('does not emit logWarning when job is in new status (valid start)', async () => {
    seedJob('job-jws4', { status: 'new' })
    // Payment must be in_escrow so the work_in_progress transition is valid
    seedPayment('job-jws4', 'in_escrow')

    await startJobWorkflow('job-jws4')

    // The specific invalid_state warning must not be emitted on a valid start path.
    // (Other internal warnings from sub-workflows, e.g. scheduling, are unrelated.)
    expect(observability.logWarning).not.toHaveBeenCalledWith(
      'workflow.job.invalid_state',
      expect.anything()
    )
  })

  it('does not emit logWarning when job is in scheduled status (valid start)', async () => {
    seedJob('job-jws5', { status: 'scheduled' })
    // Payment must be in_escrow so the work_in_progress transition is valid
    seedPayment('job-jws5', 'in_escrow')

    await startJobWorkflow('job-jws5')

    expect(observability.logWarning).not.toHaveBeenCalledWith(
      'workflow.job.invalid_state',
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// startJobWorkflow – logInfo on successful start
// ---------------------------------------------------------------------------

describe('startJobWorkflow – observability: lifecycle logInfo', () => {
  it('emits logInfo with event workflow.job.started when job starts from new', async () => {
    seedJob('job-jwi1', { status: 'new' })
    // Payment must be in_escrow so the work_in_progress transition is valid
    seedPayment('job-jwi1', 'in_escrow')

    await startJobWorkflow('job-jwi1')

    expect(observability.logInfo).toHaveBeenCalledWith(
      'workflow.job.started',
      expect.objectContaining({ jobId: 'job-jwi1' })
    )
  })

  it('emits logInfo with event workflow.job.started when job starts from scheduled', async () => {
    seedJob('job-jwi2', { status: 'scheduled' })
    // Payment must be in_escrow so the work_in_progress transition is valid
    seedPayment('job-jwi2', 'in_escrow')

    await startJobWorkflow('job-jwi2')

    expect(observability.logInfo).toHaveBeenCalledWith(
      'workflow.job.started',
      expect.objectContaining({ jobId: 'job-jwi2' })
    )
  })
})

// ---------------------------------------------------------------------------
// markWorkCompleteWorkflow – logInfo
// ---------------------------------------------------------------------------

describe('markWorkCompleteWorkflow – observability: lifecycle logInfo', () => {
  it('emits logInfo with event workflow.job.admin_confirmed_complete when solo-owner marks complete', async () => {
    seedJob('job-jwc1', { status: 'in_progress' })

    await markWorkCompleteWorkflow('job-jwc1')

    // Owner-session installed in beforeEach → solo-owner shortcut delegates
    // to confirmJobCompletionWorkflow which logs admin_confirmed_complete.
    expect(observability.logInfo).toHaveBeenCalledWith(
      'workflow.job.admin_confirmed_complete',
      expect.objectContaining({ jobId: 'job-jwc1' })
    )
  })

  it('does not emit logInfo for admin_confirmed_complete when job is not in_progress', async () => {
    seedJob('job-jwc2', { status: 'scheduled' })

    await markWorkCompleteWorkflow('job-jwc2')

    expect(observability.logInfo).not.toHaveBeenCalledWith(
      'workflow.job.admin_confirmed_complete',
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// customerReleasePaymentWorkflow – logInfo
// ---------------------------------------------------------------------------

describe('customerReleasePaymentWorkflow – observability: lifecycle logInfo', () => {
  beforeEach(() => {
    installSessionForJobCustomer({ customerUserId: 'cust-jwobs' })
  })
  it('emits logInfo with event workflow.job.payment_released when payment is released', async () => {
    const now = Date.now()
    seedJob('job-jwr1', {
      status: 'waiting_payment',
      workCompletedAt: now - 1000,
      paymentReleasedAt: undefined,
    })
    seedPayment('job-jwr1', 'release_pending')

    await customerReleasePaymentWorkflow('job-jwr1')

    expect(observability.logInfo).toHaveBeenCalledWith(
      'workflow.job.payment_released',
      expect.objectContaining({ jobId: 'job-jwr1' })
    )
  })

  it('does not emit logInfo for payment_released when workCompletedAt is missing', async () => {
    seedJob('job-jwr2', {
      status: 'waiting_payment',
      workCompletedAt: undefined,
    })
    seedPayment('job-jwr2', 'release_pending')

    await customerReleasePaymentWorkflow('job-jwr2')

    expect(observability.logInfo).not.toHaveBeenCalledWith(
      'workflow.job.payment_released',
      expect.anything()
    )
  })

  it('does not emit logInfo for payment_released when job is not in waiting_payment', async () => {
    const now = Date.now()
    seedJob('job-jwr3', {
      status: 'in_progress',
      workCompletedAt: now - 1000,
    })
    seedPayment('job-jwr3', 'work_in_progress')

    await customerReleasePaymentWorkflow('job-jwr3')

    expect(observability.logInfo).not.toHaveBeenCalledWith(
      'workflow.job.payment_released',
      expect.anything()
    )
  })
})
