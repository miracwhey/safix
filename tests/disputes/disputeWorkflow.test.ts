import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  openDisputeWorkflow,
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import { getPaymentForJobWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { createPaymentForJob, updatePaymentState } from '../../src/lib/payments/service'
import { createLedgerEntry } from '../../src/lib/payments/ledger/ledgerService'
import { getDisputeByJobId } from '../../src/lib/disputes/disputesService'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import type { Dispute } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'

/** Helper: add a payment at a specific state directly to the repository */
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

/** Helper: add a dispute at a specific status directly to the repository */
function seedDispute(jobId: string, status: Dispute['status']): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

describe('Dispute Workflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('openDisputeWorkflow', () => {
    it('creates a dispute with status open', async () => {
      seedPayment('job-d1', 'in_escrow')

      const dispute = await openDisputeWorkflow({
        jobId: 'job-d1',
        reason: 'work_quality',
        title: 'Mängel am Werk',
        description: 'Die Arbeit entspricht nicht den vereinbarten Standards.',
      })

      expect(dispute.status).toBe('open')
      expect(dispute.jobId).toBe('job-d1')
    })

    it('transitions payment from in_escrow → disputed', async () => {
      seedPayment('job-d2', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d2',
        reason: 'work_quality',
        title: 'Qualitätsmangel',
        description: 'Mangel beschrieben.',
      })

      const payment = getPaymentForJobWorkflow('job-d2')
      expect(payment?.state).toBe('disputed')
    })

    it('creates a dispute_hold ledger entry when escrow is frozen', async () => {
      seedPayment('job-d3', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d3',
        reason: 'scope_conflict',
        title: 'Leistungsumfang unklar',
        description: 'Keine Einigung über den Umfang.',
      })

      const entries = getLedgerRepository().getForJob('job-d3')
      const holdEntry = entries.find((e) => e.type === 'dispute_hold')
      expect(holdEntry).toBeDefined()
      expect(holdEntry!.amount).toBe(1000)
    })

    it('does not transition payment when state is deposit_required (not in escrow)', async () => {
      seedPayment('job-d4', 'deposit_required')

      await openDisputeWorkflow({
        jobId: 'job-d4',
        reason: 'payment_conflict',
        title: 'Zahlungskonflikt',
        description: 'Konflikt beschrieben.',
      })

      // Payment should remain in deposit_required (cannot be disputed pre-escrow)
      const payment = getPaymentForJobWorkflow('job-d4')
      expect(payment?.state).toBe('deposit_required')
    })

    it('is idempotent — calling twice returns the existing dispute', async () => {
      seedPayment('job-d5', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d5',
        reason: 'delay',
        title: 'Verzögerung',
        description: 'Arbeit wurde nicht rechtzeitig abgeschlossen.',
      })

      const secondCall = await openDisputeWorkflow({
        jobId: 'job-d5',
        reason: 'delay',
        title: 'Verzögerung',
        description: 'Doppelaufruf.',
      })

      const dispute = getDisputeByJobId('job-d5')
      expect(secondCall.id).toBe(dispute?.id)
    })
  })

  describe('dispute escrow freeze', () => {
    it('escrow is frozen after dispute open — dispute_hold amount equals totalAmount', async () => {
      await createPaymentForJob('job-d6', 1500)
      await updatePaymentState('job-d6', 'deposit_paid')
      await updatePaymentState('job-d6', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d6',
        reason: 'work_quality',
        title: 'Qualitätsmangel',
        description: 'Mangel festgestellt.',
      })

      const entries = getLedgerRepository().getForJob('job-d6')
      const holdEntry = entries.find((e) => e.type === 'dispute_hold')
      expect(holdEntry).toBeDefined()
      expect(holdEntry!.amount).toBe(1500)
    })
  })

  describe('dispute resolution ledger entries', () => {
    it('resolving dispute with release creates dispute_resolved_release entry', async () => {
      // Seed: payment in disputed state + dispute in under_review (ready to resolve)
      seedPayment('job-d7', 'disputed')
      seedDispute('job-d7', 'under_review')

      // Manually create the dispute_hold ledger entry (would normally be created
      // when the payment transitioned to disputed)
      createLedgerEntry({
        paymentId: 'pay-job-d7',
        jobId: 'job-d7',
        type: 'dispute_hold',
        amount: 1000,
        disputeId: 'dispute-job-d7',
      })

      await resolveDisputeReleaseWorkflow('job-d7')

      const entries = getLedgerRepository().getForJob('job-d7')
      const resolvedEntry = entries.find((e) => e.type === 'dispute_resolved_release')
      expect(resolvedEntry).toBeDefined()
      expect(resolvedEntry!.disputeId).toBe('dispute-job-d7')
    })

    it('resolving dispute with refund creates dispute_resolved_refund entry', async () => {
      seedPayment('job-d8', 'disputed')
      seedDispute('job-d8', 'under_review')

      await resolveDisputeRefundWorkflow('job-d8')

      const entries = getLedgerRepository().getForJob('job-d8')
      const resolvedEntry = entries.find((e) => e.type === 'dispute_resolved_refund')
      expect(resolvedEntry).toBeDefined()
    })
  })
})
