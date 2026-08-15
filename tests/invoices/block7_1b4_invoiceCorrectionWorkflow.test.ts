/**
 * Block 7.1B4 — Invoice Correction Workflow Tests
 *
 * Pflicht-Garantien:
 *   - Stornorechnung erzeugt einen neuen Beleg `kind = 'cancellation'` mit
 *     negativen Beträgen, ohne den Status der Originalrechnung zu mutieren.
 *   - Gutschrift erzeugt `kind = 'credit_note'` über den Refund-Δ.
 *   - Direkte paid → cancelled Mutation bleibt verboten (Engine-Pin).
 *   - Idempotency: doppelter Storno-Aufruf liefert denselben Beleg.
 *   - Validierung blockiert: doppelter Storno, Gutschrift > Restforderung,
 *     paid + draft Originale, fehlende Begründung.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import {
  createCancellationInvoiceWorkflow,
  createCreditNoteWorkflow,
  getLogicalInvoiceStatus,
} from '../../src/lib/workflow'
import {
  getCorrectionInvoices,
  getCorrectionsForInvoice,
  isInvoiceLogicallyCancelled,
  getOpenInvoices,
  getPaidInvoices,
} from '../../src/lib/invoices'
import type { Invoice } from '../../src/lib/invoices/types'

function makePaidOriginal(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-orig-1',
    jobId: 'job-1',
    invoiceNumber: 'FX-2026-0001',
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

describe('createCancellationInvoiceWorkflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('erzeugt eine Stornorechnung mit kind="cancellation" und negierten Beträgen', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund nach Dispute-Resolution refund_full',
    })

    expect(storno.kind).toBe('cancellation')
    expect(storno.originalInvoiceId).toBe(original.id)
    expect(storno.amounts.grossAmount).toBe(-119)
    expect(storno.amounts.netAmount).toBe(-100)
    expect(storno.amounts.taxAmount).toBe(-19)
    expect(storno.correctionAmountCents).toBe(-11_900)
    expect(storno.lineItems[0].total).toBe(-100)
    expect(storno.lineItems[0].vatAmount).toBe(-19)
    expect(storno.lineItems[0].gross).toBe(-119)
    expect(storno.taxBreakdown).toEqual([
      { vatRate: 19, netAmount: -100, taxAmount: -19, grossAmount: -119 },
    ])
    expect(storno.invoiceNumber).toMatch(/^FX-S-\d{4}-\d{4}$/)
    expect(storno.status).toBe('issued')
    expect(storno.originalInvoiceNumber).toBe('FX-2026-0001')
  })

  it('mutiert den Status der Originalrechnung NICHT (Engine-Invariante paid:[] bleibt erhalten)', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })

    const repoOriginal = getInvoiceRepository()
      .getAll()
      .find((i) => i.id === original.id)
    expect(repoOriginal?.status).toBe('paid')
    expect(repoOriginal?.kind).toBe('invoice')
  })

  it('logischer Status der Originalrechnung wird zu "cancelled_by_correction"', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })

    const all = getInvoiceRepository().getAll()
    const reloadedOriginal = all.find((i) => i.id === original.id)!
    expect(getLogicalInvoiceStatus(reloadedOriginal, all)).toBe(
      'cancelled_by_correction',
    )
    expect(isInvoiceLogicallyCancelled(reloadedOriginal, all)).toBe(true)
  })

  it('Idempotency: zweiter Aufruf liefert denselben Storno-Beleg, kein zweiter Insert', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    const first = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })
    const second = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Anderer Grund',
    })

    expect(second.id).toBe(first.id)
    expect(
      getInvoiceRepository()
        .getAll()
        .filter((i) => i.kind === 'cancellation').length,
    ).toBe(1)
  })

  it('blockiert Storno einer noch nicht ausgestellten (draft) Originalrechnung', async () => {
    const draft = makePaidOriginal({
      status: 'draft',
      invoiceNumber: '',
      issuedAt: 0,
    })
    await getInvoiceRepository().add(draft)

    await expect(
      createCancellationInvoiceWorkflow({
        originalInvoiceId: draft.id,
        reason: 'irrelevant',
      }),
    ).rejects.toThrow(/draft/i)
  })

  it('blockiert Storno auf Korrekturbelegen (Storno-of-Storno)', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    const storno = await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Voller Refund',
    })

    await expect(
      createCancellationInvoiceWorkflow({
        originalInvoiceId: storno.id,
        reason: 'Storno-of-Storno',
      }),
    ).rejects.toThrow(/Only original invoices/i)
  })

  it('Pflichtfeld Begründung — leere reason wird abgelehnt', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    await expect(
      createCancellationInvoiceWorkflow({
        originalInvoiceId: original.id,
        reason: '   ',
      }),
    ).rejects.toThrow(/correctionReason is required/i)
  })

  it('blockiert Storno wenn bereits Gutschriften existieren (sonst Doppel-Refund)', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 5_000,
      reason: 'Teilrückerstattung',
    })

    await expect(
      createCancellationInvoiceWorkflow({
        originalInvoiceId: original.id,
        reason: 'Voll-Storno nach Teilgutschrift',
      }),
    ).rejects.toThrow(/credit notes/i)
  })

  it('Engine-Pin: paid → cancelled bleibt verboten ohne Korrekturworkflow', () => {
    const original = makePaidOriginal()
    expect(() => transitionInvoiceStatus(original, 'cancelled')).toThrow(
      /Illegal invoice transition: paid → cancelled/,
    )
  })
})

describe('createCreditNoteWorkflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('erzeugt eine Gutschrift mit kind="credit_note" und negativem Δ', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    const cn = await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 5_950, // 59,50 €
      reason: 'Teilrückerstattung Material',
    })

    expect(cn.kind).toBe('credit_note')
    expect(cn.correctionAmountCents).toBe(-5_950)
    expect(cn.amounts.grossAmount).toBeCloseTo(-59.5, 2)
    expect(cn.amounts.netAmount).toBeCloseTo(-50, 2)
    expect(cn.amounts.taxAmount).toBeCloseTo(-9.5, 2)
    expect(cn.lineItems).toHaveLength(1)
    expect(cn.lineItems[0].vatRate).toBe(19)
    expect(cn.invoiceNumber).toMatch(/^FX-G-\d{4}-\d{4}$/)
    expect(cn.status).toBe('issued')
    expect(cn.originalInvoiceId).toBe(original.id)
  })

  it('lehnt einen Refund-Betrag > Restforderung ab', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    await expect(
      createCreditNoteWorkflow({
        originalInvoiceId: original.id,
        refundAmountCents: 12_000, // mehr als 119,00 €
        reason: 'übersteigt Forderung',
      }),
    ).rejects.toThrow(/exceeds the remaining/i)
  })

  it('akkumuliert mehrere Gutschriften korrekt — Summe darf Gross nicht übersteigen', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)

    await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 5_000,
      reason: 'Teil 1',
    })
    await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 6_000,
      reason: 'Teil 2',
    })
    await expect(
      createCreditNoteWorkflow({
        originalInvoiceId: original.id,
        refundAmountCents: 1_000, // 11.000 + 1.000 = 12.000 > 11.900
        reason: 'Übergewicht',
      }),
    ).rejects.toThrow(/exceeds the remaining/i)
  })

  it('multi-rate Originale werden in B4-Gutschrift abgelehnt', async () => {
    const original = makePaidOriginal({
      taxBreakdown: [
        { vatRate: 19, netAmount: 80, taxAmount: 15.2, grossAmount: 95.2 },
        { vatRate: 7, netAmount: 22.43, taxAmount: 1.57, grossAmount: 24 },
      ],
      amounts: { netAmount: 102.43, taxAmount: 16.77, grossAmount: 119.2 },
    })
    await getInvoiceRepository().add(original)

    await expect(
      createCreditNoteWorkflow({
        originalInvoiceId: original.id,
        refundAmountCents: 1_000,
        reason: 'multi-rate Test',
      }),
    ).rejects.toThrow(/multiple VAT rates/i)
  })

  it('blockiert Gutschrift nach erfolgtem Storno', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Vollstorno',
    })

    await expect(
      createCreditNoteWorkflow({
        originalInvoiceId: original.id,
        refundAmountCents: 1_000,
        reason: 'sollte nicht durchgehen',
      }),
    ).rejects.toThrow(/already has a cancellation/i)
  })

  it('Original bleibt paid, aber getOpenInvoices/getPaidInvoices listen Korrekturbelege NICHT', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    await createCancellationInvoiceWorkflow({
      originalInvoiceId: original.id,
      reason: 'Vollstorno',
    })

    const all = getInvoiceRepository().getAll()
    expect(getOpenInvoices(all).every((i) => i.kind === 'invoice')).toBe(true)
    expect(getPaidInvoices(all).every((i) => i.kind === 'invoice')).toBe(true)
    expect(getCorrectionInvoices(all)).toHaveLength(1)
    expect(getCorrectionsForInvoice(all, original.id)).toHaveLength(1)
  })

  it('refundEventId wird persistiert, falls übergeben', async () => {
    const original = makePaidOriginal()
    await getInvoiceRepository().add(original)
    const cn = await createCreditNoteWorkflow({
      originalInvoiceId: original.id,
      refundAmountCents: 1_000,
      reason: 'Audit-Anker',
      refundEventId: 're_3PqXyZTest',
    })
    expect(cn.refundEventId).toBe('re_3PqXyZTest')
  })
})
