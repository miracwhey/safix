/**
 * Block 7.1B3 — Snapshot-Hard-Gate-Validierung.
 *
 * Tests `validateInvoiceSnapshotComplete` als Workflow-Pflicht-Pfad-
 * Validierung VOR der draft → issued Engine-Transition. Die Engine selbst
 * läuft nur mit `validateInvoiceIssuancePreconditions` (Baseline) — getestet
 * separat in tests/shared/block8_*.
 */

import { describe, it, expect } from 'vitest'
import { validateInvoiceSnapshotComplete } from '../../src/lib/invoices/invoiceValidation'
import type {
  Invoice,
  InvoiceServicePeriod,
  ProviderInvoiceSnapshot,
  CustomerInvoiceSnapshot,
} from '../../src/lib/invoices/types'

const provider: ProviderInvoiceSnapshot = {
  providerId: 'prov-1',
  companyName: 'Müller Sanitär GmbH',
  businessAddress: 'Hauptstraße 5, 10115 Berlin',
  taxNumber: '12/345/67890',
  vatId: null,
  legalForm: 'gmbh',
  isKleinunternehmer: false,
  defaultVatRate: 19,
  iban: null,
  bic: null,
}

const customer: CustomerInvoiceSnapshot = {
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
  from: 1,
  to: 2,
  label: 'Leistungszeitraum: 10.04.2026 – 12.04.2026',
}

function makeIssuableInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    jobId: 'job-1',
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Julia Neumann',
    },
    lineItems: [
      {
        id: 'li_1',
        label: 'Arbeitslohn',
        category: 'labor',
        quantity: 1,
        unitPrice: 100,
        total: 100,
        vatRate: 19,
        vatAmount: 19,
        gross: 119,
      },
    ],
    amounts: { netAmount: 100, taxAmount: 19, grossAmount: 119 },
    issuedAt: 0,
    issuedAtLabel: '',
    dueAtLabel: '',
    sentAt: 0,
    servicePeriod,
    taxBreakdown: [
      { vatRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ],
    taxNote: null,
    providerSnapshot: provider,
    customerSnapshot: customer,
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
    ...overrides,
  }
}

describe('validateInvoiceSnapshotComplete', () => {
  it('passt für vollständig befüllte Invoice', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(makeIssuableInvoice()),
    ).not.toThrow()
  })

  it('blockiert ohne providerSnapshot', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({ providerSnapshot: null }),
      ),
    ).toThrow(/provider snapshot is missing/)
  })

  it('blockiert ohne tax_number und ohne vat_id', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({
          providerSnapshot: { ...provider, taxNumber: null, vatId: null },
        }),
      ),
    ).toThrow(/tax_number and vat_id/)
  })

  it('blockiert ohne customerSnapshot', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({ customerSnapshot: null }),
      ),
    ).toThrow(/customer billing snapshot is missing/)
  })

  it('blockiert mit unvollständiger Customer-Anschrift', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({
          customerSnapshot: { ...customer, billingPostalCode: '' },
        }),
      ),
    ).toThrow(/customer billing address is incomplete/)
  })

  it('blockiert ohne servicePeriod', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({ servicePeriod: null }),
      ),
    ).toThrow(/service period is missing/)
  })

  it('blockiert leere taxBreakdown', () => {
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({ taxBreakdown: [] }),
      ),
    ).toThrow(/taxBreakdown is empty/)
  })

  it('blockiert Kleinunternehmer mit > 0% Sätzen', () => {
    const klein: ProviderInvoiceSnapshot = {
      ...provider,
      isKleinunternehmer: true,
    }
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({
          providerSnapshot: klein,
          taxNote: 'Gemäß §19 UStG wird keine Umsatzsteuer berechnet.',
          // 19%-Breakdown trotz Kleinunternehmer → muss blocken
        }),
      ),
    ).toThrow(/0 %/)
  })

  it('blockiert Kleinunternehmer ohne taxNote', () => {
    const klein: ProviderInvoiceSnapshot = {
      ...provider,
      isKleinunternehmer: true,
    }
    expect(() =>
      validateInvoiceSnapshotComplete(
        makeIssuableInvoice({
          providerSnapshot: klein,
          lineItems: [
            {
              id: 'li_1',
              label: 'Arbeitslohn',
              category: 'labor',
              quantity: 1,
              unitPrice: 100,
              total: 100,
              vatRate: 0,
              vatAmount: 0,
              gross: 100,
            },
          ],
          amounts: { netAmount: 100, taxAmount: 0, grossAmount: 100 },
          taxBreakdown: [
            { vatRate: 0, netAmount: 100, taxAmount: 0, grossAmount: 100 },
          ],
          taxNote: null,
        }),
      ),
    ).toThrow(/Kleinunternehmer-Hinweis/)
  })
})
