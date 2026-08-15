/**
 * Invoice Selector — Canonical Payment Truth Tests
 *
 * Closes LOGIC-ONLY gaps from Payment Sync Guards block:
 *
 * 1. deriveCustomerInvoiceView: canonical payment.state must win over
 *    job-level mirror fields (paymentReleasedAt, disputeStatus) when both
 *    are present.  Drift between canonical and mirror must not cause wrong
 *    paymentStatus or canReleasePayment.
 *
 * 2. isJobWithoutInvoice: canonical payment parameter must override
 *    job.paymentState when determining invoice relevance.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveCustomerInvoiceView,
  isJobWithoutInvoice,
} from '../../src/lib/invoices/invoiceSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Invoice } from '../../src/lib/invoices/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'waiting_payment',
    amount: '€2.000',
    description: 'Test',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    workCompletedAt: NOW,
    ...overrides,
  }
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    jobId: 'job-1',
    state: 'release_pending',
    amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    jobId: 'job-1',
    invoiceNumber: 'FU-2026-001',
    status: 'issued',
    parties: { issuerName: 'Handwerker GmbH', issuerAddress: 'Berlin 10115', customerName: 'Kunde' },
    lineItems: [{ id: 'li-1', label: 'Arbeit', quantity: 1, unitPrice: 2000, total: 2000 }],
    amounts: { netAmount: 1680.67, taxAmount: 319.33, grossAmount: 2000 },
    issuedAt: NOW,
    issuedAtLabel: '14.04.2026',
    dueAtLabel: '28.04.2026',
    sentAt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// deriveCustomerInvoiceView — canonical payment truth
// ---------------------------------------------------------------------------

describe('deriveCustomerInvoiceView — canonical payment truth', () => {
  it('returns null when workCompletedAt is absent', () => {
    const job = makeJob({ workCompletedAt: undefined })
    expect(deriveCustomerInvoiceView(job)).toBeNull()
  })

  // ── Canonical payment wins over job mirror ────────────────────────────

  it('canonical released overrides stale job mirror (no paymentReleasedAt)', () => {
    // RISK: job has no paymentReleasedAt yet, but canonical payment is released.
    // Old code would show "awaiting_release" — wrong.
    const job = makeJob({ paymentReleasedAt: undefined })
    const payment = makePayment({ state: 'released' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('released')
    expect(vm.paymentStatusLabel).toBe('Zahlung erfolgt')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('canonical disputed overrides stale job mirror (no disputeStatus)', () => {
    // RISK: job.disputeStatus not yet synced, but canonical payment is disputed.
    // Old code would show "awaiting_release" — wrong.
    const job = makeJob({ disputeStatus: undefined })
    const payment = makePayment({ state: 'disputed' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('disputed')
    expect(vm.paymentStatusLabel).toBe('Zahlung eingefroren')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('canonical refunded overrides stale job mirror (no disputeStatus)', () => {
    const job = makeJob({ disputeStatus: undefined })
    const payment = makePayment({ state: 'refunded' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('refunded')
    expect(vm.paymentStatusLabel).toBe('Betrag erstattet')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('canonical release_pending shows awaiting_release with canRelease=true', () => {
    const job = makeJob()
    const payment = makePayment({ state: 'release_pending' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('awaiting_release')
    expect(vm.canReleasePayment).toBe(true)
  })

  it('canonical work_in_progress shows awaiting_release with canRelease=true', () => {
    const job = makeJob()
    const payment = makePayment({ state: 'work_in_progress' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('awaiting_release')
    expect(vm.canReleasePayment).toBe(true)
  })

  // ── Drift scenario: canonical and job mirror disagree ─────────────────

  it('canonical disputed wins even when job.disputeStatus is undefined', () => {
    // Simulates: payment updated to disputed, but job mirror not yet synced.
    const job = makeJob({ disputeStatus: undefined, paymentReleasedAt: undefined })
    const payment = makePayment({ state: 'disputed' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('disputed')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('canonical released wins even when job.paymentReleasedAt is undefined', () => {
    // Simulates: payment released in canonical store, but job mirror not yet synced.
    const job = makeJob({ paymentReleasedAt: undefined })
    const payment = makePayment({ state: 'released' })

    const vm = deriveCustomerInvoiceView(job, payment)!
    expect(vm.paymentStatus).toBe('released')
    expect(vm.canReleasePayment).toBe(false)
  })

  // ── Fallback: no canonical payment available ──────────────────────────

  it('falls back to job.paymentReleasedAt when no payment entity', () => {
    const job = makeJob({ paymentReleasedAt: NOW })

    const vm = deriveCustomerInvoiceView(job, undefined)!
    expect(vm.paymentStatus).toBe('released')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('falls back to job.disputeStatus when no payment entity', () => {
    const job = makeJob({ disputeStatus: 'open' })

    const vm = deriveCustomerInvoiceView(job, undefined)!
    expect(vm.paymentStatus).toBe('disputed')
    expect(vm.canReleasePayment).toBe(false)
  })

  it('terminal job.disputeStatus resolved without payment entity does not block release', () => {
    // Under γ the job.disputeStatus mirrors DisputeStatus and no longer encodes
    // the decision (release vs refund). Without a canonical payment entity the
    // fallback can only tell that the dispute is no longer active.
    const job = makeJob({ disputeStatus: 'resolved', workCompletedAt: 1, paymentReleasedAt: undefined })

    const vm = deriveCustomerInvoiceView(job, undefined)!
    // resolved is non-blocking → falls through to awaiting_release
    expect(vm.paymentStatus).toBe('awaiting_release')
    expect(vm.canReleasePayment).toBe(true)
  })

  it('shows awaiting_release when no payment and no terminal job fields', () => {
    const job = makeJob({ paymentReleasedAt: undefined, disputeStatus: undefined })

    const vm = deriveCustomerInvoiceView(job, undefined)!
    expect(vm.paymentStatus).toBe('awaiting_release')
    expect(vm.canReleasePayment).toBe(true)
  })

  // ── Invoice data passthrough ──────────────────────────────────────────

  it('passes invoice line items and amounts when invoice present', () => {
    const job = makeJob()
    const payment = makePayment({ state: 'release_pending' })
    const invoice = makeInvoice()

    const vm = deriveCustomerInvoiceView(job, payment, invoice)!
    expect(vm.invoiceNumber).toBe('FU-2026-001')
    expect(vm.lineItems).toHaveLength(1)
    expect(vm.totalAmount).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// isJobWithoutInvoice — canonical payment parameter
// ---------------------------------------------------------------------------

describe('isJobWithoutInvoice — canonical payment truth', () => {
  const noInvoice = (_jobId: string) => undefined

  it('detects invoice gap via canonical release_pending (job mirror is stale none)', () => {
    // RISK: job.paymentState is "none" (stale), but canonical says release_pending.
    // Old code (no payment param) would say "not relevant" — wrong.
    const job = makeJob({ status: 'in_progress', paymentState: 'none' })
    const payment = makePayment({ state: 'release_pending' })

    expect(isJobWithoutInvoice(job, payment, noInvoice)).toBe(true)
  })

  it('detects invoice gap via canonical released (job mirror is stale none)', () => {
    const job = makeJob({ status: 'completed', paymentState: 'none' })
    const payment = makePayment({ state: 'released' })

    expect(isJobWithoutInvoice(job, payment, noInvoice)).toBe(true)
  })

  it('falls back to job.paymentState when no payment entity', () => {
    const job = makeJob({ status: 'new', paymentState: 'release_pending' })

    expect(isJobWithoutInvoice(job, undefined, noInvoice)).toBe(true)
  })

  it('returns false when job has an invoice', () => {
    const job = makeJob({ status: 'in_progress' })
    const payment = makePayment({ state: 'work_in_progress' })
    const hasInvoice = (jobId: string) =>
      jobId === 'job-1' ? makeInvoice() : undefined

    expect(isJobWithoutInvoice(job, payment, hasInvoice)).toBe(false)
  })

  it('returns false when job is not invoice-relevant (new, no payment)', () => {
    const job = makeJob({ status: 'new', paymentState: 'none' })

    expect(isJobWithoutInvoice(job, undefined, noInvoice)).toBe(false)
  })

  it('canonical state takes precedence even when job.paymentState is "released"', () => {
    // Edge case: job mirror says released, but canonical says disputed.
    // Invoice relevance should use canonical (disputed is not release_pending/released).
    // But job.status is in_progress, so still invoice-relevant via status.
    const job = makeJob({ status: 'in_progress', paymentState: 'released' })
    const payment = makePayment({ state: 'disputed' })

    // in_progress status makes it relevant regardless of paymentState
    expect(isJobWithoutInvoice(job, payment, noInvoice)).toBe(true)
  })

  it('canonical none + non-relevant status = not relevant', () => {
    const job = makeJob({ status: 'new', paymentState: 'deposit_required' })
    const payment = makePayment({ state: 'none' })

    // status: new + canonical paymentState: none → not invoice-relevant
    expect(isJobWithoutInvoice(job, payment, noInvoice)).toBe(false)
  })
})
