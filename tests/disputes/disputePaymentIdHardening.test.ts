/**
 * Sub-block 6.3 — paymentId Hardening in Dispute Opening Paths
 *
 * Covers:
 *   A. Payment path — disputePaymentWorkflow always sets paymentId
 *   B. Standard path — openDisputeWorkflow sets paymentId when payment exists
 *   C. Optional path — openDisputeWorkflow stays robust when no payment exists
 *   D. Regression — snapshot behaviour from 6.1/6.2 unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { disputePaymentWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getDisputeByJobId } from '../../src/lib/disputes/disputesService'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Dach reparieren ${id}`,
    customer: 'Max Mustermann',
    location: 'München',
    dateLabel: 'Morgen',
    status: 'waiting_payment',
    amount: '1.200 €',
    description: 'Dachziegel erneuern',
    paymentState: 'release_pending',
    documentationStatus: '1 Foto',
    assignedMemberIds: [],
    notes: [],
    photoCount: 1,
    activities: [],
    craftsmanUserId: `craftsman-${id}`,
    customerUserId: `customer-${id}`,
    sourceConversationId: `conv-${id}`,
    sourceOfferId: `offer-${id}`,
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state'], total = 1200): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: {
      totalAmount: total,
      depositAmount: total * 0.25,
      finalAmount: total * 0.75,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

// ── A. Payment path ───────────────────────────────────────────────────────────

describe('A. Payment path — disputePaymentWorkflow always sets paymentId', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('paymentId is set on dispute when opened via disputePaymentWorkflow', async () => {
    seedJob('pid1')
    seedPayment('pid1', 'in_escrow')

    await disputePaymentWorkflow('pid1')

    const dispute = getDisputeByJobId('pid1')
    expect(dispute?.paymentId).toBeDefined()
    expect(dispute?.paymentId).not.toBe('')
  })

  it('paymentId matches the seeded payment id', async () => {
    seedJob('pid2')
    seedPayment('pid2', 'in_escrow')

    await disputePaymentWorkflow('pid2')

    const dispute = getDisputeByJobId('pid2')
    expect(dispute?.paymentId).toBe('pay-pid2')
  })

  it('paymentId is set for work_in_progress payments', async () => {
    seedJob('pid3')
    seedPayment('pid3', 'work_in_progress')

    await disputePaymentWorkflow('pid3')

    const dispute = getDisputeByJobId('pid3')
    expect(dispute?.paymentId).toBe('pay-pid3')
  })

  it('paymentId is set for release_pending payments', async () => {
    seedJob('pid4')
    seedPayment('pid4', 'release_pending')

    await disputePaymentWorkflow('pid4')

    const dispute = getDisputeByJobId('pid4')
    expect(dispute?.paymentId).toBe('pay-pid4')
  })
})

// ── B. Standard path ──────────────────────────────────────────────────────────

describe('B. Standard path — openDisputeWorkflow sets paymentId when payment exists', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('paymentId is set when payment is in_escrow', async () => {
    seedJob('std1')
    seedPayment('std1', 'in_escrow')

    const dispute = await openDisputeWorkflow({
      jobId: 'std1',
      reason: 'work_quality',
      title: 'Mängel',
      description: 'Test',
    })

    expect(dispute.paymentId).toBe('pay-std1')
  })

  it('paymentId is set when payment is release_pending', async () => {
    seedJob('std2')
    seedPayment('std2', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'std2',
      reason: 'scope_conflict',
      title: 'Umfang',
      description: 'Test',
    })

    expect(dispute.paymentId).toBe('pay-std2')
  })

  it('paymentId is set even when payment cannot transition to disputed (pre-escrow)', async () => {
    // deposit_required cannot be disputed per state machine, but the dispute
    // is still opened — and paymentId should still be captured.
    seedJob('std3')
    seedPayment('std3', 'deposit_required')

    const dispute = await openDisputeWorkflow({
      jobId: 'std3',
      reason: 'payment_conflict',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.paymentId).toBe('pay-std3')
  })
})

// ── C. Optional path ──────────────────────────────────────────────────────────

describe('C. Optional path — openDisputeWorkflow stays robust when no payment exists', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('dispute is opened successfully when no payment exists for the job', async () => {
    seedJob('opt1')
    // No payment seeded

    const dispute = await openDisputeWorkflow({
      jobId: 'opt1',
      reason: 'other',
      title: 'Test ohne Zahlung',
      description: 'Kein Payment vorhanden',
    })

    expect(dispute.status).toBe('open')
  })

  it('paymentId is undefined when no payment exists', async () => {
    seedJob('opt2')
    // No payment seeded

    const dispute = await openDisputeWorkflow({
      jobId: 'opt2',
      reason: 'delay',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.paymentId).toBeUndefined()
  })

  it('contextSnapshot is still built even without a payment', async () => {
    seedJob('opt3')
    // No payment seeded

    const dispute = await openDisputeWorkflow({
      jobId: 'opt3',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    // Snapshot present with null payment fields, job fields populated
    expect(dispute.contextSnapshot).toBeDefined()
    expect(dispute.contextSnapshot?.jobTitle).toBe('Dach reparieren opt3')
    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBeNull()
    expect(dispute.contextSnapshot?.paymentTotalAmount).toBeNull()
  })
})

// ── D. Regression ─────────────────────────────────────────────────────────────

describe('D. Regression — snapshot behaviour from 6.1/6.2 unaffected', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('contextSnapshot is still present alongside paymentId (openDisputeWorkflow)', async () => {
    seedJob('reg1')
    seedPayment('reg1', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg1',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.paymentId).toBe('pay-reg1')
    expect(dispute.contextSnapshot).toBeDefined()
    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBe('release_pending')
    expect(dispute.contextSnapshot?.paymentStateAtOpen).not.toBe('disputed')
  })

  it('contextSnapshot is still present alongside paymentId (disputePaymentWorkflow)', async () => {
    seedJob('reg2')
    seedPayment('reg2', 'in_escrow')

    await disputePaymentWorkflow('reg2')

    const dispute = getDisputeByJobId('reg2')
    expect(dispute?.paymentId).toBe('pay-reg2')
    expect(dispute?.contextSnapshot).toBeDefined()
    expect(dispute?.contextSnapshot?.paymentStateAtOpen).toBe('in_escrow')
  })

  it('dispute status is open in both paths', async () => {
    seedJob('reg3')
    seedPayment('reg3', 'in_escrow')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg3',
      reason: 'delay',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.status).toBe('open')
  })

  it('idempotent re-open returns same dispute with same paymentId', async () => {
    seedJob('reg4')
    seedPayment('reg4', 'release_pending')

    const first = await openDisputeWorkflow({
      jobId: 'reg4',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    const second = await openDisputeWorkflow({
      jobId: 'reg4',
      reason: 'work_quality',
      title: 'Duplicate',
      description: 'Duplicate',
    })

    expect(second.id).toBe(first.id)
    expect(second.paymentId).toBe(first.paymentId)
  })
})
