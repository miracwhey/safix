/**
 * Block 7.1B3 — Invoice Snapshot Builder
 *
 * Pure unit tests für `buildInvoiceSnapshot`. Deckt:
 *   A. Provider/Customer Snapshot freeze
 *   B. ChangeOrder-Aggregation als zusätzliche Lines
 *   C. SupplementaryPaymentRequest IDs werden gespeichert, NICHT addiert
 *   D. Hard-Gate Provider unvollständig
 *   E. Hard-Gate Customer unvollständig
 *   F. Hard-Gate Service-Period fehlt
 *   G. Kleinunternehmer setzt 0%-Rates + §19-Note
 *   H. VAT-Override pro LineItem
 *   I. Empty offer + change orders → throw
 */

import { describe, it, expect } from 'vitest'
import {
  buildInvoiceSnapshot,
  type SnapshotProviderInput,
  type SnapshotCustomerInput,
} from '../../src/lib/invoices/invoiceSnapshotBuilder'
import { KLEINUNTERNEHMER_TAX_NOTE } from '../../src/lib/invoices/invoiceTaxModel'
import type { ChangeOrder } from '../../src/lib/changeOrders/types'
import type { Job } from '../../src/lib/jobs'
import type { Offer } from '../../src/lib/offers/types'
import type { SupplementaryPaymentRequest } from '../../src/lib/payments/supplementary/types'
import type { InvoiceServicePeriod } from '../../src/lib/invoices/types'

function makeJob(): Job {
  return {
    id: 'job-1',
    title: 'Heizung reparieren',
    customer: 'Julia Neumann',
    location: 'Berlin',
    amount: '1.190,00 €',
    status: 'completed',
    workCompletedAt: new Date('2026-04-15').getTime(),
    sourceOfferId: 'offer-1',
    craftsmanUserId: 'craft-1',
  } as Job
}

function makeOffer(): Offer {
  return {
    id: 'offer-1',
    conversationId: 'conv-1',
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    price: '1.190 €',
    grossTotal: 119_000,
    netTotal: 100_000,
    vatRate: 19,
    lineItems: [
      {
        id: 'qli-1',
        label: 'Arbeitslohn',
        category: 'labor',
        netAmount: 80_000,
        quantity: 1,
      },
      {
        id: 'qli-2',
        label: 'Material',
        category: 'material',
        netAmount: 20_000,
        quantity: 1,
      },
    ],
    status: 'accepted',
    sentAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } as Offer
}

const provider: SnapshotProviderInput = {
  providerId: 'prov-1',
  companyName: 'Müller Sanitär GmbH',
  businessAddress: 'Hauptstraße 5, 10115 Berlin',
  taxNumber: '12/345/67890',
  vatId: 'DE123456789',
  legalForm: 'gmbh',
  isKleinunternehmer: false,
  defaultVatRate: 19,
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
}

const customer: SnapshotCustomerInput = {
  userId: 'cust-1',
  billingName: 'Julia Neumann',
  billingAddressLine1: 'Mozartstraße 12',
  billingAddressLine2: null,
  billingPostalCode: '10115',
  billingCity: 'Berlin',
  billingCountry: 'DE',
  billingEmail: null,
  billingPhone: null,
  isBusiness: false,
  businessName: null,
  vatId: null,
}

const servicePeriod: InvoiceServicePeriod = {
  from: new Date('2026-04-10').getTime(),
  to: new Date('2026-04-15').getTime(),
  label: 'Leistungszeitraum: 10.04.2026 – 15.04.2026',
}

describe('buildInvoiceSnapshot', () => {
  it('A. friert Provider- und Customer-Snapshot vollständig ein', () => {
    const out = buildInvoiceSnapshot({
      job: makeJob(),
      offer: makeOffer(),
      acceptedChangeOrders: [],
      supplementaryPayments: [],
      provider,
      customer,
      servicePeriod,
    })
    expect(out.providerSnapshot.companyName).toBe('Müller Sanitär GmbH')
    expect(out.providerSnapshot.taxNumber).toBe('12/345/67890')
    expect(out.providerSnapshot.vatId).toBe('DE123456789')
    expect(out.customerSnapshot?.billingName).toBe('Julia Neumann')
    expect(out.customerSnapshot?.billingPostalCode).toBe('10115')
    expect(out.customerSnapshot?.billingCountry).toBe('DE')
    expect(out.parties.issuerName).toBe('Müller Sanitär GmbH')
    expect(out.parties.customerName).toBe('Julia Neumann')
  })

  it('B. übernimmt akzeptierte ChangeOrders als zusätzliche LineItems', () => {
    const co: ChangeOrder = {
      id: 'co-1',
      jobId: 'job-1',
      sourceOfferId: 'offer-1',
      craftsmanUserId: 'craft-1',
      customerUserId: 'cust-1',
      description: 'Mehrarbeit Feuchtigkeitsschäden',
      price: '300 €',
      grossTotal: 35_700,
      netTotal: 30_000,
      vatRate: 19,
      status: 'accepted',
      acceptedAt: 0,
      createdAt: 0,
      updatedAt: 0,
    }
    const out = buildInvoiceSnapshot({
      job: makeJob(),
      offer: makeOffer(),
      acceptedChangeOrders: [co],
      supplementaryPayments: [],
      provider,
      customer,
      servicePeriod,
    })
    expect(out.lineItems.length).toBe(3)
    const nachtragLine = out.lineItems.find((li) => li.id === 'co_co-1')
    expect(nachtragLine).toBeDefined()
    expect(nachtragLine?.label).toContain('Nachtrag')
    // 800 € (Arbeitslohn) + 200 € (Material) + 300 € (Nachtrag) = 1300 € net.
    expect(out.amounts.netAmount).toBeCloseTo(1300, 2)
    // 19 % auf alles → 1300 + 247 = 1547 € brutto.
    expect(out.amounts.grossAmount).toBeCloseTo(1547, 2)
  })

  it('C. nimmt SupplementaryPayment-IDs auf, addiert ihre Beträge NICHT', () => {
    const co: ChangeOrder = {
      id: 'co-1',
      jobId: 'job-1',
      craftsmanUserId: 'craft-1',
      customerUserId: 'cust-1',
      description: 'Nachtrag',
      price: '300',
      grossTotal: 35_700,
      netTotal: 30_000,
      vatRate: 19,
      status: 'accepted',
      createdAt: 0,
      updatedAt: 0,
    }
    const sp: SupplementaryPaymentRequest = {
      id: 'sp-1',
      changeOrderId: 'co-1',
      jobId: 'job-1',
      originalPaymentId: 'p-1',
      customerUserId: 'cust-1',
      craftsmanUserId: 'craft-1',
      amountCents: 35_700,
      currency: 'EUR',
      status: 'paid',
      createdAt: 0,
      updatedAt: 0,
    }
    const out = buildInvoiceSnapshot({
      job: makeJob(),
      offer: makeOffer(),
      acceptedChangeOrders: [co],
      supplementaryPayments: [sp],
      provider,
      customer,
      servicePeriod,
    })
    // Drei Lines: zwei aus Offer + eine aus ChangeOrder. SP nicht addiert.
    expect(out.lineItems.length).toBe(3)
    expect(out.sourceSupplementaryPaymentIds).toEqual(['sp-1'])
    // Brutto = 1190 (Offer) + 357 (CO) = 1547
    expect(out.amounts.grossAmount).toBeCloseTo(1547.0, 2)
  })

  it('D. wirft, wenn Provider-Snapshot incomplete (kein taxNumber + kein vatId)', () => {
    expect(() =>
      buildInvoiceSnapshot({
        job: makeJob(),
        offer: makeOffer(),
        acceptedChangeOrders: [],
        supplementaryPayments: [],
        provider: { ...provider, taxNumber: null, vatId: null },
        customer,
        servicePeriod,
      }),
    ).toThrow(/tax_number or vat_id/)
  })

  it('E. wirft, wenn Customer-Snapshot fehlt komplett', () => {
    expect(() =>
      buildInvoiceSnapshot({
        job: makeJob(),
        offer: makeOffer(),
        acceptedChangeOrders: [],
        supplementaryPayments: [],
        provider,
        customer: null,
        servicePeriod,
      }),
    ).toThrow(/customer billing profile is missing/)
  })

  it('F. wirft, wenn Service-Period fehlt', () => {
    expect(() =>
      buildInvoiceSnapshot({
        job: makeJob(),
        offer: makeOffer(),
        acceptedChangeOrders: [],
        supplementaryPayments: [],
        provider,
        customer,
        servicePeriod: null,
      }),
    ).toThrow(/service period/)
  })

  it('G. zwingt Kleinunternehmer auf 0% und setzt §19-Note', () => {
    const out = buildInvoiceSnapshot({
      job: makeJob(),
      offer: makeOffer(),
      acceptedChangeOrders: [],
      supplementaryPayments: [],
      provider: { ...provider, isKleinunternehmer: true, defaultVatRate: 0 },
      customer,
      servicePeriod,
    })
    expect(out.taxNote).toBe(KLEINUNTERNEHMER_TAX_NOTE)
    expect(out.taxBreakdown.length).toBe(1)
    expect(out.taxBreakdown[0].vatRate).toBe(0)
    expect(out.amounts.taxAmount).toBe(0)
    expect(out.lineItems.every((li) => li.vatRate === 0)).toBe(true)
  })

  it('H. nimmt LineItem-VAT-Override pro Position an', () => {
    const out = buildInvoiceSnapshot({
      job: makeJob(),
      offer: makeOffer(),
      acceptedChangeOrders: [],
      supplementaryPayments: [],
      provider,
      customer,
      servicePeriod,
      lineItemOverrides: [{ lineItemId: 'li_qli-2', vatRate: 7 }],
    })
    const overridden = out.lineItems.find((li) => li.id === 'li_qli-2')
    expect(overridden?.vatRate).toBe(7)
    expect(out.taxBreakdown.length).toBe(2)
  })

  it('I. wirft, wenn weder Offer noch ChangeOrders verwertbare Positionen liefern', () => {
    expect(() =>
      buildInvoiceSnapshot({
        job: makeJob(),
        offer: null,
        acceptedChangeOrders: [],
        supplementaryPayments: [],
        provider,
        customer,
        servicePeriod,
      }),
    ).toThrow(/no line items derivable/)
  })

  it('I.b. wirft bei Override mit unerlaubtem Steuersatz', () => {
    expect(() =>
      buildInvoiceSnapshot({
        job: makeJob(),
        offer: makeOffer(),
        acceptedChangeOrders: [],
        supplementaryPayments: [],
        provider,
        customer,
        servicePeriod,
        lineItemOverrides: [{ lineItemId: 'li_qli-1', vatRate: 5 }],
      }),
    ).toThrow(/Invalid VAT rate/)
  })
})
