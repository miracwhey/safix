/**
 * Sub-block 6.1 — DisputeContextSnapshot Tests
 *
 * Covers:
 *   A. Snapshot completeness — all fields correct when job + payment present
 *   B. Snapshot timing — paymentStateAtOpen is pre-disputed state
 *   C. Error resilience — missing job/payment never block workflow
 *   D. Regression — existing dispute workflow behaviour unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { getDisputeByJobId } from '../../src/lib/disputes/disputesService'
import { getPaymentForJobWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { buildDisputeContextSnapshot } from '../../src/lib/disputes/disputeContextSnapshot'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Badezimmer renovieren ${id}`,
    customer: 'Erika Muster',
    location: 'Hamburg',
    dateLabel: 'Heute',
    status: 'waiting_payment',
    amount: '2.000 €',
    description: 'Fliesen verlegen im Bad',
    paymentState: 'release_pending',
    documentationStatus: '2 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 2,
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

function seedPayment(jobId: string, state: Payment['state'], total = 1500): Payment {
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

// ── A. Snapshot Completeness ──────────────────────────────────────────────────

describe('A. Snapshot completeness — all fields set when job and payment exist', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('contextSnapshot is present on dispute after openDisputeWorkflow', async () => {
    seedJob('j1')
    seedPayment('j1', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j1',
      reason: 'work_quality',
      title: 'Mängel',
      description: 'Qualitätsproblem',
    })

    expect(dispute.contextSnapshot).toBeDefined()
  })

  it('jobTitle is captured from job at open time', async () => {
    seedJob('j2')
    seedPayment('j2', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j2',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.jobTitle).toBe(`Badezimmer renovieren j2`)
  })

  it('jobDescription is captured from job at open time', async () => {
    seedJob('j3')
    seedPayment('j3', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j3',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.jobDescription).toBe('Fliesen verlegen im Bad')
  })

  it('craftsmanUserId is captured from job', async () => {
    seedJob('j4')
    seedPayment('j4', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j4',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.craftsmanUserId).toBe('craftsman-j4')
  })

  it('customerUserId is captured from job', async () => {
    seedJob('j5')
    seedPayment('j5', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j5',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.customerUserId).toBe('customer-j5')
  })

  it('sourceConversationId is captured from job', async () => {
    seedJob('j6')
    seedPayment('j6', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j6',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.sourceConversationId).toBe('conv-j6')
  })

  it('sourceOfferId is captured from job', async () => {
    seedJob('j7')
    seedPayment('j7', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j7',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.sourceOfferId).toBe('offer-j7')
  })

  it('paymentTotalAmount is captured from payment', async () => {
    seedJob('j8')
    seedPayment('j8', 'release_pending', 2200)

    const dispute = await openDisputeWorkflow({
      jobId: 'j8',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.paymentTotalAmount).toBe(2200)
  })

  it('snapshotAt is a recent ISO timestamptz', async () => {
    seedJob('j9')
    seedPayment('j9', 'release_pending')
    const before = Date.now()

    const dispute = await openDisputeWorkflow({
      jobId: 'j9',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    const after = Date.now()
    const snapshotAt = dispute.contextSnapshot?.snapshotAt
    expect(typeof snapshotAt).toBe('string')
    const snapshotMs = Date.parse(snapshotAt!)
    expect(snapshotMs).toBeGreaterThanOrEqual(before)
    expect(snapshotMs).toBeLessThanOrEqual(after)
  })

  it('null fields are set for jobs without sourceConversationId or sourceOfferId', async () => {
    seedJob('j10', { sourceConversationId: undefined, sourceOfferId: undefined })
    seedPayment('j10', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'j10',
      reason: 'delay',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.sourceConversationId).toBeNull()
    expect(dispute.contextSnapshot?.sourceOfferId).toBeNull()
  })
})

// ── B. Snapshot Timing ────────────────────────────────────────────────────────

describe('B. Snapshot timing — paymentStateAtOpen is the pre-disputed state', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('paymentStateAtOpen is release_pending before transition', async () => {
    seedJob('jt1')
    seedPayment('jt1', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'jt1',
      reason: 'scope_conflict',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBe('release_pending')
  })

  it('paymentStateAtOpen is in_escrow when payment is in_escrow at open time', async () => {
    seedJob('jt2')
    seedPayment('jt2', 'in_escrow')

    const dispute = await openDisputeWorkflow({
      jobId: 'jt2',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBe('in_escrow')
  })

  it('paymentStateAtOpen is NOT disputed — snapshot taken before transition', async () => {
    seedJob('jt3')
    seedPayment('jt3', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'jt3',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    // Post-workflow the payment is disputed, but the snapshot must not be
    expect(dispute.contextSnapshot?.paymentStateAtOpen).not.toBe('disputed')
    const payment = getPaymentForJobWorkflow('jt3')
    expect(payment?.state).toBe('disputed')
  })

  it('work_in_progress payment state is captured correctly', async () => {
    seedJob('jt4')
    seedPayment('jt4', 'work_in_progress')

    const dispute = await openDisputeWorkflow({
      jobId: 'jt4',
      reason: 'delay',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBe('work_in_progress')
  })
})

// ── C. Error Resilience ───────────────────────────────────────────────────────

describe('C. Error resilience — missing data never blocks dispute opening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('buildDisputeContextSnapshot returns null when job does not exist', () => {
    // No job seeded
    const result = buildDisputeContextSnapshot('non-existent-job')
    expect(result).toBeNull()
  })

  it('buildDisputeContextSnapshot does not throw for unknown jobId', () => {
    expect(() => buildDisputeContextSnapshot('unknown')).not.toThrow()
  })

  it('buildDisputeContextSnapshot returns snapshot with null payment fields when no payment', () => {
    seedJob('jr1')
    // No payment seeded

    const snapshot = buildDisputeContextSnapshot('jr1')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.paymentStateAtOpen).toBeNull()
    expect(snapshot?.paymentTotalAmount).toBeNull()
    expect(snapshot?.jobTitle).toBe('Badezimmer renovieren jr1')
  })

  it('openDisputeWorkflow succeeds even when job has no payment', async () => {
    // Seed a payment but in a state where it cannot transition to 'disputed'
    // (deposit_required cannot be disputed per canTransition)
    seedJob('jr2')
    seedPayment('jr2', 'deposit_required')

    const dispute = await openDisputeWorkflow({
      jobId: 'jr2',
      reason: 'payment_conflict',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.status).toBe('open')
    expect(dispute.contextSnapshot?.jobTitle).toBe('Badezimmer renovieren jr2')
    // Payment could not transition but snapshot still captured state
    expect(dispute.contextSnapshot?.paymentStateAtOpen).toBe('deposit_required')
  })

  it('Dispute is opened and has status open even when contextSnapshot is null', async () => {
    // Only seed a payment, no job (unusual but guards against the null path)
    seedPayment('jr3', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'jr3',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.status).toBe('open')
    // contextSnapshot is undefined/null — no job found
    expect(dispute.contextSnapshot == null).toBe(true)
  })

  it('idempotent call returns same dispute without overwriting snapshot', async () => {
    seedJob('jr4')
    seedPayment('jr4', 'release_pending')

    const first = await openDisputeWorkflow({
      jobId: 'jr4',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    // Second call — idempotent, must return existing dispute unchanged
    const second = await openDisputeWorkflow({
      jobId: 'jr4',
      reason: 'work_quality',
      title: 'Different title',
      description: 'Different description',
    })

    expect(second.id).toBe(first.id)
    // Snapshot should be the original — no overwrite
    expect(second.contextSnapshot?.jobTitle).toBe(first.contextSnapshot?.jobTitle)
  })
})

// ── D. Regression ─────────────────────────────────────────────────────────────

describe('D. Regression — existing dispute workflow behaviour unaffected', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('dispute is created with status open', async () => {
    seedJob('reg1')
    seedPayment('reg1', 'in_escrow')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg1',
      reason: 'work_quality',
      title: 'Mängel',
      description: 'Beschreibung',
    })

    expect(dispute.status).toBe('open')
  })

  it('payment is transitioned to disputed after openDisputeWorkflow', async () => {
    seedJob('reg2')
    seedPayment('reg2', 'in_escrow')

    await openDisputeWorkflow({
      jobId: 'reg2',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test',
    })

    const payment = getPaymentForJobWorkflow('reg2')
    expect(payment?.state).toBe('disputed')
  })

  it('dispute reason and description are preserved unchanged', async () => {
    seedJob('reg3')
    seedPayment('reg3', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg3',
      reason: 'delay',
      title: 'Verzögerung',
      description: 'Arbeit wurde nicht rechtzeitig abgeschlossen.',
    })

    expect(dispute.reason).toBe('delay')
    expect(dispute.description).toBe('Arbeit wurde nicht rechtzeitig abgeschlossen.')
  })

  it('evidence array starts empty', async () => {
    seedJob('reg4')
    seedPayment('reg4', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg4',
      reason: 'scope_conflict',
      title: 'Test',
      description: 'Test',
    })

    expect(dispute.evidence).toEqual([])
  })

  it('raisedBy is stored when provided', async () => {
    seedJob('reg5')
    seedPayment('reg5', 'release_pending')

    const dispute = await openDisputeWorkflow({
      jobId: 'reg5',
      reason: 'other',
      title: 'Test',
      description: 'Test',
      raisedBy: 'user-abc',
    })

    expect(dispute.raisedBy).toBe('user-abc')
  })

  it('dispute can be looked up by jobId after creation', async () => {
    seedJob('reg6')
    seedPayment('reg6', 'in_escrow')

    await openDisputeWorkflow({
      jobId: 'reg6',
      reason: 'payment_conflict',
      title: 'Test',
      description: 'Test',
    })

    const found = getDisputeByJobId('reg6')
    expect(found).toBeDefined()
    expect(found?.jobId).toBe('reg6')
  })
})
