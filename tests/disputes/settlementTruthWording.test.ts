/**
 * Settlement-Truth Wording — Table-Driven Behavioral Coverage (PAY-STATE)
 *
 * Locks the "money has not moved until settled" wording across the two
 * customer-facing settlement selectors so neither surface can ever render a
 * terminal "money moved" claim while a dispute decision is still settling:
 *
 *   1. deriveCustomerDisputeDisplay (disputeSelectors)
 *        tone/label over {refund, release, split, reject} × {pending, settled}
 *        + the no-dispute and cancelled cases.
 *
 *   2. deriveJobCompletionSummary — settlementPending branch (jobCompletionSelectors)
 *        headline/summary/badgeLabel over the same matrix + no-dispute + cancelled.
 *
 * Settlement convention under test: `settled = settlementStatus === 'settled'`.
 * The settling DIRECTION follows the dispute DECISION, never `isFullyPaid`
 * (payment.state may already read released/refunded before funds actually move).
 *
 * Per the FixUp Money/FSM behavioral-coverage rule, money-truth wording is
 * pinned by an explicit table, not left to ad-hoc card logic.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'

import { deriveCustomerDisputeDisplay } from '../../src/lib/disputes/disputeSelectors'
import { deriveJobCompletionSummary } from '../../src/lib/jobs/jobCompletionSelectors'

import type { Dispute, DisputeDecision } from '../../src/lib/disputes/types'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment, PaymentState } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOB_ID = 'job-settle-1'

function seedCompletedJob(): Job {
  const now = Date.now()
  const job: Job = {
    id: JOB_ID,
    projectId: `project-${JOB_ID}`,
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Hannover',
    dateLabel: 'Heute',
    status: 'completed',
    amount: '1.000 €',
    description: 'Test description',
    paymentState: 'released',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    workCompletedAt: now,
    paymentReleasedAt: now,
  }
  getJobRepository().add(job)
  return job
}

function makePayment(state: PaymentState): Payment {
  return {
    id: `pay-${JOB_ID}`,
    jobId: JOB_ID,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeDispute(
  decision: DisputeDecision,
  settlementStatus: 'pending' | 'settled',
): Dispute {
  return {
    id: `dispute-${JOB_ID}`,
    jobId: JOB_ID,
    status: 'resolved',
    decision,
    settlementStatus,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const DECISIONS: DisputeDecision[] = ['refund', 'release', 'split', 'reject']
const REFUND_DIRECTION = new Set<DisputeDecision>(['refund', 'split'])

// ===========================================================================
// 1. deriveCustomerDisputeDisplay
// ===========================================================================

describe('deriveCustomerDisputeDisplay — settlement-aware tone/label', () => {
  describe.each(DECISIONS)('decision = %s', (decision) => {
    it('pending → settling tone with decision-driven label', () => {
      const display = deriveCustomerDisputeDisplay(
        makeDispute(decision, 'pending'),
      )
      expect(display.tone).toBe('settling')
      expect(display.label).toBe(
        REFUND_DIRECTION.has(decision)
          ? 'Erstattung wird verarbeitet'
          : 'Auszahlung wird verarbeitet',
      )
    })

    it('settled → terminal resolved tone (decision-independent)', () => {
      const display = deriveCustomerDisputeDisplay(
        makeDispute(decision, 'settled'),
      )
      expect(display.tone).toBe('resolved')
      expect(display.label).toBe('Konflikt gelöst')
    })
  })

  it('no dispute → none tone', () => {
    const display = deriveCustomerDisputeDisplay(undefined)
    expect(display).toEqual({ label: 'Kein Konflikt', tone: 'none' })
  })

  it('cancelled dispute → cancelled tone, never settling', () => {
    const display = deriveCustomerDisputeDisplay({
      status: 'cancelled',
      decision: 'refund',
      settlementStatus: 'pending',
    })
    expect(display).toEqual({ label: 'Konflikt storniert', tone: 'cancelled' })
  })
})

// ===========================================================================
// 2. deriveJobCompletionSummary — settlementPending branch
// ===========================================================================

describe('deriveJobCompletionSummary — settlement-truth headline/summary/badge', () => {
  beforeEach(() => {
    setupCleanRepositories()
    seedCompletedJob()
  })

  describe.each(DECISIONS)('decision = %s', (decision) => {
    it('pending → IN ABWICKLUNG with decision-driven (not isFullyPaid-driven) copy', () => {
      // payment.state='released' → isFullyPaid=true for EVERY decision; the
      // settling copy must still follow the decision, proving it is not keyed
      // on isFullyPaid.
      const vm = deriveJobCompletionSummary(
        seedCompletedJob(),
        makePayment('released'),
        makeDispute(decision, 'pending'),
      )
      expect(vm).not.toBeNull()
      expect(vm!.settlementPending).toBe(true)
      expect(vm!.badgeLabel).toBe('IN ABWICKLUNG')
      if (REFUND_DIRECTION.has(decision)) {
        expect(vm!.headline).toBe('Auftrag abgeschlossen – Erstattung wird verarbeitet')
        expect(vm!.summary).toContain('Rückerstattung')
      } else {
        expect(vm!.headline).toBe('Auftrag abgeschlossen – Auszahlung wird verarbeitet')
        expect(vm!.summary).toContain('Auszahlung')
      }
    })

    it('settled → terminal ABGESCHLOSSEN copy (no settling)', () => {
      // Realistic terminal payment state per decision direction.
      const paymentState: PaymentState = REFUND_DIRECTION.has(decision)
        ? 'refunded'
        : 'released'
      const vm = deriveJobCompletionSummary(
        seedCompletedJob(),
        makePayment(paymentState),
        makeDispute(decision, 'settled'),
      )
      expect(vm).not.toBeNull()
      expect(vm!.settlementPending).toBe(false)
      expect(vm!.badgeLabel).toBe('ABGESCHLOSSEN')
      if (REFUND_DIRECTION.has(decision)) {
        expect(vm!.headline).toBe('Auftrag abgeschlossen – Betrag erstattet')
      } else {
        expect(vm!.headline).toBe('Auftrag erfolgreich abgeschlossen')
      }
    })
  })

  it('no dispute → terminal success, never settling', () => {
    const vm = deriveJobCompletionSummary(
      seedCompletedJob(),
      makePayment('released'),
    )
    expect(vm).not.toBeNull()
    expect(vm!.settlementPending).toBe(false)
    expect(vm!.badgeLabel).toBe('ABGESCHLOSSEN')
    expect(vm!.headline).toBe('Auftrag erfolgreich abgeschlossen')
  })

  it('cancelled dispute → not settling (terminal copy)', () => {
    const vm = deriveJobCompletionSummary(
      seedCompletedJob(),
      makePayment('released'),
      { ...makeDispute('refund', 'pending'), status: 'cancelled' },
    )
    expect(vm).not.toBeNull()
    expect(vm!.settlementPending).toBe(false)
    expect(vm!.badgeLabel).toBe('ABGESCHLOSSEN')
    expect(vm!.headline).toBe('Auftrag erfolgreich abgeschlossen')
  })
})
