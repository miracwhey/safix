/**
 * Workflow delivery integration tests.
 *
 * Verifies that workflow-level delivery hooks:
 * - target the correct recipient role for each event type
 * - are idempotent (no duplicate emails when a workflow is called twice)
 * - skip delivery gracefully when recipient userId is absent
 *
 * Delivery is mocked at the module boundary so we test the contract between
 * workflows and the delivery service without making real HTTP calls.
 */

// vi.mock must be hoisted before imports
vi.mock('../../src/lib/notifications/delivery/deliveryService', () => ({
  sendProposalReceivedEmail: vi.fn(),
  sendScheduleCreatedEmail: vi.fn(),
  sendScheduleUpdatedEmail: vi.fn(),
  sendWorkCompletedEmail: vi.fn(),
  sendPaymentReleaseRequestedEmail: vi.fn(),
  sendDisputeOpenedEmail: vi.fn(),
  sendDisputeEvidenceRequestedEmail: vi.fn(),
  // Block 3 — payment / payout trust corridor
  sendEscrowLockedEmail: vi.fn(),
  sendPaymentReleasedEmail: vi.fn(),
  sendPayoutHandoffInitiatedEmail: vi.fn(),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner } from '../helpers/mockSession'
import * as delivery from '../../src/lib/notifications/delivery/deliveryService'

import {
  submitProposalWorkflow,
  markWorkCompleteWorkflow,
  startJobWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import {
  scheduleJob,
  updateSchedule,
} from '../../src/lib/workflow/schedulingWorkflow'
import {
  requestReleaseWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import {
  openDisputeWorkflow,
  requestCustomerEvidenceWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'

import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const BASE_START = 1_700_000_000_000
const BASE_END = BASE_START + 2 * 60 * 60 * 1000

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status: 'new',
    amount: '500 €',
    description: 'Test job',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'user-customer-default',
    craftsmanUserId: 'user-craftsman-default',
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state']): void {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
  // Install a craftsman-owner session so RBAC-guarded workflows (scheduleJob,
  // updateSchedule, startJobWorkflow, markWorkCompleteWorkflow) pass the guard.
  // Tests that require a customer session install one inline and restore context.
  installSessionForJobOwner({ craftsmanUserId: 'user-craftsman-default' })
})

// ---------------------------------------------------------------------------
// submitProposalWorkflow
// ---------------------------------------------------------------------------

describe('submitProposalWorkflow delivery', () => {
  it('sends proposal_received to customer on first call', async () => {
    seedJob('job-p1')
    await submitProposalWorkflow('job-p1')

    expect(delivery.sendProposalReceivedEmail).toHaveBeenCalledOnce()
    const call = vi.mocked(delivery.sendProposalReceivedEmail).mock.calls[0]
    expect(call[0]).toBe('job-p1')
    expect(call[1]).toBe('user-customer-default')
    expect(call[2]).toMatchObject({ jobTitle: 'Test Job job-p1' })
  })

  it('does NOT send a second email when called again (idempotent)', async () => {
    seedJob('job-p2')
    await submitProposalWorkflow('job-p2')
    await submitProposalWorkflow('job-p2') // second call — proposal already sent

    expect(delivery.sendProposalReceivedEmail).toHaveBeenCalledOnce()
  })

  it('skips when customerUserId is absent', async () => {
    seedJob('job-p3', { customerUserId: undefined })
    await submitProposalWorkflow('job-p3')

    // sendProposalReceivedEmail called with undefined userId — it skips internally
    const call = vi.mocked(delivery.sendProposalReceivedEmail).mock.calls[0]
    expect(call[1]).toBeUndefined()
  })

  it('does nothing when job does not exist', () => {
    submitProposalWorkflow('nonexistent')
    expect(delivery.sendProposalReceivedEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// scheduleJob
// ---------------------------------------------------------------------------

describe('scheduleJob delivery', () => {
  it('sends schedule_created to customer when schedule is first created', async () => {
    seedJob('job-s1')
    await scheduleJob({ jobId: 'job-s1', scheduledStart: BASE_START, scheduledEnd: BASE_END })

    expect(delivery.sendScheduleCreatedEmail).toHaveBeenCalledOnce()
    const call = vi.mocked(delivery.sendScheduleCreatedEmail).mock.calls[0]
    expect(call[0]).toBe('job-s1')
    expect(call[1]).toBe('user-customer-default')
  })

  it('does NOT send again if schedule already exists (idempotent)', async () => {
    seedJob('job-s2')
    await scheduleJob({ jobId: 'job-s2', scheduledStart: BASE_START, scheduledEnd: BASE_END })
    await scheduleJob({ jobId: 'job-s2', scheduledStart: BASE_START, scheduledEnd: BASE_END })

    expect(delivery.sendScheduleCreatedEmail).toHaveBeenCalledOnce()
  })

  it('skips when customerUserId is absent', async () => {
    seedJob('job-s3', { customerUserId: undefined })
    await scheduleJob({ jobId: 'job-s3', scheduledStart: BASE_START, scheduledEnd: BASE_END })

    const call = vi.mocked(delivery.sendScheduleCreatedEmail).mock.calls[0]
    expect(call[1]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// updateSchedule
// ---------------------------------------------------------------------------

describe('updateSchedule delivery', () => {
  it('sends schedule_updated to customer on update', async () => {
    seedJob('job-u1')
    await scheduleJob({ jobId: 'job-u1', scheduledStart: BASE_START, scheduledEnd: BASE_END })
    vi.clearAllMocks()

    await updateSchedule({ jobId: 'job-u1', scheduledStart: BASE_START + 3600000, scheduledEnd: BASE_END + 3600000 })

    expect(delivery.sendScheduleUpdatedEmail).toHaveBeenCalledOnce()
    const call = vi.mocked(delivery.sendScheduleUpdatedEmail).mock.calls[0]
    expect(call[0]).toBe('job-u1')
    expect(call[1]).toBe('user-customer-default')
  })

  it('sends schedule_created (not updated) when no schedule exists yet', async () => {
    seedJob('job-u2')
    await updateSchedule({ jobId: 'job-u2', scheduledStart: BASE_START, scheduledEnd: BASE_END })

    // Falls through to scheduleJob which sends schedule_created
    expect(delivery.sendScheduleCreatedEmail).toHaveBeenCalledOnce()
    expect(delivery.sendScheduleUpdatedEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// markWorkCompleteWorkflow
// ---------------------------------------------------------------------------

describe('markWorkCompleteWorkflow delivery', () => {
  it('sends work_completed to customer', async () => {
    const job = seedJob('job-wc1', { status: 'in_progress' })
    seedPayment('job-wc1', 'work_in_progress')
    installSessionForJobOwner(job)
    await markWorkCompleteWorkflow('job-wc1')

    expect(delivery.sendWorkCompletedEmail).toHaveBeenCalledOnce()
    const call = vi.mocked(delivery.sendWorkCompletedEmail).mock.calls[0]
    expect(call[0]).toBe('job-wc1')
    expect(call[1]).toBe('user-customer-default')
  })

  it('does NOT send if work was already marked complete (idempotent)', async () => {
    const job = seedJob('job-wc2', { status: 'in_progress' })
    seedPayment('job-wc2', 'work_in_progress')
    installSessionForJobOwner(job)
    await markWorkCompleteWorkflow('job-wc2')
    vi.clearAllMocks()
    await markWorkCompleteWorkflow('job-wc2') // second call

    expect(delivery.sendWorkCompletedEmail).not.toHaveBeenCalled()
  })

  it('does NOT send if job is not in_progress', async () => {
    const job = seedJob('job-wc3', { status: 'new' })
    installSessionForJobOwner(job)
    await markWorkCompleteWorkflow('job-wc3')

    expect(delivery.sendWorkCompletedEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// requestReleaseWorkflow
// ---------------------------------------------------------------------------

describe('requestReleaseWorkflow delivery', () => {
  it('sends payment_release_requested to both customer and craftsman', async () => {
    seedJob('job-r1')
    seedPayment('job-r1', 'work_in_progress')

    await requestReleaseWorkflow('job-r1')

    // Block 3: release_requested fans out to both parties so neither surface
    // is blind to the customer's pending freigabe action.
    expect(delivery.sendPaymentReleaseRequestedEmail).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(delivery.sendPaymentReleaseRequestedEmail).mock.calls
    const recipientUserIds = calls.map((c) => c[1])
    expect(recipientUserIds).toContain('user-customer-default')
    expect(recipientUserIds).toContain('user-craftsman-default')
    for (const call of calls) {
      expect(call[0]).toBe('job-r1')
    }
  })

  it('does NOT send when payment transition is not allowed (throws)', async () => {
    seedJob('job-r2')
    seedPayment('job-r2', 'deposit_required')
    // deposit_required → release_pending is not a valid transition — engine throws
    await expect(requestReleaseWorkflow('job-r2')).rejects.toThrow()
    expect(delivery.sendPaymentReleaseRequestedEmail).not.toHaveBeenCalled()
  })

  it('does NOT send when payment is already in release_pending (idempotent)', async () => {
    seedJob('job-r3')
    seedPayment('job-r3', 'release_pending')
    // Already in release_pending — idempotent guard returns early, no email sent
    await requestReleaseWorkflow('job-r3')

    expect(delivery.sendPaymentReleaseRequestedEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// openDisputeWorkflow
// ---------------------------------------------------------------------------

describe('openDisputeWorkflow delivery', () => {
  it('sends dispute_opened to both customer and craftsman', async () => {
    seedJob('job-d1')
    seedPayment('job-d1', 'in_escrow')

    await openDisputeWorkflow({
      jobId: 'job-d1',
      reason: 'work_quality',
      title: 'Test dispute',
      description: 'Test description',
    })

    expect(delivery.sendDisputeOpenedEmail).toHaveBeenCalledTimes(2)

    const calls = vi.mocked(delivery.sendDisputeOpenedEmail).mock.calls
    const roles = calls.map(c => c[2])
    expect(roles).toContain('customer')
    expect(roles).toContain('craftsman')
  })

  it('sends customer dispute email to customerUserId', async () => {
    seedJob('job-d2', { customerUserId: 'cust-x', craftsmanUserId: 'craft-y' })
    seedPayment('job-d2', 'in_escrow')

    await openDisputeWorkflow({
      jobId: 'job-d2',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    const calls = vi.mocked(delivery.sendDisputeOpenedEmail).mock.calls
    const customerCall = calls.find(c => c[2] === 'customer')
    const craftsmanCall = calls.find(c => c[2] === 'craftsman')
    expect(customerCall?.[1]).toBe('cust-x')
    expect(craftsmanCall?.[1]).toBe('craft-y')
  })

  it('skips the missing party gracefully when customerUserId is absent', async () => {
    seedJob('job-d3', { customerUserId: undefined, craftsmanUserId: 'craft-z' })
    seedPayment('job-d3', 'in_escrow')

    await openDisputeWorkflow({
      jobId: 'job-d3',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    // Still called twice — but customer call gets undefined userId (skips internally)
    expect(delivery.sendDisputeOpenedEmail).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(delivery.sendDisputeOpenedEmail).mock.calls
    const customerCall = calls.find(c => c[2] === 'customer')
    expect(customerCall?.[1]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// requestCustomerEvidenceWorkflow
// ---------------------------------------------------------------------------

describe('requestCustomerEvidenceWorkflow delivery', () => {
  it('sends dispute_evidence_requested to both customer and craftsman', async () => {
    seedJob('job-e1')
    seedPayment('job-e1', 'disputed')

    // First open a dispute so there is one to mark awaiting evidence
    const dispute = await openDisputeWorkflow({
      jobId: 'job-e1',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })
    vi.clearAllMocks()

    // Seed dispute at open status so transition to customer_waiting is valid
    await getDisputeRepository().update(dispute.id, () => ({ ...dispute, status: 'open' as const }))

    await requestCustomerEvidenceWorkflow('job-e1', 'op-1')

    expect(delivery.sendDisputeEvidenceRequestedEmail).toHaveBeenCalledTimes(2)
    const roles = vi.mocked(delivery.sendDisputeEvidenceRequestedEmail).mock.calls.map(c => c[2])
    expect(roles).toContain('customer')
    expect(roles).toContain('craftsman')
  })

  it('sends to correct userIds', async () => {
    seedJob('job-e2', { customerUserId: 'cust-e', craftsmanUserId: 'craft-e' })
    seedPayment('job-e2', 'disputed')

    const dispute = await openDisputeWorkflow({
      jobId: 'job-e2',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })
    vi.clearAllMocks()
    await getDisputeRepository().update(dispute.id, () => ({ ...dispute, status: 'open' as const }))

    await requestCustomerEvidenceWorkflow('job-e2')

    const calls = vi.mocked(delivery.sendDisputeEvidenceRequestedEmail).mock.calls
    const customerCall = calls.find(c => c[2] === 'customer')
    const craftsmanCall = calls.find(c => c[2] === 'craftsman')
    expect(customerCall?.[1]).toBe('cust-e')
    expect(craftsmanCall?.[1]).toBe('craft-e')
  })
})

// ---------------------------------------------------------------------------
// startJobWorkflow does NOT send notifications
// ---------------------------------------------------------------------------

describe('startJobWorkflow does not trigger delivery', () => {
  it('no delivery emails sent when job is started', async () => {
    seedJob('job-start1', { status: 'scheduled' })
    // in_escrow → work_in_progress is the valid transition for startJobWorkflow
    seedPayment('job-start1', 'in_escrow')
    await startJobWorkflow('job-start1')

    // None of the delivery helpers should have been called
    expect(delivery.sendProposalReceivedEmail).not.toHaveBeenCalled()
    expect(delivery.sendScheduleCreatedEmail).not.toHaveBeenCalled()
    expect(delivery.sendWorkCompletedEmail).not.toHaveBeenCalled()
    expect(delivery.sendPaymentReleaseRequestedEmail).not.toHaveBeenCalled()
  })
})
