/**
 * Block 7.1B4 — Engine FSM-Pin.
 *
 * Vor B4 hat es keinen direkten Test gegeben, der die Invoice-Transition-Map
 * gegen Drift sichert. Der Korrekturworkflow ruht auf der Garantie, dass
 * paid und cancelled terminal sind — wenn eine spätere Änderung das aufweicht,
 * würde der ganze §14-Abs.-6-Pfad fachlich brechen.
 *
 * Diese Suite pinnt die Map und die wichtigsten Side-Effects.
 */

import { describe, expect, it } from 'vitest'
import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import type { Invoice, InvoiceStatus } from '../../src/lib/invoices/types'

function makeInvoice(status: InvoiceStatus): Invoice {
  return {
    id: 'inv-fsm',
    jobId: 'job-fsm',
    invoiceNumber: status === 'draft' ? '' : 'FX-2026-9001',
    status,
    parties: {
      issuerName: 'Acme Handwerk',
      issuerAddress: 'Hauptstraße 1, 10115 Berlin',
      customerName: 'Test Kunde',
    },
    lineItems: [
      {
        id: 'li_x',
        label: 'Arbeit',
        quantity: 1,
        unitPrice: 100,
        total: 100,
        category: 'labor',
        vatRate: 19,
        vatAmount: 19,
        gross: 119,
      },
    ],
    amounts: { netAmount: 100, taxAmount: 19, grossAmount: 119 },
    issuedAt: status === 'draft' ? 0 : 1_700_000_000_000,
    issuedAtLabel: status === 'draft' ? 'Noch nicht ausgestellt' : '12.04.2026',
    dueAtLabel: 'In 7 Tagen',
    sentAt: status === 'sent' || status === 'paid' ? 1_700_000_500_000 : 0,
    servicePeriod: null,
    taxBreakdown: null,
    taxNote: null,
    providerSnapshot: null,
    customerSnapshot: null,
    sourceOfferId: null,
    sourceChangeOrderIds: [],
    sourceSupplementaryPaymentIds: [],
    kind: 'invoice',
    originalInvoiceId: null,
    correctionReason: null,
    correctionAmountCents: null,
    originalInvoiceNumber: null,
    originalInvoiceIssuedAtLabel: null,
    refundEventId: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('Invoice Engine FSM (Block 7.1B4 pin)', () => {
  it('paid ist terminal — keine ausgehenden Transitionen', () => {
    const paid = makeInvoice('paid')
    for (const target of ['draft', 'issued', 'sent', 'paid', 'cancelled'] as const) {
      expect(() => transitionInvoiceStatus(paid, target)).toThrow(
        /Illegal invoice transition/,
      )
    }
  })

  it('cancelled ist terminal — auch keine Reaktivierung', () => {
    const cancelled = makeInvoice('cancelled')
    for (const target of ['draft', 'issued', 'sent', 'paid', 'cancelled'] as const) {
      expect(() => transitionInvoiceStatus(cancelled, target)).toThrow(
        /Illegal invoice transition/,
      )
    }
  })

  it('draft → issued | cancelled erlaubt; alles andere geblockt', () => {
    const draft = makeInvoice('draft')
    expect(() => transitionInvoiceStatus(draft, 'sent')).toThrow(
      /Illegal invoice transition/,
    )
    expect(() => transitionInvoiceStatus(draft, 'paid')).toThrow(
      /Illegal invoice transition/,
    )
    // draft → cancelled wird durch die Validation der Engine erlaubt — der
    // Workflow blockt die Engine-direkte Mutation für issued/sent/paid auf
    // anderem Wege (Korrekturkontext).
    const c = transitionInvoiceStatus(draft, 'cancelled')
    expect(c.status).toBe('cancelled')
  })

  it('issued → sent | paid | cancelled erlaubt', () => {
    const issued = makeInvoice('issued')
    expect(transitionInvoiceStatus(issued, 'sent').status).toBe('sent')
    expect(transitionInvoiceStatus(issued, 'paid').status).toBe('paid')
    expect(transitionInvoiceStatus(issued, 'cancelled').status).toBe('cancelled')
  })

  it('sent → paid | cancelled erlaubt; sent → issued geblockt (keine Reversion)', () => {
    const sent = makeInvoice('sent')
    expect(transitionInvoiceStatus(sent, 'paid').status).toBe('paid')
    expect(transitionInvoiceStatus(sent, 'cancelled').status).toBe('cancelled')
    expect(() => transitionInvoiceStatus(sent, 'issued')).toThrow(
      /Illegal invoice transition/,
    )
  })
})
