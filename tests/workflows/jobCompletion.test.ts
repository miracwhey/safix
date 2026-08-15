import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { getJobById } from '../../src/lib/jobs'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

/** Helper: add a job at a specific status */
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

/** Helper: add a payment at a specific state */
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

/** Helper: add a dispute at a specific status */
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

describe('Job Completion → Payment Release Workflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('successful payment release', () => {
    it('releases payment for a job in waiting_payment with no dispute', async () => {
      seedJob('job-w1', 'waiting_payment')
      seedPayment('job-w1', 'release_pending')

      const { payment } = await releaseEscrowWorkflow('job-w1')

      expect(payment).toBeDefined()
      expect(payment!.state).toBe('released')
    })

    it('marks the job as completed after release', async () => {
      seedJob('job-w2', 'waiting_payment')
      seedPayment('job-w2', 'release_pending')

      await releaseEscrowWorkflow('job-w2')

      const job = getJobById('job-w2')
      expect(job?.status).toBe('completed')
    })
  })

  describe('release blocked by open dispute', () => {
    it('throws when an open dispute exists for the job', async () => {
      seedJob('job-w3', 'waiting_payment')
      seedPayment('job-w3', 'disputed')
      seedDispute('job-w3', 'open')

      await expect(releaseEscrowWorkflow('job-w3')).rejects.toThrow(
        /Release blocked/,
      )
    })

    it('throws when dispute is customer_waiting', async () => {
      seedJob('job-w4', 'waiting_payment')
      seedPayment('job-w4', 'disputed')
      seedDispute('job-w4', 'customer_waiting')

      await expect(releaseEscrowWorkflow('job-w4')).rejects.toThrow(
        /Release blocked/,
      )
    })

    it('throws when dispute is under_review', async () => {
      seedJob('job-w5', 'waiting_payment')
      seedPayment('job-w5', 'disputed')
      seedDispute('job-w5', 'under_review')

      await expect(releaseEscrowWorkflow('job-w5')).rejects.toThrow(
        /Release blocked/,
      )
    })
  })

  describe('job status guard', () => {
    it('returns undefined and logs warning when job is not in waiting_payment', async () => {
      seedJob('job-w6', 'in_progress')
      seedPayment('job-w6', 'release_pending')

      const { payment: result } = await releaseEscrowWorkflow('job-w6')
      expect(result).toBeUndefined()
    })
  })

  describe('dispute opened on waiting_payment job blocks release', () => {
    it('opening a dispute transitions payment to disputed and blocks release', async () => {
      seedJob('job-w7', 'waiting_payment')
      seedPayment('job-w7', 'in_escrow')

      // Open a dispute — this should freeze the escrow
      await openDisputeWorkflow({
        jobId: 'job-w7',
        reason: 'work_quality',
        title: 'Qualitätsmangel',
        description: 'Mängel am ausgeführten Werk.',
      })

      // Now attempt to release — must be blocked
      await expect(releaseEscrowWorkflow('job-w7')).rejects.toThrow(
        /Release blocked/,
      )
    })
  })

  describe('refund workflow', () => {
    it('refunds payment for a job in waiting_payment', async () => {
      seedJob('job-w8', 'waiting_payment')
      seedPayment('job-w8', 'release_pending')

      const payment = await refundEscrowWorkflow('job-w8')

      expect(payment).toBeDefined()
      expect(payment!.state).toBe('refunded')
    })

    it('marks the job as completed after refund', async () => {
      seedJob('job-w9', 'waiting_payment')
      seedPayment('job-w9', 'release_pending')

      await refundEscrowWorkflow('job-w9')

      const job = getJobById('job-w9')
      expect(job?.status).toBe('completed')
    })

    it('refund is blocked when job is not in waiting_payment', async () => {
      seedJob('job-w10', 'in_progress')
      seedPayment('job-w10', 'release_pending')

      const result = await refundEscrowWorkflow('job-w10')
      expect(result).toBeUndefined()
    })
  })
})
