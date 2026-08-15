/**
 * Block 8 / Sub-block 8.1 — Invoice Sync Guard + sentAt
 *
 * Verifies:
 *   A. Draft guard — syncInvoiceWithPayment never advances a draft invoice
 *   B. sentAt timestamp — set correctly on issued → sent transition
 *   C. Non-draft sync advancement — issued/sent invoices advance normally
 *   D. Mapping — deposit_required maps to 'draft' (not 'issued')
 *   E. Regression — state machine still blocks illegal transitions
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import { mapPaymentStateToInvoiceStatus } from '../../src/lib/invoices/paymentInvoiceSync'
import { syncInvoiceWithPayment } from '../../src/lib/invoices/invoiceService'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import { getPaymentRepository } from '../../src/lib/payments/repository'
import type { Invoice } from '../../src/lib/invoices/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDraftInvoice(jobId = 'job-test'): Invoice {
  return {
    id: `inv_${jobId}`,
    jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Testbetrieb GmbH',
      issuerAddress: 'Musterstraße 1, 12345 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [
      { id: `li_${jobId}`, label: 'Sanitärarbeiten', quantity: 1, unitPrice: 840.34, total: 840.34 },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 0,
    issuedAtLabel: 'Noch nicht ausgestellt',
    dueAtLabel: 'Noch nicht fällig',
    sentAt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function makeIssuedInvoice(jobId = 'job-test'): Invoice {
  return {
    ...makeDraftInvoice(jobId),
    status: 'issued',
    invoiceNumber: 'FX-2026-0001',
    issuedAt: 2_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
  }
}

function makePayment(jobId: string, state: Payment['state']): Payment {
  return {
    id: `pay_${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 1000, finalAmount: 1000 },
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

// ── A. Draft Guard ────────────────────────────────────────────────────────────

describe('A. Draft guard — syncInvoiceWithPayment never touches a draft invoice', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  async function syncWithPayment(paymentState: Payment['state']): Promise<Invoice | undefined> {
    const jobId = 'job-guard'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, paymentState))
    await syncInvoiceWithPayment(jobId)
    return getInvoiceRepository().getByJobId(jobId)
  }

  it('draft + deposit_required → still draft after sync', async () => {
    const result = await syncWithPayment('deposit_required')
    expect(result?.status).toBe('draft')
  })

  it('draft + deposit_paid → still draft after sync', async () => {
    const result = await syncWithPayment('deposit_paid')
    expect(result?.status).toBe('draft')
  })

  it('draft + in_escrow → still draft after sync', async () => {
    const result = await syncWithPayment('in_escrow')
    expect(result?.status).toBe('draft')
  })

  it('draft + release_pending → still draft after sync', async () => {
    const result = await syncWithPayment('release_pending')
    expect(result?.status).toBe('draft')
  })

  it('draft + released → still draft after sync', async () => {
    const result = await syncWithPayment('released')
    expect(result?.status).toBe('draft')
  })

  it('draft + disputed → still draft after sync', async () => {
    const result = await syncWithPayment('disputed')
    expect(result?.status).toBe('draft')
  })

  it('sentAt remains 0 on a draft after sync', async () => {
    const result = await syncWithPayment('released')
    expect(result?.sentAt).toBe(0)
  })

  it('issuedAt remains 0 on a draft after sync', async () => {
    const result = await syncWithPayment('released')
    expect(result?.issuedAt).toBe(0)
  })
})

// ── B. sentAt timestamp ───────────────────────────────────────────────────────

describe('B. sentAt timestamp — set by engine on issued → sent', () => {
  it('issued → sent sets sentAt to a positive timestamp', () => {
    const before = Date.now()
    const invoice = makeIssuedInvoice()
    const result = transitionInvoiceStatus(invoice, 'sent')
    const after = Date.now()

    expect(result.sentAt).toBeGreaterThanOrEqual(before)
    expect(result.sentAt).toBeLessThanOrEqual(after)
    expect(result.sentAt).toBeGreaterThan(0)
  })

  it('draft → issued does NOT set sentAt (stays 0)', () => {
    const invoice = makeDraftInvoice()
    const result = transitionInvoiceStatus(invoice, 'issued')
    expect(result.sentAt).toBe(0)
  })

  it('issued → paid does NOT set sentAt', () => {
    const invoice = makeIssuedInvoice()
    const result = transitionInvoiceStatus(invoice, 'paid')
    expect(result.sentAt).toBe(0)
  })

  it('issued → cancelled does NOT set sentAt', () => {
    const invoice = makeIssuedInvoice()
    const result = transitionInvoiceStatus(invoice, 'cancelled')
    expect(result.sentAt).toBe(0)
  })

  it('sent → paid preserves sentAt', () => {
    const issued = makeIssuedInvoice()
    const sent = transitionInvoiceStatus(issued, 'sent')
    const sentAtValue = sent.sentAt
    expect(sentAtValue).toBeGreaterThan(0)

    const paid = transitionInvoiceStatus(sent, 'paid')
    expect(paid.sentAt).toBe(sentAtValue)
  })

  it('sentAt is set only once — re-calling sent on an already-sent invoice is blocked', () => {
    const invoice = makeIssuedInvoice()
    const sent = transitionInvoiceStatus(invoice, 'sent')
    expect(() => transitionInvoiceStatus(sent, 'sent')).toThrow('Illegal invoice transition')
  })
})

// ── C. Non-draft sync advancement ────────────────────────────────────────────

describe('C. Non-draft sync — issued and sent invoices advance normally', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('issued + deposit_paid → advances to sent via sync', async () => {
    const jobId = 'job-advance'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))
    await syncInvoiceWithPayment(jobId)

    const result = getInvoiceRepository().getByJobId(jobId)
    expect(result?.status).toBe('sent')
  })

  it('issued + in_escrow → advances to sent via sync', async () => {
    const jobId = 'job-escrow'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'in_escrow'))
    await syncInvoiceWithPayment(jobId)

    const result = getInvoiceRepository().getByJobId(jobId)
    expect(result?.status).toBe('sent')
  })

  it('issued + released → advances to paid via sync (steps through sent)', async () => {
    const jobId = 'job-released'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'released'))
    await syncInvoiceWithPayment(jobId)

    const result = getInvoiceRepository().getByJobId(jobId)
    expect(result?.status).toBe('paid')
  })

  it('issued + released sync → sentAt is set (stepped through sent)', async () => {
    const jobId = 'job-released-sentat'
    const before = Date.now()
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'released'))
    await syncInvoiceWithPayment(jobId)
    const after = Date.now()

    const result = getInvoiceRepository().getByJobId(jobId)
    expect(result?.status).toBe('paid')
    expect(result?.sentAt).toBeGreaterThanOrEqual(before)
    expect(result?.sentAt).toBeLessThanOrEqual(after)
  })

  it('sync is a no-op when invoice is already at the target status', async () => {
    const jobId = 'job-noop'
    const issued = makeIssuedInvoice(jobId)
    await getInvoiceRepository().add(issued)
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))
    await syncInvoiceWithPayment(jobId) // advances to sent
    await syncInvoiceWithPayment(jobId) // no-op

    const result = getInvoiceRepository().getByJobId(jobId)
    expect(result?.status).toBe('sent')
  })
})

// ── D. deposit_required mapping ───────────────────────────────────────────────

describe('D. deposit_required maps to draft (not issued)', () => {
  it('mapPaymentStateToInvoiceStatus("deposit_required") returns "draft"', () => {
    expect(mapPaymentStateToInvoiceStatus('deposit_required')).toBe('draft')
  })

  it('mapPaymentStateToInvoiceStatus("released") still returns "paid"', () => {
    expect(mapPaymentStateToInvoiceStatus('released')).toBe('paid')
  })

  it('mapPaymentStateToInvoiceStatus("deposit_paid") still returns "sent"', () => {
    expect(mapPaymentStateToInvoiceStatus('deposit_paid')).toBe('sent')
  })

  it('mapPaymentStateToInvoiceStatus("in_escrow") still returns "sent"', () => {
    expect(mapPaymentStateToInvoiceStatus('in_escrow')).toBe('sent')
  })

  it('mapPaymentStateToInvoiceStatus("work_in_progress") still returns "sent"', () => {
    expect(mapPaymentStateToInvoiceStatus('work_in_progress')).toBe('sent')
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — state machine transitions unaffected', () => {
  it('draft → issued still works for a valid invoice', () => {
    const invoice = makeDraftInvoice()
    expect(() => transitionInvoiceStatus(invoice, 'issued')).not.toThrow()
    const result = transitionInvoiceStatus(invoice, 'issued')
    expect(result.status).toBe('issued')
    expect(result.issuedAt).toBeGreaterThan(0)
  })

  it('draft → sent is still illegal', () => {
    const invoice = makeDraftInvoice()
    expect(() => transitionInvoiceStatus(invoice, 'sent')).toThrow('Illegal invoice transition')
  })

  it('draft → paid is still illegal', () => {
    const invoice = makeDraftInvoice()
    expect(() => transitionInvoiceStatus(invoice, 'paid')).toThrow('Illegal invoice transition')
  })

  it('paid → any transition is still terminal (blocked)', () => {
    const issued = makeIssuedInvoice()
    const sent = transitionInvoiceStatus(issued, 'sent')
    const paid = transitionInvoiceStatus(sent, 'paid')
    expect(() => transitionInvoiceStatus(paid, 'cancelled')).toThrow('Illegal invoice transition')
    expect(() => transitionInvoiceStatus(paid, 'issued')).toThrow('Illegal invoice transition')
  })

  it('syncInvoiceWithPayment is a no-op when invoice does not exist', async () => {
    setupCleanRepositories()
    // No invoice in repo — should silently return without error
    await getPaymentRepository().add(makePayment('nonexistent', 'deposit_paid'))
    await expect(syncInvoiceWithPayment('nonexistent')).resolves.toBeUndefined()
  })
})
