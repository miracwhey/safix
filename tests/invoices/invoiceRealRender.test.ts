import { describe, it, expect } from 'vitest'
import { generateInvoicePdf, buildInvoiceRenderData } from '../../src/lib/invoices/artifactGenerator'
import type { Invoice } from '../../src/lib/invoices/types'

/**
 * REAL render integration test (no jsPDF mock — complements the mocked
 * block11_artifactGeneration shape test). Drives the actual jsPDF pipeline and
 * asserts the produced PDF bytes carry every §14-UStG mandatory field, so a
 * layout / pagination / field-wiring regression fails CI instead of shipping a
 * silently broken belegt.
 */

function fullSnapshotInvoice(): Invoice {
  return {
    id: 'inv_render', jobId: 'job_render', invoiceNumber: 'FX-2026-0042', status: 'sent',
    parties: { issuerName: 'Mustermann Sanitär GmbH', issuerAddress: 'Bauweg 7, 30161 Hannover', customerName: 'Anna Beispiel' },
    lineItems: [
      { id: 'li_1', label: 'Badezimmer-Sanierung inkl. Fliesenarbeiten und Abdichtung', quantity: 1, unitPrice: 2000, total: 2000, category: 'labor', vatRate: 19, vatAmount: 380, gross: 2380 },
      { id: 'co_1', label: 'Nachtrag: Zusätzliche Armatur', quantity: 1, unitPrice: 150, total: 150, category: 'material', vatRate: 7, vatAmount: 10.5, gross: 160.5 },
    ],
    amounts: { netAmount: 2150, taxAmount: 390.5, grossAmount: 2540.5 },
    issuedAt: 1_700_000_000_000, issuedAtLabel: '24.06.2026', dueAtLabel: 'In 7 Tagen', sentAt: 1_700_000_000_000,
    servicePeriod: { from: 1_699_000_000_000, to: 1_700_000_000_000, label: 'Leistungszeitraum: 01.06.2026 – 20.06.2026' },
    taxBreakdown: [
      { vatRate: 19, netAmount: 2000, taxAmount: 380, grossAmount: 2380 },
      { vatRate: 7, netAmount: 150, taxAmount: 10.5, grossAmount: 160.5 },
    ],
    taxNote: null,
    providerSnapshot: {
      providerId: 'prov_1', companyName: 'Mustermann Sanitär GmbH', businessAddress: 'Bauweg 7, 30161 Hannover',
      taxNumber: '25/123/45678', vatId: 'DE123456789', legalForm: 'GmbH', isKleinunternehmer: false,
      defaultVatRate: 19, iban: 'DE89370400440532013000', bic: 'COBADEFFXXX',
    },
    customerSnapshot: {
      userId: 'usr_1', billingName: 'Anna Beispiel', billingAddressLine1: 'Lindenallee 3', billingAddressLine2: null,
      billingPostalCode: '30159', billingCity: 'Hannover', billingCountry: 'DE', billingEmail: 'anna@example.com',
      billingPhone: null, isBusiness: false, businessName: null, vatId: null,
    },
    sourceOfferId: 'off_1', sourceChangeOrderIds: ['co_1'], sourceSupplementaryPaymentIds: [],
    kind: 'invoice', originalInvoiceId: null, correctionReason: null, correctionAmountCents: null,
    originalInvoiceNumber: null, originalInvoiceIssuedAtLabel: null, refundEventId: null,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  } as unknown as Invoice
}

async function pdfText(invoice: Invoice): Promise<string> {
  const blob = await generateInvoicePdf(invoice)
  const buf = Buffer.from(await blob.arrayBuffer())
  return buf.toString('latin1')
}

describe('Invoice PDF — real render carries every §14 mandatory field', () => {
  it('uses the §14 snapshot render path for a full-snapshot invoice', () => {
    expect(buildInvoiceRenderData(fullSnapshotInvoice()).mode).toBe('snapshot')
  })

  it('produces a valid PDF with all §14-UStG mandatory fields', async () => {
    const raw = await pdfText(fullSnapshotInvoice())
    expect(raw.startsWith('%PDF')).toBe(true)
    // §14 Abs. 4 mandatory angaben
    expect(raw).toContain('RECHNUNG')
    expect(raw).toContain('FX-2026-0042') // fortlaufende Nummer
    expect(raw).toContain('Mustermann') // Aussteller
    expect(raw).toContain('Steuernummer')
    expect(raw).toContain('25/123/45678')
    expect(raw).toContain('USt-IdNr')
    expect(raw).toContain('DE123456789')
    expect(raw).toContain('Anna Beispiel') // Empfänger
    expect(raw).toContain('Lindenallee')
    expect(raw).toContain('Leistungszeitraum') // Zeitpunkt der Leistung
    expect(raw).toContain('Steueraufstellung') // Entgelt nach Steuersätzen
    expect(raw).toContain('19 %')
    expect(raw).toContain('7 %')
    expect(raw).toContain('Gesamtbetrag')
    expect(raw).toContain('Seite') // pagination footer
  })

  it('refuses to render a draft (no number → no §14 belegt)', async () => {
    const draft = { ...fullSnapshotInvoice(), status: 'draft', invoiceNumber: '' } as Invoice
    await expect(generateInvoicePdf(draft)).rejects.toThrow()
  })
})
