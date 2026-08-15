/**
 * deriveCraftsmanFinanceActions — Canonical Payment Truth Tests
 *
 * Closes LOGIC-ONLY gap from Payment Sync Guards block:
 *
 * deriveCraftsmanFinanceActions delegates to isJobWithoutInvoice which now
 * accepts a canonical Payment parameter.  The opts.getPaymentForJob callback
 * must be wired correctly so that stale job.paymentState does not cause
 * false positives (missing invoice action when not relevant) or false
 * negatives (no action when invoice IS needed).
 */

import { describe, it, expect } from 'vitest'
import { deriveCraftsmanFinanceActions } from '../../src/lib/finance/craftsmanActions'
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
    status: 'in_progress',
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
    ...overrides,
  }
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    jobId: 'job-1',
    state: 'work_in_progress',
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
    parties: { issuerName: 'Handwerker', issuerAddress: 'Berlin', customerName: 'Kunde' },
    lineItems: [],
    amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 },
    issuedAt: NOW,
    issuedAtLabel: '',
    dueAtLabel: '',
    sentAt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveCraftsmanFinanceActions — canonical payment wiring', () => {
  it('detects jobs-without-invoice via canonical payment (stale job mirror)', () => {
    // RISK: job.paymentState is "none" (stale), canonical says "release_pending".
    // Without canonical wiring, isJobWithoutInvoice would not flag this job.
    const job = makeJob({ id: 'job-1', status: 'in_progress', paymentState: 'none' })
    const payment = makePayment({ jobId: 'job-1', state: 'release_pending' })

    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'payout_ready',
      disputesWithContext: [],
      jobs: [job],
      invoices: [],
      getInvoiceByJobId: () => undefined,
      getPaymentForJob: (jobId) => (jobId === 'job-1' ? payment : undefined),
    })

    const invoiceAction = actions.find((a) => a.id === 'invoices-missing')
    expect(invoiceAction).toBeDefined()
    expect(invoiceAction!.label).toContain('ohne Rechnung')
  })

  it('does NOT flag invoice-missing when job has invoice', () => {
    const job = makeJob({ id: 'job-1', status: 'in_progress' })
    const payment = makePayment({ jobId: 'job-1', state: 'work_in_progress' })
    const invoice = makeInvoice({ jobId: 'job-1' })

    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'payout_ready',
      disputesWithContext: [],
      jobs: [job],
      invoices: [invoice],
      getInvoiceByJobId: (jobId) => (jobId === 'job-1' ? invoice : undefined),
      getPaymentForJob: (jobId) => (jobId === 'job-1' ? payment : undefined),
    })

    expect(actions.find((a) => a.id === 'invoices-missing')).toBeUndefined()
  })

  it('does NOT flag invoice-missing for non-relevant job (new, no canonical payment)', () => {
    const job = makeJob({ id: 'job-1', status: 'new', paymentState: 'none' })

    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'payout_ready',
      disputesWithContext: [],
      jobs: [job],
      invoices: [],
      getInvoiceByJobId: () => undefined,
      getPaymentForJob: () => undefined,
    })

    expect(actions.find((a) => a.id === 'invoices-missing')).toBeUndefined()
  })

  it('counts multiple jobs without invoice correctly', () => {
    const jobs = [
      makeJob({ id: 'job-a', status: 'in_progress', paymentState: 'none' }),
      makeJob({ id: 'job-b', status: 'waiting_payment', paymentState: 'none' }),
    ]
    const payments: Record<string, Payment> = {
      'job-a': makePayment({ jobId: 'job-a', state: 'work_in_progress' }),
      'job-b': makePayment({ jobId: 'job-b', state: 'release_pending' }),
    }

    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'payout_ready',
      disputesWithContext: [],
      jobs,
      invoices: [],
      getInvoiceByJobId: () => undefined,
      getPaymentForJob: (jobId) => payments[jobId],
    })

    const invoiceAction = actions.find((a) => a.id === 'invoices-missing')
    expect(invoiceAction).toBeDefined()
    expect(invoiceAction!.label).toContain('2 Jobs ohne Rechnung')
  })

  it('canonical payment undefined falls back to job.paymentState for relevance', () => {
    // No payment entity yet, but job.paymentState says release_pending (unlikely but valid fallback)
    const job = makeJob({ id: 'job-1', status: 'new', paymentState: 'release_pending' })

    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'payout_ready',
      disputesWithContext: [],
      jobs: [job],
      invoices: [],
      getInvoiceByJobId: () => undefined,
      getPaymentForJob: () => undefined,
    })

    const invoiceAction = actions.find((a) => a.id === 'invoices-missing')
    expect(invoiceAction).toBeDefined()
  })

  // ── Other actions still work alongside canonical wiring ───────────────

  it('payout setup action still surfaces when payout not ready', () => {
    const actions = deriveCraftsmanFinanceActions({
      payoutReadiness: 'no_account',
      disputesWithContext: [],
      jobs: [],
      invoices: [],
      getInvoiceByJobId: () => undefined,
      getPaymentForJob: () => undefined,
    })

    expect(actions.find((a) => a.id === 'payout-setup')).toBeDefined()
  })
})
