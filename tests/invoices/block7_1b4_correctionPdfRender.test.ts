/**
 * Block 7.1B4 — PDF-Renderer-Tests für Korrekturbelege.
 *
 * Stellt sicher, dass der §14 Abs. 6 UStG-Pflichtbezug zur Originalrechnung
 * im Render-Datenmodell sichtbar wird und der Header die richtige Belegart
 * trägt. PDF-Bytes werden NICHT verglichen (jspdf instabil), nur die pure
 * `buildInvoiceRenderData`-Ausgabe.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import {
  createCancellationInvoiceWorkflow,
  createCreditNoteWorkflow,
} from '../../src/lib/workflow'
import { buildInvoiceRenderData } from '../../src/lib/invoices/artifactGenerator'
import type { Invoice } from '../../src/lib/invoices/types'

function makeOriginal(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-orig-render',
    jobId: 'job-render',
    invoiceNumber: 'FX-2026-0042',
    status: 'paid',
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
    dueAtLabel: 'Bezahlt',
    sentAt: 1_700_000_500_000,
    servicePeriod: {
      from: 1_699_900_000_000,
      to: 1_699_990_000_000,
      label: 'Leistungszeitraum: 12.04.2026 – 13.04.2026',
    },
    taxBreakdown: [
      { vatRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ],
    taxNote: null,
    providerSnapshot: {
      providerId: 'prov-1',
      companyName: 'Müller Sanitär GmbH',
      businessAddress: 'Hauptstraße 5, 10115 Berlin',
      taxNumber: '111/222/33333',
      vatId: null,
      legalForm: 'gmbh',
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: 'DE12345',
      bic: null,
    },
    customerSnapshot: {
      userId: 'cust-1',
      billingName: 'Julia Neumann',
      billingAddressLine1: 'Beispielweg 3',
      billingAddressLine2: null,
      billingPostalCode: '10115',
      billingCity: 'Berlin',
      billingCountry: 'DE',
      billingEmail: null,
      billingPhone: null,
      isBusiness: false,
      businessName: null,
      vatId: null,
    },
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

describe('buildInvoiceRenderData — Korrekturbelege (Block 7.1B4)', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('Stornorechnung: documentKind="cancellation" + originalInvoiceReference + correctionReason', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)

    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund nach refund_full',
    })

    const data = buildInvoiceRenderData(storno)
    expect(data.mode).toBe('snapshot')
    if (data.mode !== 'snapshot') return
    expect(data.documentKind).toBe('cancellation')
    expect(data.originalInvoiceReference).toEqual({
      invoiceNumber: 'FX-2026-0042',
      issuedAtLabel: '12.04.2026',
    })
    expect(data.correctionReason).toBe('Voller Refund nach refund_full')
    // Negative Beträge sind in der Render-Form als formatierte EUR-Strings
    // erkennbar (Locale 'de-DE' → '-' am Anfang oder als negativer Wert).
    expect(data.grossAmount).toMatch(/-/)
  })

  it('Gutschrift: documentKind="credit_note" + Refund-Δ als Amount sichtbar', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)

    const cn = await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 5_950,
      reason: 'Teilrückerstattung',
    })

    const data = buildInvoiceRenderData(cn)
    expect(data.mode).toBe('snapshot')
    if (data.mode !== 'snapshot') return
    expect(data.documentKind).toBe('credit_note')
    expect(data.originalInvoiceReference?.invoiceNumber).toBe('FX-2026-0042')
    expect(data.correctionReason).toBe('Teilrückerstattung')
    expect(data.lineItems).toHaveLength(1)
    expect(data.lineItems[0].label).toContain('Gutschrift zur Rechnung FX-2026-0042')
  })

  it('Originalrechnung: documentKind="invoice" + KEINE Korrektur-Felder', async () => {
    const original = makeOriginal()
    const data = buildInvoiceRenderData(original)
    expect(data.mode).toBe('snapshot')
    if (data.mode !== 'snapshot') return
    expect(data.documentKind).toBe('invoice')
    expect(data.originalInvoiceReference).toBeNull()
    expect(data.correctionReason).toBeNull()
  })

  it('Storno-Beleg lässt sich mit gross != 0 herunterladen — Guard akzeptiert negative Beträge', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)
    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })
    expect(() => buildInvoiceRenderData(storno)).not.toThrow()
  })
})
