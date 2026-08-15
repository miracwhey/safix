import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createPaymentForJob,
  updatePaymentState,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { derivePaymentReconciliationStatus } from '../../src/lib/payments/reconciliation/deriveReconciliationStatus'
import {
  recoverMissedStripeState,
  reconcileJobPaymentAgainstStripe,
} from '../../src/lib/payments/reconciliation/reconciliationService'
import type { StripePaymentSnapshot } from '../../src/lib/payments/reconciliation/types'

import type { PaymentState } from '../../src/lib/payments/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStripe(stripeStatus: string): StripePaymentSnapshot {
  return { paymentIntentId: 'pi_test_123', stripeStatus }
}

/** Advance a payment through a chain of states, stopping at the last one. */
async function advanceThrough(jobId: string, states: PaymentState[]) {
  for (const s of states) {
    await updatePaymentState(jobId, s)
  }
}

// ─── derivePaymentReconciliationStatus ──────────────────────────────────────

describe('derivePaymentReconciliationStatus – pure logic', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── aligned cases ──

  it('DB=released, Stripe=succeeded → aligned', async () => {
    await createPaymentForJob('job-align-1', 1000)
    await advanceThrough('job-align-1', [
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'released',
    ])
    const payment = getPaymentForJob('job-align-1')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))

    expect(result.status).toBe('aligned')
    expect(result.dbState).toBe('released')
    expect(result.note).toContain('released')
    expect(result.note).toContain('succeeded')
  })

  it('DB=refunded, Stripe=canceled → aligned', async () => {
    await createPaymentForJob('job-align-2', 1000)
    await advanceThrough('job-align-2', ['deposit_paid', 'refunded'])
    const payment = getPaymentForJob('job-align-2')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('canceled'))

    expect(result.status).toBe('aligned')
    expect(result.dbState).toBe('refunded')
  })

  it('DB=deposit_paid, Stripe=requires_capture → aligned (already at recommended state)', async () => {
    await createPaymentForJob('job-align-3', 1000)
    await advanceThrough('job-align-3', ['deposit_paid'])
    const payment = getPaymentForJob('job-align-3')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('requires_capture'))

    expect(result.status).toBe('aligned')
    expect(result.dbState).toBe('deposit_paid')
  })

  // ── recoverable cases ──

  it('DB=deposit_required, Stripe=requires_capture → recoverable → deposit_paid', async () => {
    await createPaymentForJob('job-rec-1', 1000)
    const payment = getPaymentForJob('job-rec-1')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('requires_capture'))

    expect(result.status).toBe('recoverable')
    expect(result.dbState).toBe('deposit_required')
    expect(result.recommendedState).toBe('deposit_paid')
    expect(result.note).toContain('deposit_paid')
  })

  it('DB=release_pending, Stripe=succeeded → recoverable → released', async () => {
    await createPaymentForJob('job-rec-2', 1000)
    await advanceThrough('job-rec-2', [
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
    ])
    const payment = getPaymentForJob('job-rec-2')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))

    expect(result.status).toBe('recoverable')
    expect(result.dbState).toBe('release_pending')
    expect(result.recommendedState).toBe('released')
  })

  it('DB=in_escrow, Stripe=canceled → recoverable → refunded', async () => {
    await createPaymentForJob('job-rec-3', 1000)
    await advanceThrough('job-rec-3', ['deposit_paid', 'in_escrow'])
    const payment = getPaymentForJob('job-rec-3')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('canceled'))

    expect(result.status).toBe('recoverable')
    expect(result.dbState).toBe('in_escrow')
    expect(result.recommendedState).toBe('refunded')
  })

  // ── inconsistent cases ──

  it('DB=released, Stripe=requires_capture → inconsistent (terminal DB state)', async () => {
    await createPaymentForJob('job-incon-1', 1000)
    await advanceThrough('job-incon-1', [
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'released',
    ])
    const payment = getPaymentForJob('job-incon-1')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('requires_capture'))

    expect(result.status).toBe('inconsistent')
    expect(result.dbState).toBe('released')
    expect(result.note).toContain('terminal')
  })

  it('DB=work_in_progress, Stripe=succeeded → recoverable (provider recovery allows skip to released)', async () => {
    await createPaymentForJob('job-incon-2', 1000)
    await advanceThrough('job-incon-2', ['deposit_paid', 'in_escrow', 'work_in_progress'])
    const payment = getPaymentForJob('job-incon-2')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))

    expect(result.status).toBe('recoverable')
    expect(result.dbState).toBe('work_in_progress')
    expect(result.recommendedState).toBe('released')
  })

  it('DB=deposit_paid, Stripe=processing → inconsistent (no mapping available)', async () => {
    await createPaymentForJob('job-incon-3', 1000)
    await advanceThrough('job-incon-3', ['deposit_paid'])
    const payment = getPaymentForJob('job-incon-3')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('processing'))

    expect(result.status).toBe('inconsistent')
    expect(result.dbState).toBe('deposit_paid')
    expect(result.note).toContain('No safe auto-recovery path')
  })

  // ── result shape ──

  it('result always includes paymentId, jobId, status, dbState, note, reconciledAt', async () => {
    await createPaymentForJob('job-shape-1', 1000)
    const payment = getPaymentForJob('job-shape-1')!

    const result = derivePaymentReconciliationStatus(payment, makeStripe('requires_capture'))

    expect(result.paymentId).toBe(payment.id)
    expect(result.jobId).toBe('job-shape-1')
    expect(result.status).toBeDefined()
    expect(result.dbState).toBeDefined()
    expect(result.note).toBeTruthy()
    expect(result.reconciledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// ─── recoverMissedStripeState ────────────────────────────────────────────────

describe('recoverMissedStripeState', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('DB=deposit_required, Stripe=requires_capture → recovered=true, state advances to deposit_paid', async () => {
    await createPaymentForJob('job-recover-1', 1000)
    const payment = getPaymentForJob('job-recover-1')!
    expect(payment.state).toBe('deposit_required')

    const result = await recoverMissedStripeState(payment, makeStripe('requires_capture'))

    expect(result.recovered).toBe(true)
    expect(result.status).toBe('recoverable')
    expect(result.recommendedState).toBe('deposit_paid')
    expect(result.note).toContain('Recovered')

    // State was actually persisted
    const updated = getPaymentForJob('job-recover-1')!
    expect(updated.state).toBe('deposit_paid')
  })

  it('DB=release_pending, Stripe=succeeded → recovered=true, state advances to released', async () => {
    await createPaymentForJob('job-recover-2', 1000)
    await advanceThrough('job-recover-2', [
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
    ])
    const payment = getPaymentForJob('job-recover-2')!
    expect(payment.state).toBe('release_pending')

    const result = await recoverMissedStripeState(payment, makeStripe('succeeded'))

    expect(result.recovered).toBe(true)
    expect(result.recommendedState).toBe('released')

    const updated = getPaymentForJob('job-recover-2')!
    expect(updated.state).toBe('released')
  })

  it('DB=released (aligned), Stripe=succeeded → recovered=false (already aligned)', async () => {
    await createPaymentForJob('job-recover-3', 1000)
    await advanceThrough('job-recover-3', [
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'released',
    ])
    const payment = getPaymentForJob('job-recover-3')!
    expect(payment.state).toBe('released')

    const result = await recoverMissedStripeState(payment, makeStripe('succeeded'))

    expect(result.recovered).toBe(false)
    expect(result.status).toBe('aligned')

    // State unchanged
    const after = getPaymentForJob('job-recover-3')!
    expect(after.state).toBe('released')
  })

  it('DB=work_in_progress, Stripe=succeeded → recovered=false (inconsistent, cannot auto-recover)', async () => {
    await createPaymentForJob('job-recover-4', 1000)
    await advanceThrough('job-recover-4', ['deposit_paid', 'in_escrow', 'work_in_progress'])
    const payment = getPaymentForJob('job-recover-4')!
    expect(payment.state).toBe('work_in_progress')

    const result = await recoverMissedStripeState(payment, makeStripe('succeeded'))

    expect(result.recovered).toBe(false)
    expect(result.status).toBe('inconsistent')

    // State unchanged
    const after = getPaymentForJob('job-recover-4')!
    expect(after.state).toBe('work_in_progress')
  })

  it('is idempotent — calling twice when already recovered results in aligned + recovered=false', async () => {
    await createPaymentForJob('job-recover-5', 1000)
    const payment = getPaymentForJob('job-recover-5')!

    // First call recovers
    const first = await recoverMissedStripeState(payment, makeStripe('requires_capture'))
    expect(first.recovered).toBe(true)

    // Second call uses fresh DB state
    const refreshed = getPaymentForJob('job-recover-5')!
    const second = await recoverMissedStripeState(refreshed, makeStripe('requires_capture'))
    expect(second.recovered).toBe(false)
    expect(second.status).toBe('aligned')
  })
})

// ─── reconcileJobPaymentAgainstStripe ────────────────────────────────────────

describe('reconcileJobPaymentAgainstStripe', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('unknown jobId → not_found result', () => {
    const result = reconcileJobPaymentAgainstStripe('job-nonexistent', makeStripe('requires_capture'))

    expect(result.status).toBe('not_found')
    expect(result.jobId).toBe('job-nonexistent')
    expect(result.paymentId).toBe('unknown:job-nonexistent')
    expect(result.note).toContain("No payment found")
    expect(result.reconciledAt).toBeTruthy()
  })

  it('payment with no providerRef → no_provider_ref result', async () => {
    await createPaymentForJob('job-noprov-1', 1000)
    // Payment is created without a providerRef by default

    const result = reconcileJobPaymentAgainstStripe('job-noprov-1', makeStripe('requires_capture'))

    expect(result.status).toBe('no_provider_ref')
    expect(result.jobId).toBe('job-noprov-1')
    expect(result.note).toContain('no providerRef')
  })

  it('payment with providerRef delegates to reconcilePaymentAgainstStripe', async () => {
    await createPaymentForJob('job-prov-1', 1000)
    const payment = getPaymentForJob('job-prov-1')!

    // Inject a providerRef manually so Stripe reconciliation is triggered
    getPaymentRepository().update(payment.id, (p) => ({
      ...p,
      providerRef: 'pi_test_abc',
      updatedAt: Date.now(),
    }))

    const result = reconcileJobPaymentAgainstStripe('job-prov-1', makeStripe('requires_capture'))

    // deposit_required + requires_capture → recoverable
    expect(result.status).toBe('recoverable')
    expect(result.dbState).toBe('deposit_required')
    expect(result.recommendedState).toBe('deposit_paid')
  })
})
