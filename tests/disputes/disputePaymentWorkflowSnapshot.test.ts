/**
 * Sub-block 6.2 — DisputeContextSnapshot in disputePaymentWorkflow
 *
 * Covers:
 *   A. Snapshot present — disputePaymentWorkflow produces a dispute with contextSnapshot
 *   B. Snapshot timing — paymentStateAtOpen is the pre-dispute state, not 'disputed'
 *   C. Error resilience — missing context never blocks the workflow
 *   D. Consistency — snapshot structure is equivalent to openDisputeWorkflow output
 *   E. Regression — existing payment/dispute workflow behaviour unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { disputePaymentWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
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
    title: `Küche einbauen ${id}`,
    customer: 'Hans Müller',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '3.000 €',
    description: 'Küchenmontage komplett',
    paymentState: 'in_escrow',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
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

function seedPayment(jobId: string, state: Payment['state'], total = 3000): Payment {
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

// ── A. Snapshot present ───────────────────────────────────────────────────────

describe('A. Snapshot present — disputePaymentWorkflow attaches contextSnapshot', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('dispute has contextSnapshot after disputePaymentWorkflow', async () => {
    seedJob('dp1')
    seedPayment('dp1', 'in_escrow')

    await disputePaymentWorkflow('dp1')

    const dispute = getDisputeByJobId('dp1')
    expect(dispute?.contextSnapshot).toBeDefined()
  })

  it('contextSnapshot.jobTitle is captured from job', async () => {
    seedJob('dp2')
    seedPayment('dp2', 'in_escrow')

    await disputePaymentWorkflow('dp2')

    const dispute = getDisputeByJobId('dp2')
    expect(dispute?.contextSnapshot?.jobTitle).toBe('Küche einbauen dp2')
  })

  it('contextSnapshot.craftsmanUserId is set', async () => {
    seedJob('dp3')
    seedPayment('dp3', 'in_escrow')

    await disputePaymentWorkflow('dp3')

    const dispute = getDisputeByJobId('dp3')
    expect(dispute?.contextSnapshot?.craftsmanUserId).toBe('craftsman-dp3')
  })

  it('contextSnapshot.customerUserId is set', async () => {
    seedJob('dp4')
    seedPayment('dp4', 'in_escrow')

    await disputePaymentWorkflow('dp4')

    const dispute = getDisputeByJobId('dp4')
    expect(dispute?.contextSnapshot?.customerUserId).toBe('customer-dp4')
  })

  it('contextSnapshot.sourceConversationId is set', async () => {
    seedJob('dp5')
    seedPayment('dp5', 'in_escrow')

    await disputePaymentWorkflow('dp5')

    const dispute = getDisputeByJobId('dp5')
    expect(dispute?.contextSnapshot?.sourceConversationId).toBe('conv-dp5')
  })

  it('contextSnapshot.sourceOfferId is set', async () => {
    seedJob('dp6')
    seedPayment('dp6', 'in_escrow')

    await disputePaymentWorkflow('dp6')

    const dispute = getDisputeByJobId('dp6')
    expect(dispute?.contextSnapshot?.sourceOfferId).toBe('offer-dp6')
  })

  it('contextSnapshot.paymentTotalAmount matches the seeded payment', async () => {
    seedJob('dp7')
    seedPayment('dp7', 'in_escrow', 4500)

    await disputePaymentWorkflow('dp7')

    const dispute = getDisputeByJobId('dp7')
    expect(dispute?.contextSnapshot?.paymentTotalAmount).toBe(4500)
  })
})

// ── B. Snapshot timing ────────────────────────────────────────────────────────

describe('B. Snapshot timing — paymentStateAtOpen is the pre-dispute state', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('paymentStateAtOpen is in_escrow when payment was in_escrow', async () => {
    seedJob('dt1')
    seedPayment('dt1', 'in_escrow')

    await disputePaymentWorkflow('dt1')

    const dispute = getDisputeByJobId('dt1')
    expect(dispute?.contextSnapshot?.paymentStateAtOpen).toBe('in_escrow')
  })

  it('paymentStateAtOpen is work_in_progress when payment was work_in_progress', async () => {
    seedJob('dt2')
    seedPayment('dt2', 'work_in_progress')

    await disputePaymentWorkflow('dt2')

    const dispute = getDisputeByJobId('dt2')
    expect(dispute?.contextSnapshot?.paymentStateAtOpen).toBe('work_in_progress')
  })

  it('paymentStateAtOpen is NOT disputed — snapshot taken before state transition', async () => {
    seedJob('dt3')
    seedPayment('dt3', 'release_pending')

    await disputePaymentWorkflow('dt3')

    const dispute = getDisputeByJobId('dt3')
    // Snapshot must capture pre-dispute state
    expect(dispute?.contextSnapshot?.paymentStateAtOpen).not.toBe('disputed')
    expect(dispute?.contextSnapshot?.paymentStateAtOpen).toBe('release_pending')
  })
})

// ── C. Error resilience ───────────────────────────────────────────────────────

describe('C. Error resilience — missing context never blocks workflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('returns undefined and does not throw when job does not exist', async () => {
    seedPayment('dr1', 'in_escrow')
    // No job seeded

    await expect(disputePaymentWorkflow('dr1')).resolves.toBeUndefined()
  })

  it('returns undefined and does not throw when payment does not exist', async () => {
    seedJob('dr2')
    // No payment seeded

    await expect(disputePaymentWorkflow('dr2')).resolves.toBeUndefined()
  })

  it('returns undefined when payment cannot transition to disputed', async () => {
    seedJob('dr3')
    seedPayment('dr3', 'deposit_required')

    await expect(disputePaymentWorkflow('dr3')).resolves.toBeUndefined()
  })

  it('workflow succeeds even when job has no sourceConversationId or sourceOfferId', async () => {
    seedJob('dr4', { sourceConversationId: undefined, sourceOfferId: undefined })
    seedPayment('dr4', 'in_escrow')

    await disputePaymentWorkflow('dr4')

    const dispute = getDisputeByJobId('dr4')
    expect(dispute).toBeDefined()
    expect(dispute?.contextSnapshot?.sourceConversationId).toBeNull()
    expect(dispute?.contextSnapshot?.sourceOfferId).toBeNull()
  })
})

// ── D. Consistency ────────────────────────────────────────────────────────────

describe('D. Consistency — snapshot structure matches openDisputeWorkflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('both workflows produce contextSnapshot with the same set of keys', async () => {
    seedJob('dc1')
    seedPayment('dc1', 'in_escrow')
    await disputePaymentWorkflow('dc1')
    const dPayment = getDisputeByJobId('dc1')

    setupCleanRepositories()

    seedJob('dc2')
    seedPayment('dc2', 'in_escrow')
    await openDisputeWorkflow({
      jobId: 'dc2',
      reason: 'work_quality',
      title: 'Mängel',
      description: 'Test',
    })
    const dOpen = getDisputeByJobId('dc2')

    const keysPayment = Object.keys(dPayment?.contextSnapshot ?? {}).sort()
    const keysOpen = Object.keys(dOpen?.contextSnapshot ?? {}).sort()

    expect(keysPayment).toEqual(keysOpen)
  })

  it('both workflows capture the same paymentStateAtOpen for equivalent pre-states', async () => {
    seedJob('dc3')
    seedPayment('dc3', 'release_pending')
    await disputePaymentWorkflow('dc3')
    const dPayment = getDisputeByJobId('dc3')

    setupCleanRepositories()

    seedJob('dc4')
    seedPayment('dc4', 'release_pending')
    await openDisputeWorkflow({
      jobId: 'dc4',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })
    const dOpen = getDisputeByJobId('dc4')

    expect(dPayment?.contextSnapshot?.paymentStateAtOpen).toBe(
      dOpen?.contextSnapshot?.paymentStateAtOpen
    )
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — existing payment/dispute workflow behaviour unaffected', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('returned Payment object exists and is defined', async () => {
    seedJob('re1')
    seedPayment('re1', 'in_escrow')

    const result = await disputePaymentWorkflow('re1')

    expect(result).toBeDefined()
  })

  it('dispute is created with reason payment_conflict', async () => {
    seedJob('re2')
    seedPayment('re2', 'in_escrow')

    await disputePaymentWorkflow('re2')

    const dispute = getDisputeByJobId('re2')
    expect(dispute?.reason).toBe('payment_conflict')
  })

  it('dispute status is open', async () => {
    seedJob('re3')
    seedPayment('re3', 'in_escrow')

    await disputePaymentWorkflow('re3')

    const dispute = getDisputeByJobId('re3')
    expect(dispute?.status).toBe('open')
  })

  it('raisedByUserId is stored on dispute when provided', async () => {
    seedJob('re4')
    seedPayment('re4', 'in_escrow')

    await disputePaymentWorkflow('re4', 'user-xyz')

    const dispute = getDisputeByJobId('re4')
    expect(dispute?.raisedBy).toBe('user-xyz')
  })

  it('evidence array starts empty', async () => {
    seedJob('re5')
    seedPayment('re5', 'in_escrow')

    await disputePaymentWorkflow('re5')

    const dispute = getDisputeByJobId('re5')
    expect(dispute?.evidence).toEqual([])
  })
})
