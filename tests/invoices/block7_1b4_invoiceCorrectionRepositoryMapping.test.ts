/**
 * Block 7.1B4 — Repository Mapping & Sequenzen.
 *
 * Stellt sicher, dass:
 *   - `add()` Korrektur-Felder durchreicht (kind, originalInvoiceId,
 *     correctionReason, correctionAmountCents, refundEventId,
 *     originalInvoiceNumber, originalInvoiceIssuedAtLabel).
 *   - In-Memory-Mock vergibt kind-aware Belegnummern: FX-S-YYYY-NNNN für
 *     Stornorechnungen, FX-G-YYYY-NNNN für Gutschriften, FX-YYYY-NNNN für
 *     Originalrechnungen — auf separaten Sequenzen.
 *   - Konstruktor leitet Counter aus initial vorhandenen Belegnummern ab.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import {
  createCancellationInvoiceWorkflow,
  createCreditNoteWorkflow,
} from '../../src/lib/workflow'
import { InMemoryInvoiceRepository } from '../../src/lib/invoices/repository/InMemoryInvoiceRepository'
import { setInvoiceRepository } from '../../src/lib/invoices/repository/registry'
import type { Invoice } from '../../src/lib/invoices/types'

function makeOriginal(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-orig-mapping',
    jobId: 'job-mapping',
    invoiceNumber: 'FX-2026-0007',
    status: 'paid',
    parties: {
      issuerName: 'Schmidt Elektrik',
      issuerAddress: 'Lindenstraße 1, 10115 Berlin',
      customerName: 'Klaus Bauer',
    },
    lineItems: [
      {
        id: 'li_1',
        label: 'Steckdose',
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
    issuedAtLabel: '01.04.2026',
    dueAtLabel: 'Bezahlt',
    sentAt: 1_700_000_500_000,
    servicePeriod: {
      from: 1_699_900_000_000,
      to: 1_699_990_000_000,
      label: 'Leistungsdatum: 01.04.2026',
    },
    taxBreakdown: [
      { vatRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ],
    taxNote: null,
    providerSnapshot: {
      providerId: 'prov-2',
      companyName: 'Schmidt Elektrik',
      businessAddress: 'Lindenstraße 1, 10115 Berlin',
      taxNumber: '999/000/11111',
      vatId: null,
      legalForm: 'gmbh',
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: null,
      bic: null,
    },
    customerSnapshot: {
      userId: 'cust-2',
      billingName: 'Klaus Bauer',
      billingAddressLine1: 'Apfelweg 9',
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

describe('InMemoryInvoiceRepository — Korrektur-Sequenzen', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('Stornorechnung erhält FX-S-YYYY-NNNN und Originalrechnung bleibt FX-YYYY-NNNN', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)

    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })

    expect(original.invoiceNumber).toMatch(/^FX-\d{4}-\d{4}$/)
    expect(storno.invoiceNumber).toMatch(/^FX-S-\d{4}-\d{4}$/)
  })

  it('Gutschrift erhält FX-G-YYYY-NNNN', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)

    const cn = await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 1_000,
      reason: 'Teil-Refund',
    })

    expect(cn.invoiceNumber).toMatch(/^FX-G-\d{4}-\d{4}$/)
  })

  it('Sequenzen sind getrennt: separate Counter pro Belegart', async () => {
    const a = makeOriginal({ id: 'a', invoiceNumber: 'FX-2026-0010', jobId: 'job-a' })
    const b = makeOriginal({ id: 'b', invoiceNumber: 'FX-2026-0011', jobId: 'job-b' })
    await getInvoiceRepository().add(a)
    await getInvoiceRepository().add(b)

    const stornoA = await createCancellationInvoiceWorkflow({
      originalInvoiceId: a.id,
      reason: 'Refund A',
    })
    const cnB = await createCreditNoteWorkflow({
      originalInvoiceId: b.id,
      refundAmountCents: 5_000,
      reason: 'Teil-Refund B',
    })

    // Beide Korrekturen starten ihre eigene Sequenz bei 0001 (kein Drift in
    // den Originalrechnungs-Counter, kein Drift zwischen Storno + Gutschrift).
    expect(stornoA.invoiceNumber).toMatch(/^FX-S-\d{4}-0001$/)
    expect(cnB.invoiceNumber).toMatch(/^FX-G-\d{4}-0001$/)
  })

  it('Konstruktor liest bestehende Korrektur-Sequenzen aus initial-data', async () => {
    const repo = new InMemoryInvoiceRepository([
      { ...makeOriginal({ id: 'orig', invoiceNumber: 'FX-2026-0050' }) },
      {
        ...makeOriginal({
          id: 'storno-old',
          invoiceNumber: 'FX-S-2026-0007',
          kind: 'cancellation',
          originalInvoiceId: 'orig',
          correctionReason: 'historisch',
          correctionAmountCents: -11_900,
          originalInvoiceNumber: 'FX-2026-0050',
          originalInvoiceIssuedAtLabel: '01.04.2026',
        }),
      },
    ])
    setInvoiceRepository(repo)

    const fresh = makeOriginal({
      id: 'orig-2',
      jobId: 'job-orig-2',
      invoiceNumber: 'FX-2026-0051',
    })
    await getInvoiceRepository().add(fresh)
    const next = await createCancellationInvoiceWorkflow({
      originalInvoiceId: fresh.id,
      reason: 'Counter-Test',
    })

    // Counter knüpft an höchste vorhandene Storno-Sequenznummer (0007) an
    // → nächster Beleg ist 0008.
    expect(next.invoiceNumber).toMatch(/^FX-S-\d{4}-0008$/)
  })

  it('Korrektur-Audit-Felder werden persistiert (refundEventId + originalInvoiceNumber)', async () => {
    const original = makeOriginal()
    await getInvoiceRepository().add(original)
    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Refund nach Dispute',
      refundEventId: 're_3PqXyZ',
    })

    const stored = getInvoiceRepository()
      .getAll()
      .find((i) => i.id === storno.id)!
    expect(stored.refundEventId).toBe('re_3PqXyZ')
    expect(stored.originalInvoiceNumber).toBe(original.invoiceNumber)
    expect(stored.originalInvoiceIssuedAtLabel).toBe(original.issuedAtLabel)
    expect(stored.kind).toBe('cancellation')
    expect(stored.originalInvoiceId).toBe(original.id)
    expect(stored.correctionAmountCents).toBe(-11_900)
  })
})
