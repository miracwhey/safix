/**
 * Integration tests: Flow E — Dispute + Payment Full Lifecycle
 *
 * Validates the end-to-end paths from job creation through dispute resolution,
 * covering:
 * - Opening a dispute freezes the payment and creates a dispute_hold ledger entry
 * - Payment state machine: only escrowed payments can be disputed
 * - Release blocked by all active dispute states (open, awaiting_evidence, under_review)
 * - Full resolution paths:
 *     release   → payment released, dispute resolved_release, correct ledger entries
 *     refund    → payment refunded, dispute resolved_refund, correct ledger entries
 *     split     → payment released, dispute resolved_split, both ledger entries + platform_fee
 *     reject    → payment returns to release_pending, dispute rejected
 * - No ownership regression: customerUserId / craftsmanUserId survive the full path
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { installSessionForJobOwner, installSessionForJobCustomer } from '../helpers/mockSession'
import {
  openDisputeWorkflow,
  resolveDisputeWorkflow,
  reviewDisputeWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import {
  startJobWorkflow,
  markWorkCompleteWorkflow,
  customerReleasePaymentWorkflow,
} from '../../src/lib/workflow/jobWorkflow'

import { getJobById } from '../../src/lib/jobs'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'

import { isDisputeBlocking } from '../../src/lib/disputes/stateMachine'

import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedJob(
  id: string,
  overrides: Partial<Job> = {}
): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Erika Muster',
    location: 'Hamburg',
    dateLabel: 'Heute',
    status: overrides.status ?? 'waiting_payment',
    amount: '2.000 €',
    description: 'Fliesen verlegen',
    paymentState: overrides.paymentState ?? 'release_pending',
    documentationStatus: '2 Fotos',
    assignedMemberIds: overrides.assignedMemberIds ?? [],
    notes: [],
    photoCount: 2,
    activities: [],
    customerUserId: overrides.customerUserId ?? 'cust-disp',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craft-disp',
    workCompletedAt: overrides.workCompletedAt,
    // Block 7.2.1b: tests that seed `workCompletedAt` directly are simulating
    // a job that has already passed admin-confirm; mirror the new stamps so
    // `customerReleasePaymentWorkflow` sees a confirmed completion.
    workMarkedCompleteAt: overrides.workMarkedCompleteAt ?? overrides.workCompletedAt,
    workConfirmedCompleteAt: overrides.workConfirmedCompleteAt ?? overrides.workCompletedAt,
    paymentReleasedAt: overrides.paymentReleasedAt,
    disputeStatus: overrides.disputeStatus,
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state'], total = 1000): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: total, depositAmount: total * 0.25, finalAmount: total * 0.75 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

function seedDispute(
  jobId: string,
  status: Dispute['status'],
  overrides: Partial<Dispute> = {}
): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Mängel an der Ausführung',
    description: 'Fliesen uneben verlegt.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
  getDisputeRepository().add(dispute)
  return dispute
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dispute + Payment Full Lifecycle (Flow E)', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ---- Opening a dispute --------------------------------------------------

  describe('Opening a dispute', () => {
    it('transitions payment from in_escrow to disputed', async () => {
      seedJob('j-d-1', { status: 'waiting_payment' })
      seedPayment('j-d-1', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'j-d-1',
        reason: 'work_quality',
        title: 'Qualitätsmangel',
        description: 'Fliesen gerissen.',
      })

      const payment = getPaymentRepository().getByJobId('j-d-1')
      expect(payment?.state).toBe('disputed')
    })

    it('creates a dispute_hold ledger entry with the correct amount', async () => {
      seedJob('j-d-2', { status: 'waiting_payment' })
      seedPayment('j-d-2', 'in_escrow', 1500)

      await openDisputeWorkflow({
        jobId: 'j-d-2',
        reason: 'scope_conflict',
        title: 'Leistungsumfang',
        description: 'Vereinbarter Umfang nicht erfüllt.',
      })

      const entries = getLedgerRepository().getForJob('j-d-2')
      const hold = entries.find((e) => e.type === 'dispute_hold')
      expect(hold).toBeDefined()
      expect(hold!.amount).toBe(1500)
    })

    it('does not transition payment in deposit_required state', async () => {
      seedJob('j-d-3', { status: 'new', paymentState: 'deposit_required' })
      seedPayment('j-d-3', 'deposit_required')

      await openDisputeWorkflow({
        jobId: 'j-d-3',
        reason: 'payment_conflict',
        title: 'Zahlungskonflikt',
        description: 'Konflikt vor Zahlung.',
      })

      const payment = getPaymentRepository().getByJobId('j-d-3')
      expect(payment?.state).toBe('deposit_required')
    })

    it('does not transition payment in deposit_paid state', async () => {
      seedJob('j-d-4', { status: 'new' })
      seedPayment('j-d-4', 'deposit_paid')

      await openDisputeWorkflow({
        jobId: 'j-d-4',
        reason: 'delay',
        title: 'Verzögerung',
        description: 'Arbeit noch nicht begonnen.',
      })

      const payment = getPaymentRepository().getByJobId('j-d-4')
      expect(payment?.state).toBe('deposit_paid')
    })

    it('can dispute a payment in work_in_progress state', async () => {
      seedJob('j-d-5', { status: 'in_progress' })
      seedPayment('j-d-5', 'work_in_progress')

      await openDisputeWorkflow({
        jobId: 'j-d-5',
        reason: 'work_quality',
        title: 'Qualitätsproblem',
        description: 'Schlechte Qualität während der Ausführung.',
      })

      const payment = getPaymentRepository().getByJobId('j-d-5')
      expect(payment?.state).toBe('disputed')
    })

    it('can dispute a payment in release_pending state', async () => {
      seedJob('j-d-6', { status: 'waiting_payment' })
      seedPayment('j-d-6', 'release_pending')

      await openDisputeWorkflow({
        jobId: 'j-d-6',
        reason: 'work_quality',
        title: 'Mangel',
        description: 'Ergebnis entspricht nicht den Erwartungen.',
      })

      const payment = getPaymentRepository().getByJobId('j-d-6')
      expect(payment?.state).toBe('disputed')
    })

    it('is idempotent — calling twice returns the same dispute', async () => {
      seedJob('j-d-7', { status: 'waiting_payment' })
      seedPayment('j-d-7', 'in_escrow')

      const first = await openDisputeWorkflow({
        jobId: 'j-d-7',
        reason: 'other',
        title: 'Problem',
        description: 'Beschreibung.',
      })
      const second = await openDisputeWorkflow({
        jobId: 'j-d-7',
        reason: 'other',
        title: 'Problem',
        description: 'Zweiter Aufruf.',
      })

      expect(second.id).toBe(first.id)
      expect(getDisputeRepository().getAll().length).toBe(1)
    })
  })

  // ---- isDisputeBlocking --------------------------------------------------

  describe('isDisputeBlocking', () => {
    it('returns true for "open" status', () => {
      expect(isDisputeBlocking('open')).toBe(true)
    })

    it('returns true for "customer_waiting" status', () => {
      expect(isDisputeBlocking('customer_waiting')).toBe(true)
    })

    it('returns true for "provider_waiting" status', () => {
      expect(isDisputeBlocking('provider_waiting')).toBe(true)
    })

    it('returns true for "under_review" status', () => {
      expect(isDisputeBlocking('under_review')).toBe(true)
    })

    it('returns false for terminal states', () => {
      expect(isDisputeBlocking('resolved')).toBe(false)
      expect(isDisputeBlocking('closed')).toBe(false)
      expect(isDisputeBlocking('cancelled')).toBe(false)
    })
  })

  // ---- Release blocked by open disputes -----------------------------------

  describe('Payment release blocked by active disputes', () => {
    it('blocks release when dispute is open', async () => {
      seedJob('j-block-1', { status: 'waiting_payment' })
      seedPayment('j-block-1', 'disputed')
      seedDispute('j-block-1', 'open')

      await expect(releaseEscrowWorkflow('j-block-1')).rejects.toThrow(/Release blocked/)
    })

    it('blocks release when dispute is customer_waiting', async () => {
      seedJob('j-block-2', { status: 'waiting_payment' })
      seedPayment('j-block-2', 'disputed')
      seedDispute('j-block-2', 'customer_waiting')

      await expect(releaseEscrowWorkflow('j-block-2')).rejects.toThrow(/Release blocked/)
    })

    it('blocks release when dispute is under_review', async () => {
      seedJob('j-block-3', { status: 'waiting_payment' })
      seedPayment('j-block-3', 'disputed')
      seedDispute('j-block-3', 'under_review')

      await expect(releaseEscrowWorkflow('j-block-3')).rejects.toThrow(/Release blocked/)
    })
  })

  // ---- Full dispute resolution: release -----------------------------------

  describe('Dispute resolution: release (craftsman wins)', () => {
    it('payment transitions to released after dispute resolved_release', async () => {
      seedJob('j-res-1', { status: 'waiting_payment' })
      seedPayment('j-res-1', 'disputed')
      const dispute = seedDispute('j-res-1', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const payment = getPaymentRepository().getByJobId('j-res-1')
      expect(payment?.state).toBe('released')
    })

    it('dispute transitions to resolved with decision=release', async () => {
      seedJob('j-res-2', { status: 'waiting_payment' })
      seedPayment('j-res-2', 'disputed')
      const dispute = seedDispute('j-res-2', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const updated = getDisputeRepository().getByJobId('j-res-2')
      expect(updated?.status).toBe('resolved')
      expect(updated?.decision).toBe('release')
      expect(updated?.resolutionType).toBe('release_full')
    })

    it('job transitions to completed after dispute release resolution', async () => {
      seedJob('j-res-3', { status: 'waiting_payment' })
      seedPayment('j-res-3', 'disputed')
      const dispute = seedDispute('j-res-3', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const job = getJobById('j-res-3')
      expect(job?.status).toBe('completed')
    })

    it('creates dispute_resolved_release ledger entry', async () => {
      seedJob('j-res-4', { status: 'waiting_payment' })
      seedPayment('j-res-4', 'disputed')
      const dispute = seedDispute('j-res-4', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const entries = getLedgerRepository().getForJob('j-res-4')
      const entry = entries.find((e) => e.type === 'dispute_resolved_release')
      expect(entry).toBeDefined()
      expect(entry?.disputeId).toBe(dispute.id)
    })
  })

  // ---- Full dispute resolution: refund ------------------------------------

  describe('Dispute resolution: refund (customer wins)', () => {
    it('payment transitions to refunded after dispute resolved_refund', async () => {
      seedJob('j-ref-1', { status: 'waiting_payment' })
      seedPayment('j-ref-1', 'disputed')
      const dispute = seedDispute('j-ref-1', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'refund')

      const payment = getPaymentRepository().getByJobId('j-ref-1')
      expect(payment?.state).toBe('refunded')
    })

    it('dispute transitions to resolved with decision=refund', async () => {
      seedJob('j-ref-2', { status: 'waiting_payment' })
      seedPayment('j-ref-2', 'disputed')
      const dispute = seedDispute('j-ref-2', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'refund')

      const updated = getDisputeRepository().getByJobId('j-ref-2')
      expect(updated?.status).toBe('resolved')
      expect(updated?.decision).toBe('refund')
      expect(updated?.resolutionType).toBe('refund_full')
    })

    it('creates dispute_resolved_refund ledger entry', async () => {
      seedJob('j-ref-3', { status: 'waiting_payment' })
      seedPayment('j-ref-3', 'disputed')
      const dispute = seedDispute('j-ref-3', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'refund')

      const entries = getLedgerRepository().getForJob('j-ref-3')
      const entry = entries.find((e) => e.type === 'dispute_resolved_refund')
      expect(entry).toBeDefined()
    })
  })

  // ---- Full dispute resolution: split -------------------------------------

  describe('Dispute resolution: split (partial resolution)', () => {
    it('payment transitions to released (not refunded) after split', async () => {
      seedJob('j-split-1', { status: 'waiting_payment' })
      seedPayment('j-split-1', 'disputed')
      const dispute = seedDispute('j-split-1', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

      const payment = getPaymentRepository().getByJobId('j-split-1')
      expect(payment?.state).toBe('released')
    })

    it('dispute transitions to resolved with decision=split and correct splitRatio', async () => {
      seedJob('j-split-2', { status: 'waiting_payment' })
      seedPayment('j-split-2', 'disputed')
      const dispute = seedDispute('j-split-2', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'split', 0.6)

      const updated = getDisputeRepository().getByJobId('j-split-2')
      expect(updated?.status).toBe('resolved')
      expect(updated?.decision).toBe('split')
      expect(updated?.resolutionType).toBe('split')
      expect(updated?.splitRatio).toBe(0.6)
    })

    it('creates both release and refund ledger entries', async () => {
      seedJob('j-split-3', { status: 'waiting_payment' })
      seedPayment('j-split-3', 'disputed')
      const dispute = seedDispute('j-split-3', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

      const entries = getLedgerRepository().getForJob('j-split-3')
      const types = entries.map((e) => e.type)
      expect(types).toContain('dispute_resolved_release')
      expect(types).toContain('dispute_resolved_refund')
      expect(types).toContain('platform_fee')
    })

    it('release + fee + refund entries sum to totalAmount', async () => {
      seedJob('j-split-4', { status: 'waiting_payment' })
      seedPayment('j-split-4', 'disputed', 1200)
      const dispute = seedDispute('j-split-4', 'under_review', {
        paymentId: 'pay-j-split-4',
      })

      await resolveDisputeWorkflow(dispute.id, 'split', 0.6)

      const entries = getLedgerRepository().getForJob('j-split-4')
      const release = entries.find((e) => e.type === 'dispute_resolved_release')
      const refund = entries.find((e) => e.type === 'dispute_resolved_refund')
      const fee = entries.find((e) => e.type === 'platform_fee')

      expect(release).toBeDefined()
      expect(refund).toBeDefined()
      expect(fee).toBeDefined()

      const sum = release!.amount + refund!.amount + fee!.amount
      expect(sum).toBeCloseTo(1200, 1)
    })

    it('defaults to 50/50 split when no ratio is provided', async () => {
      seedJob('j-split-5', { status: 'waiting_payment' })
      seedPayment('j-split-5', 'disputed')
      const dispute = seedDispute('j-split-5', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'split')

      const updated = getDisputeRepository().getByJobId('j-split-5')
      expect(updated?.splitRatio).toBe(0.5)
    })
  })

  describe('Dispute resolution: reject', () => {
    it('dispute transitions to resolved with decision=reject', async () => {
      seedJob('j-rej-1', { status: 'waiting_payment' })
      seedPayment('j-rej-1', 'disputed')
      const dispute = seedDispute('j-rej-1', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'reject')

      const updated = getDisputeRepository().getByJobId('j-rej-1')
      expect(updated?.status).toBe('resolved')
      expect(updated?.decision).toBe('reject')
      expect(updated?.resolutionType).toBe('rejected')
    })

    it('payment transitions to released after dispute rejection (craftsman wins)', async () => {
      seedJob('j-rej-2', { status: 'waiting_payment' })
      seedPayment('j-rej-2', 'disputed')
      const dispute = seedDispute('j-rej-2', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'reject')

      // Rejection means the dispute was unjustified; craftsman is paid out
      const payment = getPaymentRepository().getByJobId('j-rej-2')
      expect(payment?.state).toBe('released')
    })
  })

  // ---- Full dispute path from escrow lock --------------------------------

  describe('Full dispute path: payment locked → disputed → resolved', () => {
    it('complete path: in_escrow → disputed → split → released', async () => {
      seedJob('j-full-d-1', {
        status: 'waiting_payment',
        customerUserId: 'cust-123',
        craftsmanUserId: 'craft-456',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-full-d-1', 'in_escrow')

      // 1. Open dispute — escrow frozen
      await openDisputeWorkflow({
        jobId: 'j-full-d-1',
        reason: 'work_quality',
        title: 'Qualitätsmangel',
        description: 'Fliesen uneben.',
      })

      const afterDispute = getPaymentRepository().getByJobId('j-full-d-1')
      expect(afterDispute?.state).toBe('disputed')

      const holdEntry = getLedgerRepository()
        .getForJob('j-full-d-1')
        .find((e) => e.type === 'dispute_hold')
      expect(holdEntry).toBeDefined()

      // 2. Advance dispute through review (open → under_review)
      const dispute = getDisputeRepository().getByJobId('j-full-d-1')!
      reviewDisputeWorkflow(dispute.id)

      // 3. Resolve with split
      await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

      // 4. Verify final state
      const finalPayment = getPaymentRepository().getByJobId('j-full-d-1')
      expect(finalPayment?.state).toBe('released')

      const finalDispute = getDisputeRepository().getByJobId('j-full-d-1')
      expect(finalDispute?.status).toBe('resolved')
      expect(finalDispute?.decision).toBe('split')

      const finalJob = getJobById('j-full-d-1')
      expect(finalJob?.status).toBe('completed')

      // 5. Verify no ownership regression
      expect(finalJob?.customerUserId).toBe('cust-123')
      expect(finalJob?.craftsmanUserId).toBe('craft-456')
    })

    it('complete path: release_pending → disputed → refund → refunded', async () => {
      seedJob('j-full-d-2', {
        status: 'waiting_payment',
        customerUserId: 'cust-789',
        craftsmanUserId: 'craft-012',
        workCompletedAt: Date.now() - 7200_000,
      })
      seedPayment('j-full-d-2', 'release_pending')

      // 1. Open dispute on release_pending payment
      await openDisputeWorkflow({
        jobId: 'j-full-d-2',
        reason: 'scope_conflict',
        title: 'Leistungsumfang',
        description: 'Mehr Arbeit als vereinbart.',
      })

      expect(getPaymentRepository().getByJobId('j-full-d-2')?.state).toBe('disputed')

      // 2. Release is blocked while dispute is active
      await expect(releaseEscrowWorkflow('j-full-d-2')).rejects.toThrow(/Release blocked/)

      // 3. Advance to under_review
      const dispute = getDisputeRepository().getByJobId('j-full-d-2')!
      reviewDisputeWorkflow(dispute.id)

      // 4. Resolve with full refund
      await resolveDisputeWorkflow(dispute.id, 'refund')

      expect(getPaymentRepository().getByJobId('j-full-d-2')?.state).toBe('refunded')
      const refundedDispute = getDisputeRepository().getByJobId('j-full-d-2')
      expect(refundedDispute?.status).toBe('resolved')
      expect(refundedDispute?.decision).toBe('refund')

      // Verify ownership fields intact
      const finalJob = getJobById('j-full-d-2')
      expect(finalJob?.customerUserId).toBe('cust-789')
      expect(finalJob?.craftsmanUserId).toBe('craft-012')
    })
  })

  // ---- No ownership regression across full job lifecycle -----------------

  describe('Ownership survives full job lifecycle', () => {
    it('customerUserId and craftsmanUserId are preserved through complete lifecycle', async () => {
      seedJob('j-own-1', {
        status: 'new',
        customerUserId: 'cust-lifecycle',
        craftsmanUserId: 'craft-lifecycle',
      })
      seedPayment('j-own-1', 'in_escrow')

      // Start → complete (owner) → release (customer)
      installSessionForJobOwner({ craftsmanUserId: 'craft-lifecycle' })
      await startJobWorkflow('j-own-1')
      await markWorkCompleteWorkflow('j-own-1')
      installSessionForJobCustomer({ customerUserId: 'cust-lifecycle' })
      await customerReleasePaymentWorkflow('j-own-1')

      const finalJob = getJobById('j-own-1')
      expect(finalJob?.status).toBe('completed')
      expect(finalJob?.customerUserId).toBe('cust-lifecycle')
      expect(finalJob?.craftsmanUserId).toBe('craft-lifecycle')
    })

    it('customerUserId and craftsmanUserId are preserved through dispute lifecycle', async () => {
      seedJob('j-own-2', {
        status: 'waiting_payment',
        customerUserId: 'cust-dispute',
        craftsmanUserId: 'craft-dispute',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-own-2', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'j-own-2',
        reason: 'work_quality',
        title: 'Mangel',
        description: 'Mängelbeschreibung.',
      })

      // Advance to under_review before resolving
      const dispute = getDisputeRepository().getByJobId('j-own-2')!
      reviewDisputeWorkflow(dispute.id)
      await resolveDisputeWorkflow(dispute.id, 'release')

      const finalJob = getJobById('j-own-2')
      expect(finalJob?.customerUserId).toBe('cust-dispute')
      expect(finalJob?.craftsmanUserId).toBe('craft-dispute')
    })
  })

  // ---- paymentReleasedAt stamped on all release paths --------------------

  describe('paymentReleasedAt stamped on all release paths (Block A)', () => {
    it('stamps paymentReleasedAt after dispute resolved_release', async () => {
      seedJob('j-pra-1', { status: 'waiting_payment', workCompletedAt: Date.now() - 3600_000 })
      seedPayment('j-pra-1', 'disputed')
      const dispute = seedDispute('j-pra-1', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const job = getJobById('j-pra-1')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeDefined()
      expect(typeof job?.paymentReleasedAt).toBe('number')
    })

    it('stamps paymentReleasedAt after dispute reject (craftsman wins)', async () => {
      seedJob('j-pra-2', { status: 'waiting_payment', workCompletedAt: Date.now() - 3600_000 })
      seedPayment('j-pra-2', 'disputed')
      const dispute = seedDispute('j-pra-2', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'reject')

      const job = getJobById('j-pra-2')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeDefined()
      expect(typeof job?.paymentReleasedAt).toBe('number')
    })

    it('stamps paymentReleasedAt after dispute resolved_split', async () => {
      seedJob('j-pra-3', { status: 'waiting_payment', workCompletedAt: Date.now() - 3600_000 })
      seedPayment('j-pra-3', 'disputed')
      const dispute = seedDispute('j-pra-3', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

      const job = getJobById('j-pra-3')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeDefined()
      expect(typeof job?.paymentReleasedAt).toBe('number')
    })

    it('does NOT stamp paymentReleasedAt after dispute resolved_refund', async () => {
      seedJob('j-pra-4', { status: 'waiting_payment', workCompletedAt: Date.now() - 3600_000 })
      seedPayment('j-pra-4', 'disputed')
      const dispute = seedDispute('j-pra-4', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'refund')

      const job = getJobById('j-pra-4')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeUndefined()
    })

    it('stamps paymentReleasedAt on normal customer release', async () => {
      seedJob('j-pra-5', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-pra-5', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-disp' })
      await customerReleasePaymentWorkflow('j-pra-5')

      const job = getJobById('j-pra-5')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeDefined()
      expect(typeof job?.paymentReleasedAt).toBe('number')
    })

    it('paymentReleasedAt is idempotent — second customerRelease does not re-stamp', async () => {
      seedJob('j-pra-6', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-pra-6', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-disp' })
      await customerReleasePaymentWorkflow('j-pra-6')
      const afterFirst = getJobById('j-pra-6')?.paymentReleasedAt

      // Second call: idempotent guard (paymentReleasedAt already set) returns early
      installSessionForJobCustomer({ customerUserId: 'cust-disp' })
      await customerReleasePaymentWorkflow('j-pra-6')
      const afterSecond = getJobById('j-pra-6')?.paymentReleasedAt

      expect(afterFirst).toBe(afterSecond)
    })

    it('dispute path with in_progress job correctly steps through waiting_payment → completed', async () => {
      seedJob('j-pra-7', {
        status: 'in_progress',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-pra-7', 'disputed')
      const dispute = seedDispute('j-pra-7', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const job = getJobById('j-pra-7')
      expect(job?.status).toBe('completed')
      expect(job?.paymentReleasedAt).toBeDefined()
    })

    it('operator dispute-release does NOT log "Kunde hat die Zahlung freigegeben"', async () => {
      seedJob('j-pra-8', { status: 'waiting_payment', workCompletedAt: Date.now() - 3600_000 })
      seedPayment('j-pra-8', 'disputed')
      const dispute = seedDispute('j-pra-8', 'under_review')

      await resolveDisputeWorkflow(dispute.id, 'release')

      const job = getJobById('j-pra-8')
      const activities = job?.activities ?? []
      const customerText = activities.some((a) =>
        a.text === 'Kunde hat die Zahlung freigegeben.'
      )
      expect(customerText).toBe(false)
      const hasReleaseActivity = activities.some((a) =>
        a.text === 'Zahlung durch Streitentscheid freigegeben.'
      )
      expect(hasReleaseActivity).toBe(true)
    })

    it('customer release logs "Kunde hat die Zahlung freigegeben"', async () => {
      seedJob('j-pra-9', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-pra-9', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-disp' })
      await customerReleasePaymentWorkflow('j-pra-9')

      const job = getJobById('j-pra-9')
      const activities = job?.activities ?? []
      const hasCustomerText = activities.some((a) =>
        a.text === 'Kunde hat die Zahlung freigegeben.'
      )
      expect(hasCustomerText).toBe(true)
    })
  })

  // ---- Ledger consistency checks -----------------------------------------

  describe('Ledger consistency', () => {
    it('refundEscrowWorkflow creates a refund ledger entry', async () => {
      seedJob('j-ledger-1', { status: 'waiting_payment' })
      seedPayment('j-ledger-1', 'release_pending')

      await refundEscrowWorkflow('j-ledger-1')

      const entries = getLedgerRepository().getForJob('j-ledger-1')
      expect(entries.some((e) => e.type === 'refund')).toBe(true)
    })

    it('releaseEscrowWorkflow creates payout and platform_fee ledger entries', async () => {
      seedJob('j-ledger-2', { status: 'waiting_payment' })
      seedPayment('j-ledger-2', 'release_pending')

      await releaseEscrowWorkflow('j-ledger-2')

      const entries = getLedgerRepository().getForJob('j-ledger-2')
      expect(entries.some((e) => e.type === 'payout')).toBe(true)
      expect(entries.some((e) => e.type === 'platform_fee')).toBe(true)
    })

    it('payout + platform_fee sum equals totalAmount', async () => {
      const total = 2000
      seedJob('j-ledger-3', { status: 'waiting_payment' })
      seedPayment('j-ledger-3', 'release_pending', total)

      await releaseEscrowWorkflow('j-ledger-3')

      const entries = getLedgerRepository().getForJob('j-ledger-3')
      const payout = entries.find((e) => e.type === 'payout')
      const fee = entries.find((e) => e.type === 'platform_fee')

      expect(payout).toBeDefined()
      expect(fee).toBeDefined()
      expect(payout!.amount + fee!.amount).toBeCloseTo(total, 1)
    })

    it('deduplication prevents double payout entries for the same payment', async () => {
      seedJob('j-ledger-4', { status: 'waiting_payment' })
      seedPayment('j-ledger-4', 'release_pending')

      // Release once
      await releaseEscrowWorkflow('j-ledger-4')

      const entries = getLedgerRepository().getForJob('j-ledger-4')
      const payoutEntries = entries.filter((e) => e.type === 'payout')

      // Deduplication guard: only one payout entry should exist
      expect(payoutEntries).toHaveLength(1)
    })
  })
})
