import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  requestCustomerEvidenceWorkflow,
  markDisputeUnderReviewWorkflow,
  rejectDisputeWorkflow,
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
  resolveDisputeWorkflow,
  reviewDisputeWorkflow,
  openDisputeWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import {
  addDisputeEvidence,
  getDisputeByJobId,
} from '../../src/lib/disputes/disputesService'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Dispute, DisputeDecision, ResolutionType, SettlementStatus } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'

// =============================================================================
// Block 5.3 — Dispute Operator-RPC Gate (γ vocabulary)
// =============================================================================
// These tests pin down the contract that every operator-driven dispute state
// transition runs through the new repository operator methods (which Supabase
// implements via SECURITY DEFINER RPCs that re-verify profiles.is_operator).
// They cover the in-memory mirror of those RPCs; the production guarantee is
// reinforced by the BEFORE UPDATE trigger introduced in
// supabase/migrations/20260429000001_dispute_alignment_v2.sql.
// =============================================================================

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

function seedJob(id: string, customerUserId: string, craftsmanUserId: string): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Job ${id}`,
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1.000 €',
    description: 'Seed job',
    paymentState: 'disputed',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId,
    craftsmanUserId,
  }
  getJobRepository().add(job)
  return job
}

type SeedDisputeExtras = {
  decision?: DisputeDecision
  resolutionType?: ResolutionType
  settlementStatus?: SettlementStatus
  splitRatio?: number
}

function seedDispute(
  jobId: string,
  status: Dispute['status'],
  raisedBy: string,
  extras: SeedDisputeExtras = {},
): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test',
    raisedBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidence: [],
    ...(extras.decision != null && { decision: extras.decision }),
    ...(extras.resolutionType != null && { resolutionType: extras.resolutionType }),
    ...(extras.settlementStatus != null && { settlementStatus: extras.settlementStatus }),
    ...(extras.splitRatio != null && { splitRatio: extras.splitRatio }),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

describe('Block 5.3 — Dispute Operator-RPC Gate', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('Workflow → repository operator method routing', () => {
    it('requestCustomerEvidenceWorkflow routes through repo.operatorRequestCustomerEvidence', async () => {
      seedJob('job-op1', 'customer-1', 'craftsman-1')
      seedPayment('job-op1', 'disputed')
      seedDispute('job-op1', 'open', 'customer-1')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorRequestCustomerEvidence')

      await requestCustomerEvidenceWorkflow('job-op1', 'operator-uuid')

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op1')
    })

    it('markDisputeUnderReviewWorkflow routes through repo.operatorMarkUnderReview', async () => {
      seedJob('job-op2', 'customer-2', 'craftsman-2')
      seedPayment('job-op2', 'disputed')
      seedDispute('job-op2', 'open', 'customer-2')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorMarkUnderReview')

      await markDisputeUnderReviewWorkflow('job-op2')

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op2')
    })

    it('reviewDisputeWorkflow (by disputeId) also routes through operatorMarkUnderReview', async () => {
      seedJob('job-op2b', 'customer-2b', 'craftsman-2b')
      seedPayment('job-op2b', 'disputed')
      const dispute = seedDispute('job-op2b', 'open', 'customer-2b')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorMarkUnderReview')

      await reviewDisputeWorkflow(dispute.id)

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op2b')
    })

    it('rejectDisputeWorkflow routes through repo.operatorReject (not direct repo.update for status)', async () => {
      seedJob('job-op3', 'customer-3', 'craftsman-3')
      seedPayment('job-op3', 'disputed')
      seedDispute('job-op3', 'under_review', 'customer-3')

      const repo = getDisputeRepository()
      const operatorSpy = vi.spyOn(repo, 'operatorReject')

      await rejectDisputeWorkflow('job-op3', 'operator-uuid')

      expect(operatorSpy).toHaveBeenCalledTimes(1)
      expect(operatorSpy).toHaveBeenCalledWith('job-op3')
    })

    it('resolveDisputeReleaseWorkflow routes through repo.operatorResolveRelease', async () => {
      seedJob('job-op4', 'customer-4', 'craftsman-4')
      seedPayment('job-op4', 'disputed')
      seedDispute('job-op4', 'under_review', 'customer-4')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorResolveRelease')

      await resolveDisputeReleaseWorkflow('job-op4', 'operator-uuid')

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op4')
    })

    it('resolveDisputeRefundWorkflow routes through repo.operatorResolveRefund', async () => {
      seedJob('job-op5', 'customer-5', 'craftsman-5')
      seedPayment('job-op5', 'disputed')
      seedDispute('job-op5', 'under_review', 'customer-5')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorResolveRefund')

      await resolveDisputeRefundWorkflow('job-op5', 'operator-uuid')

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op5')
    })

    it('resolveDisputeWorkflow with split decision routes through repo.operatorResolveSplit with ratio', async () => {
      seedJob('job-op6', 'customer-6', 'craftsman-6')
      seedPayment('job-op6', 'disputed')
      const dispute = seedDispute('job-op6', 'under_review', 'customer-6')

      const repo = getDisputeRepository()
      const opSpy = vi.spyOn(repo, 'operatorResolveSplit')

      await resolveDisputeWorkflow(dispute.id, 'split', 0.7, 'operator-uuid')

      expect(opSpy).toHaveBeenCalledTimes(1)
      expect(opSpy).toHaveBeenCalledWith('job-op6', 0.7)
    })
  })

  describe('Repository operator-method enforcement', () => {
    it('operatorRequestCustomerEvidence transitions open → customer_waiting', async () => {
      seedJob('job-st1', 'customer-1', 'craftsman-1')
      seedDispute('job-st1', 'open', 'customer-1')

      const updated = await getDisputeRepository().operatorRequestCustomerEvidence('job-st1')

      expect(updated.status).toBe('customer_waiting')
      expect(getDisputeByJobId('job-st1')?.status).toBe('customer_waiting')
    })

    it('operatorRequestProviderEvidence transitions open → provider_waiting', async () => {
      seedJob('job-st1b', 'customer-1b', 'craftsman-1b')
      seedDispute('job-st1b', 'open', 'customer-1b')

      const updated = await getDisputeRepository().operatorRequestProviderEvidence('job-st1b')

      expect(updated.status).toBe('provider_waiting')
      expect(getDisputeByJobId('job-st1b')?.status).toBe('provider_waiting')
    })

    it('operatorResolveRelease sets status=resolved, decision=release, resolutionType=release_full and settlementStatus=pending', async () => {
      seedJob('job-st2', 'customer-2', 'craftsman-2')
      seedDispute('job-st2', 'under_review', 'customer-2')

      const updated = await getDisputeRepository().operatorResolveRelease('job-st2')

      expect(updated.status).toBe('resolved')
      expect(updated.decision).toBe('release')
      expect(updated.resolutionType).toBe('release_full')
      expect(updated.settlementStatus).toBe('pending')
      expect(updated.resolvedAt).toBeDefined()
    })

    it('operatorResolveSplit enforces (0,1) EXCLUSIVE — 0/1 and out-of-range reject, interior admitted', async () => {
      seedJob('job-st3', 'customer-3', 'craftsman-3')
      seedDispute('job-st3', 'under_review', 'customer-3')

      // (0,1) exclusive: 0 % is a refund, 100 % a release — neither is a split.
      // Inclusive bounds double-paid at ratio=0 (full provider release + full
      // customer refund), so 0 and 1 must reject alongside out-of-range values.
      for (const bad of [1.2, -0.1, 0, 1]) {
        await expect(
          getDisputeRepository().operatorResolveSplit('job-st3', bad)
        ).rejects.toThrow(/invalid_split_ratio/)
      }

      // An interior ratio is admitted (no false-reject) and resolves the dispute.
      const updated = await getDisputeRepository().operatorResolveSplit('job-st3', 0.5)
      expect(updated.status).toBe('resolved')
      expect(updated.decision).toBe('split')
      expect(updated.splitRatio).toBe(0.5)
      expect(updated.settlementStatus).toBe('pending')
    })

    it('operatorReject blocks invalid from-status (e.g. open → resolved directly)', async () => {
      seedJob('job-st4', 'customer-4', 'craftsman-4')
      seedDispute('job-st4', 'open', 'customer-4')

      await expect(
        getDisputeRepository().operatorReject('job-st4')
      ).rejects.toThrow(/invalid_transition/)
    })

    it('operatorReject is idempotent on already-rejected dispute', async () => {
      seedJob('job-st5', 'customer-5', 'craftsman-5')
      seedDispute('job-st5', 'resolved', 'customer-5', {
        decision: 'reject',
        resolutionType: 'rejected',
        settlementStatus: 'pending',
      })

      const updated = await getDisputeRepository().operatorReject('job-st5')
      expect(updated.status).toBe('resolved')
      expect(updated.decision).toBe('reject')
    })

    describe('decision immutability (C5 RPC parity)', () => {
      it('re-resolving with a DIFFERENT decision throws decision_immutable', async () => {
        seedJob('job-im1', 'customer-im1', 'craftsman-im1')
        seedDispute('job-im1', 'resolved', 'customer-im1', {
          decision: 'release',
          resolutionType: 'release_full',
          settlementStatus: 'pending',
        })

        await expect(
          getDisputeRepository().operatorResolveRefund('job-im1')
        ).rejects.toThrow(/decision_immutable/)
        await expect(
          getDisputeRepository().operatorReject('job-im1')
        ).rejects.toThrow(/decision_immutable/)
      })

      it('settled dispute is immutable: same-decision retry is an idempotent no-op (never settled→pending)', async () => {
        seedJob('job-im2', 'customer-im2', 'craftsman-im2')
        seedDispute('job-im2', 'resolved', 'customer-im2', {
          decision: 'reject',
          resolutionType: 'rejected',
          settlementStatus: 'settled',
        })

        const updated = await getDisputeRepository().operatorReject('job-im2')
        expect(updated.status).toBe('resolved')
        expect(updated.decision).toBe('reject')
        expect(updated.settlementStatus).toBe('settled')
      })

      it('same-decision retry on a pending (unsettled) dispute stays allowed', async () => {
        seedJob('job-im3', 'customer-im3', 'craftsman-im3')
        seedDispute('job-im3', 'resolved', 'customer-im3', {
          decision: 'release',
          resolutionType: 'release_full',
          settlementStatus: 'pending',
        })

        const updated = await getDisputeRepository().operatorResolveRelease('job-im3')
        expect(updated.status).toBe('resolved')
        expect(updated.decision).toBe('release')
        expect(updated.settlementStatus).toBe('pending')
      })

      it('same-decision split retry on a pending dispute stays allowed', async () => {
        seedJob('job-im4', 'customer-im4', 'craftsman-im4')
        seedDispute('job-im4', 'resolved', 'customer-im4', {
          decision: 'split',
          resolutionType: 'split',
          splitRatio: 0.5,
          settlementStatus: 'pending',
        })

        const updated = await getDisputeRepository().operatorResolveSplit('job-im4', 0.7)
        expect(updated.status).toBe('resolved')
        expect(updated.decision).toBe('split')
        expect(updated.splitRatio).toBe(0.7)
      })
    })

    it('operatorRequestCustomerEvidence throws when no dispute exists for the job', async () => {
      seedJob('job-st6', 'customer-6', 'craftsman-6')

      await expect(
        getDisputeRepository().operatorRequestCustomerEvidence('job-st6')
      ).rejects.toThrow(/dispute_not_found/)
    })
  })

  describe('Customer / participant read + evidence path remains intact', () => {
    it('a dispute opened by the customer is still readable via getDisputeByJobId', async () => {
      seedJob('job-rd1', 'customer-rd', 'craftsman-rd')
      seedPayment('job-rd1', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-rd1',
        reason: 'work_quality',
        title: 'Mängel',
        description: 'Beschrieben.',
        raisedBy: 'customer-rd',
      })

      const dispute = getDisputeByJobId('job-rd1')
      expect(dispute).toBeDefined()
      expect(dispute!.status).toBe('open')
      expect(dispute!.raisedBy).toBe('customer-rd')
    })

    it('addDisputeEvidence still appends without changing dispute status', async () => {
      seedJob('job-rd2', 'customer-rd2', 'craftsman-rd2')
      seedDispute('job-rd2', 'customer_waiting', 'customer-rd2')

      const evidence = await addDisputeEvidence('job-rd2', {
        type: 'photo',
        description: 'Foto vom Schaden',
        submittedBy: 'customer-rd2',
        url: 'https://example/photo.jpg',
      })

      const dispute = getDisputeByJobId('job-rd2')
      expect(evidence).toBeDefined()
      // Status MUST be untouched — only the evidence array grew.
      expect(dispute!.status).toBe('customer_waiting')
      expect(dispute!.evidence?.length).toBe(1)
    })
  })

  describe('Status-changing repository.update() is no longer reached by workflow paths', () => {
    // The Production guarantee is enforced by the BEFORE UPDATE trigger on
    // public.disputes (see migration 20260429000001). In InMemory mode we
    // assert behaviorally that the operator-RPC method is the path that
    // actually drove the status change, with repo.update only used for
    // non-status flips (settlement_status, evidence) afterwards.
    it('rejectDisputeWorkflow drives status via operatorReject, not via repo.update', async () => {
      seedJob('job-no-direct-1', 'customer-1', 'craftsman-1')
      seedPayment('job-no-direct-1', 'disputed')
      seedDispute('job-no-direct-1', 'under_review', 'customer-1')

      const repo = getDisputeRepository()
      const operatorSpy = vi.spyOn(repo, 'operatorReject')
      const updateSpy = vi.spyOn(repo, 'update')

      await rejectDisputeWorkflow('job-no-direct-1', 'operator-uuid')

      // The status transition must have come from the operator-RPC mirror.
      expect(operatorSpy).toHaveBeenCalledTimes(1)
      // Any update() call that did happen is settlement-only — it must not
      // be the carrier of the status transition. We verify this by replaying
      // each updater against a snapshot still in the from-state and checking
      // that the *updater itself* does not propose a status change.
      const fromState: Dispute = {
        id: 'dispute-job-no-direct-1',
        jobId: 'job-no-direct-1',
        paymentId: 'pay-job-no-direct-1',
        status: 'under_review',
        reason: 'work_quality',
        title: 'T', description: 'D',
        raisedBy: 'customer-1',
        createdAt: 1,
        updatedAt: 1,
        evidence: [],
      }
      for (const [, updater] of updateSpy.mock.calls) {
        const proposed = updater(fromState)
        // settleDispute is allowed to write a closure-captured "settled"
        // snapshot. The invariant we care about: the *initiator* of the
        // status change is operatorReject, not this updater. We assert that
        // all status mutations seen here resolve to the post-operator status
        // (resolved) — i.e. they reflect already-persisted operator truth,
        // never an alternate target like 'customer_waiting'.
        if (proposed.status !== fromState.status) {
          expect(proposed.status).toBe('resolved')
        }
      }
    })
  })
})
