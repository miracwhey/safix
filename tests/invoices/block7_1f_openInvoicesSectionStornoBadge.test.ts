/**
 * Block 7.1F — OpenInvoicesSection logical-cancelled badge contract.
 *
 * Audit-Finding M4 (7.1E): `OpenInvoicesSection` rendered the status badge
 * without `cancelledByCorrection`, so an issued or sent original invoice
 * with a matching Stornorechnung still surfaced as "Ausgestellt" / "Versendet".
 * `PaidInvoicesSection` already passed the prop correctly. This drift left
 * two surfaces disagreeing about the same record.
 *
 * This test pins the new contract:
 *   - Original (kind='invoice', status='issued' or 'sent') with a
 *     matching cancellation correction in `allInvoices` MUST surface
 *     "Storniert" via the InvoiceStatusBadge.
 *   - Without a matching correction, the original surfaces its plain status.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import OpenInvoicesSection from '../../src/components/invoices/OpenInvoicesSection'
import type { Invoice } from '../../src/lib/invoices/types'

function makeOriginal(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-orig-1',
    jobId: 'job-1',
    invoiceNumber: 'FX-2026-0001',
    status: 'issued',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Julia Neumann',
    },
    lineItems: [
      {
        id: 'li_1',
        label: 'Heizung warten',
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
    issuedAt: 1_700_000_000_000,
    issuedAtLabel: '12.04.2026',
    dueAtLabel: '26.04.2026',
    sentAt: 0,
    servicePeriod: {
      from: 1_699_900_000_000,
      to: 1_699_990_000_000,
      label: 'Leistungszeitraum: 12.04.2026 – 13.04.2026',
    },
    taxBreakdown: [
      { vatRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ],
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
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeCancellation(originalId: string, overrides: Partial<Invoice> = {}): Invoice {
  return makeOriginal({
    id: 'inv-storno-1',
    invoiceNumber: 'FX-S-2026-0001',
    kind: 'cancellation',
    originalInvoiceId: originalId,
    correctionReason: 'Voller Refund',
    correctionAmountCents: -11_900,
    originalInvoiceNumber: 'FX-2026-0001',
    originalInvoiceIssuedAtLabel: '12.04.2026',
    amounts: { netAmount: -100, taxAmount: -19, grossAmount: -119 },
    ...overrides,
  })
}

function render(invoices: Invoice[], allInvoices: Invoice[]): string {
  return renderToString(
    React.createElement(OpenInvoicesSection, {
      invoices,
      allInvoices,
    }),
  )
}

describe('OpenInvoicesSection — Block 7.1F badge drift fix', () => {
  it('renders plain "Ausgestellt" when no correction exists', () => {
    const original = makeOriginal({ status: 'issued' })
    const html = render([original], [original])
    expect(html).toContain('Ausgestellt')
    expect(html).not.toContain('Storniert')
  })

  it('renders plain "Versendet" for a sent original without correction', () => {
    const original = makeOriginal({ status: 'sent', sentAt: 1_700_000_500_000 })
    const html = render([original], [original])
    expect(html).toContain('Versendet')
    expect(html).not.toContain('Storniert')
  })

  it('issued original WITH matching cancellation surfaces "Storniert" — not "Ausgestellt"', () => {
    const original = makeOriginal({ status: 'issued' })
    const storno = makeCancellation(original.id)
    const html = render([original], [original, storno])
    expect(html).toContain('Storniert')
    // The badge must not surface the raw DB status when the invoice is
    // logically cancelled — that was the M4 drift the regression fix closes.
    expect(html).not.toMatch(/>Ausgestellt</)
  })

  it('sent original WITH matching cancellation surfaces "Storniert" — not "Versendet"', () => {
    const original = makeOriginal({ status: 'sent', sentAt: 1_700_000_500_000 })
    const storno = makeCancellation(original.id)
    const html = render([original], [original, storno])
    expect(html).toContain('Storniert')
    expect(html).not.toMatch(/>Versendet</)
  })

  it('falls back to invoices list when allInvoices is omitted (back-compat)', () => {
    const original = makeOriginal({ status: 'issued' })
    const storno = makeCancellation(original.id)
    // Caller passes only the open list (containing both original and the
    // cancellation entry hypothetically). The fallback corpus must derive
    // the same logical state without requiring allInvoices.
    const html = renderToString(
      React.createElement(OpenInvoicesSection, {
        invoices: [original, storno],
      }),
    )
    expect(html).toContain('Storniert')
  })
})
