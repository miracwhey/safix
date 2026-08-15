/**
 * Invoice-PDF Pagination (§14-Korrektheit).
 *
 * Vor diesem Block lief der Invoice-Renderer mit einem flachen y-Cursor ohne
 * Seitenumbruch: >~35 Positionen (oder ein langer Summen-/Steuerblock) liefen
 * unsichtbar über das A4-Blatt hinaus — der Gesamtbetrag und die
 * Steueraufstellung konnten still von der Seite fallen. Das ist ein
 * §14-UStG-Korrektheitsfehler (Pflichtangaben fehlen auf dem Beleg).
 *
 * Diese Tests nutzen das ECHTE jsPDF (kein Mock), rendern den Blob und prüfen
 * die PDF-Struktur direkt:
 *   - Viele Positionen → mehrere Seiten (`addPage` engaged, eine MediaBox je
 *     Seite). Der alte Renderer blieb IMMER bei 1 Seite — das ist der
 *     diskriminierende Beweis.
 *   - Der Spaltenkopf („Beschreibung") wird auf jeder Folgeseite wiederholt.
 *   - Gesamtbetrag + Steueraufstellung sind im Stream vorhanden.
 *   - „Seite X von Y"-Footer auf jeder Seite.
 *   - Wenige Positionen → genau 1 Seite (keine Spurious-Breaks, kein Regress).
 */

import { describe, it, expect } from 'vitest'
import { generateInvoicePdf } from '../../src/lib/invoices/artifactGenerator'
import type { Invoice, InvoiceLineItem } from '../../src/lib/invoices/types'

async function blobAsString(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  return new TextDecoder('latin1').decode(buf)
}

function countMatches(str: string, re: RegExp): number {
  return (str.match(re) ?? []).length
}

function makeLineItems(count: number): InvoiceLineItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `li_${i + 1}`,
    label: `Position ${i + 1} — Arbeitsleistung und Material`,
    quantity: 1,
    unitPrice: 100,
    total: 100,
    category: 'labor' as const,
    vatRate: 19,
    vatAmount: 19,
    gross: 119,
  }))
}

function makeSnapshotInvoice(itemCount: number): Invoice {
  return {
    id: 'inv-pagination',
    jobId: 'job-pagination',
    invoiceNumber: 'FX-2026-9001',
    status: 'issued',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Julia Neumann',
    },
    lineItems: makeLineItems(itemCount),
    amounts: { netAmount: 45_000, taxAmount: 8_550, grossAmount: 53_550 },
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
      { vatRate: 19, netAmount: 45_000, taxAmount: 8_550, grossAmount: 53_550 },
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
      iban: 'DE12345678901234567890',
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
  } as Invoice
}

describe('Invoice-PDF Pagination — §14 (Snapshot-Renderer)', () => {
  it('120 Positionen → mehrere Seiten (Pagination greift)', async () => {
    const blob = await generateInvoicePdf(makeSnapshotInvoice(120))
    expect(blob.type).toBe('application/pdf')
    const str = await blobAsString(blob)
    // Eine MediaBox je Seite — alter Renderer blieb immer bei 1.
    expect(countMatches(str, /\/MediaBox/g)).toBeGreaterThanOrEqual(2)
  })

  it('Spaltenkopf „Beschreibung" wird auf Folgeseiten wiederholt', async () => {
    const str = await blobAsString(await generateInvoicePdf(makeSnapshotInvoice(120)))
    expect(countMatches(str, /Beschreibung/g)).toBeGreaterThanOrEqual(2)
  })

  it('Gesamtbetrag + Wert + Steueraufstellung überleben die Pagination', async () => {
    const str = await blobAsString(await generateInvoicePdf(makeSnapshotInvoice(120)))
    expect(str).toMatch(/Gesamtbetrag/)
    // 53.550,00 € — der formatierte Bruttobetrag darf nicht von der Seite fallen.
    expect(str).toMatch(/53\.550,00/)
    expect(str).toMatch(/Steueraufstellung/)
  })

  it('„Seite X von Y"-Footer auf jeder Seite', async () => {
    const str = await blobAsString(await generateInvoicePdf(makeSnapshotInvoice(120)))
    expect(str).toMatch(/Seite 1 von/)
    expect(str).toMatch(/Seite 2 von/)
  })

  it('Wenige Positionen → genau 1 Seite (kein Spurious-Break, kein Regress)', async () => {
    const str = await blobAsString(await generateInvoicePdf(makeSnapshotInvoice(3)))
    expect(countMatches(str, /\/MediaBox/g)).toBe(1)
    expect(str).toMatch(/Gesamtbetrag/)
  })

  it('langer correctionReason (Storno) drückt Empfängerblock NICHT von der Seite', async () => {
    const longReason = ('Stornierung wegen vollständiger Rückabwicklung des Auftrags. ').repeat(120)
    const inv = {
      ...makeSnapshotInvoice(30),
      kind: 'cancellation',
      originalInvoiceNumber: 'FX-2026-0001',
      originalInvoiceIssuedAtLabel: '01.04.2026',
      correctionReason: longReason,
      amounts: { netAmount: -45_000, taxAmount: -8_550, grossAmount: -53_550 },
      taxBreakdown: [{ vatRate: 19, netAmount: -45_000, taxAmount: -8_550, grossAmount: -53_550 }],
    } as Invoice
    const blob = await generateInvoicePdf(inv)
    const str = await blobAsString(blob)
    expect(blob.type).toBe('application/pdf')
    expect(countMatches(str, /\/MediaBox/g)).toBeGreaterThanOrEqual(2)
    // Empfängerblock (§14 Pflichtangabe) + Belegart + Gesamtbetrag müssen da sein.
    expect(str).toMatch(/STORNORECHNUNG/)
    expect(str).toMatch(/Rechnungsempf/)
    expect(str).toMatch(/Julia Neumann/)
    expect(str).toMatch(/Gesamtbetrag/)
  })

  it('mehrere USt-Sätze → beide Sätze in der Steueraufstellung', async () => {
    const inv = {
      ...makeSnapshotInvoice(4),
      taxBreakdown: [
        { vatRate: 19, netAmount: 30_000, taxAmount: 5_700, grossAmount: 35_700 },
        { vatRate: 7, netAmount: 15_000, taxAmount: 1_050, grossAmount: 16_050 },
      ],
    } as Invoice
    const str = await blobAsString(await generateInvoicePdf(inv))
    expect(str).toMatch(/Steueraufstellung/)
    expect(str).toMatch(/19 %/)
    expect(str).toMatch(/7 %/)
  })
})
