import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { InMemoryAuditRepository } from '../../src/lib/audit/InMemoryAuditRepository'
import { setAuditRepository, getAuditRepository } from '../../src/lib/audit/registry'
import { logOperatorAction } from '../../src/lib/audit/logOperatorAction'
import {
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
  resolveDisputeWorkflow,
  rejectDisputeWorkflow,
  requestCustomerEvidenceWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'
import * as observability from '../../src/lib/observability'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Test suite
// ---------------------------------------------------------------------------

describe('Operator Audit Logging', () => {
  let auditRepo: InMemoryAuditRepository

  beforeEach(() => {
    setupCleanRepositories()
    auditRepo = new InMemoryAuditRepository()
    setAuditRepository(auditRepo)
  })

  // -------------------------------------------------------------------------
  // logOperatorAction unit tests
  // -------------------------------------------------------------------------

  describe('logOperatorAction', () => {
    it('stores the entry in the audit repository', () => {
      logOperatorAction({
        operatorId: 'op-1',
        actionType: 'dispute.resolve_release',
        entityType: 'dispute',
        entityId: 'dispute-abc',
        metadata: { jobId: 'job-abc', paymentId: 'pay-abc' },
      })

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-1',
        actionType: 'dispute.resolve_release',
        entityType: 'dispute',
        entityId: 'dispute-abc',
      })
    })

    it('preserves metadata in the stored entry', () => {
      const metadata = { jobId: 'job-meta', paymentId: 'pay-meta', someExtra: 42 }

      logOperatorAction({
        operatorId: 'op-2',
        actionType: 'dispute.resolve_refund',
        entityType: 'dispute',
        entityId: 'dispute-meta',
        metadata,
      })

      const entries = auditRepo.getEntries()
      expect(entries[0].metadata).toEqual(metadata)
    })

    it('emits observability event via logInfo', () => {
      const logInfoSpy = vi.spyOn(observability, 'logInfo')

      logOperatorAction({
        operatorId: 'op-3',
        actionType: 'dispute.reject',
        entityType: 'dispute',
        entityId: 'dispute-obs',
      })

      expect(logInfoSpy).toHaveBeenCalledWith(
        'audit.operator_action',
        expect.objectContaining({
          operatorId: 'op-3',
          actionType: 'dispute.reject',
          entityType: 'dispute',
          entityId: 'dispute-obs',
        })
      )
    })

    it('works without optional entityId and metadata', () => {
      logOperatorAction({
        operatorId: 'op-4',
        actionType: 'dispute.request_evidence',
        entityType: 'dispute',
      })

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0].entityId).toBeUndefined()
      expect(entries[0].metadata).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // InMemoryAuditRepository tests
  // -------------------------------------------------------------------------

  describe('InMemoryAuditRepository', () => {
    it('accumulates multiple entries', () => {
      const repo = new InMemoryAuditRepository()

      repo.insertAuditEntry({ operatorId: 'op-a', actionType: 'a', entityType: 'dispute' })
      repo.insertAuditEntry({ operatorId: 'op-b', actionType: 'b', entityType: 'payment' })

      expect(repo.getEntries()).toHaveLength(2)
    })

    it('clear() removes all stored entries', () => {
      const repo = new InMemoryAuditRepository()
      repo.insertAuditEntry({ operatorId: 'op-x', actionType: 'x', entityType: 'dispute' })
      repo.clear()
      expect(repo.getEntries()).toHaveLength(0)
    })

    it('getEntries() returns a copy — mutations do not affect the store', () => {
      const repo = new InMemoryAuditRepository()
      repo.insertAuditEntry({ operatorId: 'op-y', actionType: 'y', entityType: 'dispute' })

      const copy = repo.getEntries()
      copy.pop()

      expect(repo.getEntries()).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Workflow integration tests
  // -------------------------------------------------------------------------

  describe('resolveDisputeReleaseWorkflow writes audit entry', () => {
    it('logs dispute.resolve_release when operatorId is provided', async () => {
      seedPayment('job-a1', 'disputed')
      seedDispute('job-a1', 'under_review')

      await resolveDisputeReleaseWorkflow('job-a1', 'op-release')

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-release',
        actionType: 'dispute.resolve_release',
        entityType: 'dispute',
      })
      expect(entries[0].metadata).toMatchObject({
        jobId: 'job-a1',
        previousStatus: 'under_review',
        newStatus: 'resolved',
        newDecision: 'release',
      })
    })

    it('does not write audit entry when operatorId is omitted', async () => {
      seedPayment('job-a2', 'disputed')
      seedDispute('job-a2', 'under_review')

      await resolveDisputeReleaseWorkflow('job-a2')

      expect(auditRepo.getEntries()).toHaveLength(0)
    })
  })

  describe('resolveDisputeRefundWorkflow writes audit entry', () => {
    it('logs dispute.resolve_refund when operatorId is provided', async () => {
      seedPayment('job-b1', 'disputed')
      seedDispute('job-b1', 'under_review')

      await resolveDisputeRefundWorkflow('job-b1', 'op-refund')

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-refund',
        actionType: 'dispute.resolve_refund',
        entityType: 'dispute',
      })
      expect(entries[0].metadata).toMatchObject({
        jobId: 'job-b1',
        previousStatus: 'under_review',
        newStatus: 'resolved',
        newDecision: 'refund',
      })
    })
  })

  describe('resolveDisputeWorkflow (split) writes audit entry', () => {
    it('logs dispute.resolve_split when operatorId is provided', async () => {
      seedPayment('job-c1', 'disputed')
      seedDispute('job-c1', 'under_review')

      await resolveDisputeWorkflow('dispute-job-c1', 'split', 0.7, 'op-split')

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-split',
        actionType: 'dispute.resolve_split',
        entityType: 'dispute',
      })
      expect(entries[0].metadata).toMatchObject({
        jobId: 'job-c1',
        splitRatio: 0.7,
        previousStatus: 'under_review',
        newStatus: 'resolved',
        newDecision: 'split',
      })
    })
  })

  describe('rejectDisputeWorkflow writes audit entry', () => {
    it('logs dispute.reject when operatorId is provided', async () => {
      seedPayment('job-d1', 'disputed')
      seedDispute('job-d1', 'under_review')

      await rejectDisputeWorkflow('job-d1', 'op-reject')

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-reject',
        actionType: 'dispute.reject',
        entityType: 'dispute',
      })
      expect(entries[0].metadata).toMatchObject({
        jobId: 'job-d1',
        previousStatus: 'under_review',
        newStatus: 'resolved',
        newDecision: 'reject',
      })
    })
  })

  describe('requestCustomerEvidenceWorkflow writes audit entry', () => {
    it('logs dispute.request_customer_evidence when operatorId is provided', async () => {
      seedPayment('job-e1', 'disputed')
      seedDispute('job-e1', 'open')

      await requestCustomerEvidenceWorkflow('job-e1', 'op-evidence')

      const entries = auditRepo.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operatorId: 'op-evidence',
        actionType: 'dispute.request_customer_evidence',
        entityType: 'dispute',
      })
      expect(entries[0].metadata).toMatchObject({ jobId: 'job-e1', party: 'customer' })
    })

    it('does not write audit entry when operatorId is omitted', async () => {
      seedPayment('job-e2', 'disputed')
      seedDispute('job-e2', 'open')

      await requestCustomerEvidenceWorkflow('job-e2')

      expect(auditRepo.getEntries()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // registry: getAuditRepository returns the active repository
  // -------------------------------------------------------------------------

  describe('registry', () => {
    it('getAuditRepository returns the repository set by setAuditRepository', () => {
      const fresh = new InMemoryAuditRepository()
      setAuditRepository(fresh)
      expect(getAuditRepository()).toBe(fresh)
    })
  })
})
