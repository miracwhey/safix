/**
 * Block 7.1B3 — Invoice Snapshot Builder.
 *
 * Pure Funktion, die zum draft → issued Übergang aus
 *   - Provider Tax & Bank Profile (B1)
 *   - Customer Billing Profile (B2)
 *   - Offer (akzeptierte Quote, Basis-Linien)
 *   - akzeptierte ChangeOrders (Nachträge)
 * den unveränderlichen §14-UStG-Snapshot zusammenbaut.
 *
 * Kernregeln:
 *
 *   1. Provider- und Customer-Snapshot werden vollständig in die Invoice
 *      eingefroren — niemals nach Issuance retroaktiv ändern.
 *   2. ChangeOrders mit Status `accepted` werden als zusätzliche Positionen
 *      angehängt, mit Label `Nachtrag: <Beschreibung>`.
 *   3. SupplementaryPaymentRequests werden NUR als Audit-IDs aufgenommen,
 *      NICHT als zusätzliche Positionen — sie sind nur die Geld-Spiegel der
 *      ChangeOrders, eine zweite Aufnahme würde doppelt zählen.
 *   4. Steuersatz pro Position folgt dem Tax-Modell (Provider-Default mit
 *      manueller Override-Möglichkeit pro Position).
 *   5. Kleinunternehmer (`isKleinunternehmer`) zwingt alle Sätze auf 0 % und
 *      setzt den §19-Steuerhinweis.
 *
 * Nicht-Scope:
 *   - Auto-Erkennung 7 % (z. B. ÖPNV, Druckerzeugnisse).
 *   - §13b Reverse-Charge.
 *   - Differenzbesteuerung.
 */

import type { ChangeOrder } from '../changeOrders/types'
import type { Job } from '../jobs'
import type { Offer, QuoteLineItem } from '../offers/types'
import type { SupplementaryPaymentRequest } from '../payments/supplementary/types'
import {
  applyTaxDefaults,
  assertTaxConsistency,
  buildTaxBreakdown,
  deriveTaxNote,
  isAllowedVatRate,
  type TaxModelProvider,
} from './invoiceTaxModel'
import type {
  CustomerInvoiceSnapshot,
  Invoice,
  InvoiceAmounts,
  InvoiceLineItem,
  InvoiceLineItemCategory,
  InvoiceServicePeriod,
  InvoiceTaxBreakdownEntry,
  ProviderInvoiceSnapshot,
} from './types'

const VAT_EPSILON = 0.005

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100
}

// ── Eingabe-Form ──────────────────────────────────────────────────────────────

export type SnapshotProviderInput = {
  providerId: string
  companyName: string
  businessAddress: string | null
  taxNumber: string | null
  vatId: string | null
  legalForm: string | null
  isKleinunternehmer: boolean
  defaultVatRate: number
  iban: string | null
  bic: string | null
}

export type SnapshotCustomerInput = {
  userId: string
  billingName: string | null
  billingAddressLine1: string | null
  billingAddressLine2: string | null
  billingPostalCode: string | null
  billingCity: string | null
  billingCountry: string
  billingEmail: string | null
  billingPhone: string | null
  isBusiness: boolean
  businessName: string | null
  vatId: string | null
}

export type LineItemVatOverride = {
  /** ID der Invoice-LineItem (siehe `InvoiceLineItem.id`). */
  lineItemId: string
  vatRate?: number
  category?: InvoiceLineItemCategory
}

export type SnapshotInput = {
  job: Job
  offer: Offer | null
  acceptedChangeOrders: ChangeOrder[]
  supplementaryPayments: SupplementaryPaymentRequest[]
  provider: SnapshotProviderInput
  customer: SnapshotCustomerInput | null
  servicePeriod: InvoiceServicePeriod | null
  /** Optional: pro Position Override für Kategorie und Steuersatz. */
  lineItemOverrides?: LineItemVatOverride[]
}

export type SnapshotResult = {
  parties: Invoice['parties']
  lineItems: InvoiceLineItem[]
  amounts: InvoiceAmounts
  servicePeriod: InvoiceServicePeriod | null
  taxBreakdown: InvoiceTaxBreakdownEntry[]
  taxNote: string | null
  providerSnapshot: ProviderInvoiceSnapshot
  customerSnapshot: CustomerInvoiceSnapshot | null
  sourceOfferId: string | null
  sourceChangeOrderIds: string[]
  sourceSupplementaryPaymentIds: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapQuoteLineItemToInvoiceLineItem(
  qli: QuoteLineItem,
  prefix: string,
): InvoiceLineItem {
  return {
    id: `${prefix}_${qli.id}`,
    label: qli.label,
    quantity: qli.quantity,
    unitPrice: roundTo2(qli.netAmount / 100),
    total: roundTo2((qli.netAmount * qli.quantity) / 100),
    category: qli.category,
  }
}

function fallbackLabelFromOffer(offer: Offer | null, job: Job): string {
  return (
    offer?.scopeSummary?.trim() ||
    offer?.description?.trim() ||
    job.title?.trim() ||
    'Handwerksleistung'
  )
}

function buildOfferBaseLines(
  offer: Offer | null,
  job: Job,
): InvoiceLineItem[] {
  if (!offer) {
    return []
  }
  if (offer.lineItems && offer.lineItems.length > 0) {
    return offer.lineItems.map((qli) =>
      mapQuoteLineItemToInvoiceLineItem(qli, 'li'),
    )
  }
  if (offer.grossTotal && offer.grossTotal > 0) {
    const gross = roundTo2(offer.grossTotal / 100)
    const vatRate = offer.vatRate ?? 19
    const net =
      offer.netTotal && offer.netTotal > 0
        ? roundTo2(offer.netTotal / 100)
        : roundTo2(gross / (1 + vatRate / 100))
    return [
      {
        id: `li_${job.id}`,
        label: fallbackLabelFromOffer(offer, job),
        quantity: 1,
        unitPrice: net,
        total: net,
        category: 'labor',
      },
    ]
  }
  return []
}

function buildChangeOrderLines(orders: ChangeOrder[]): InvoiceLineItem[] {
  return orders.flatMap((co) => {
    if (!co.grossTotal || co.grossTotal <= 0) return []
    const vatRate = co.vatRate ?? 19
    const gross = roundTo2(co.grossTotal / 100)
    const net =
      co.netTotal && co.netTotal > 0
        ? roundTo2(co.netTotal / 100)
        : roundTo2(gross / (1 + vatRate / 100))
    return [
      {
        id: `co_${co.id}`,
        label: `Nachtrag: ${co.description?.trim() || co.id}`,
        quantity: 1,
        unitPrice: net,
        total: net,
        category: 'labor',
        vatRate,
      },
    ]
  })
}

function applyOverrides(
  items: InvoiceLineItem[],
  overrides: LineItemVatOverride[] | undefined,
): InvoiceLineItem[] {
  if (!overrides || overrides.length === 0) return items
  const byId = new Map(overrides.map((o) => [o.lineItemId, o]))
  return items.map((item) => {
    const override = byId.get(item.id)
    if (!override) return item
    if (
      typeof override.vatRate === 'number' &&
      !isAllowedVatRate(override.vatRate)
    ) {
      throw new Error(
        `Invalid VAT rate ${override.vatRate} for line item ${item.id}. ` +
          `Allowed values are 0, 7, 19.`,
      )
    }
    return {
      ...item,
      vatRate: override.vatRate ?? item.vatRate,
      category: override.category ?? item.category,
    }
  })
}

function buildAmountsFromLineItems(items: InvoiceLineItem[]): InvoiceAmounts {
  let net = 0
  let tax = 0
  let gross = 0
  for (const item of items) {
    net = roundTo2(net + item.total)
    tax = roundTo2(tax + (item.vatAmount ?? 0))
    gross = roundTo2(gross + (item.gross ?? item.total))
  }
  return { netAmount: net, taxAmount: tax, grossAmount: gross }
}

// ── Validation Helpers ────────────────────────────────────────────────────────

function assertProviderSnapshotComplete(p: SnapshotProviderInput): void {
  if (!p.companyName || p.companyName.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: provider companyName is missing. ' +
        'Trage einen Firmennamen im Betriebsprofil ein.',
    )
  }
  if (!p.businessAddress || p.businessAddress.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: provider businessAddress is missing. ' +
        'Trage eine Geschäftsanschrift im Betriebsprofil ein.',
    )
  }
  if (!p.businessAddress.includes(',')) {
    throw new Error(
      'Invoice cannot be issued: provider businessAddress is incomplete. ' +
        'Erwartetes Format: "Straße Nr, PLZ Stadt".',
    )
  }
  const hasTaxId =
    (p.taxNumber && p.taxNumber.trim() !== '') ||
    (p.vatId && p.vatId.trim() !== '')
  if (!hasTaxId) {
    throw new Error(
      'Invoice cannot be issued: provider tax_number or vat_id is required. ' +
        'Trage Steuernummer oder USt-IdNr. im Steuer-/Bankprofil ein.',
    )
  }
}

function assertCustomerSnapshotComplete(
  c: SnapshotCustomerInput | null,
): asserts c is SnapshotCustomerInput {
  if (!c) {
    throw new Error(
      'Invoice cannot be issued: customer billing profile is missing. ' +
        'Der Kunde muss zuerst seine Rechnungsdaten unter „Konto → Rechnungsdaten" ergänzen.',
    )
  }
  if (!c.billingName || c.billingName.trim() === '') {
    throw new Error('Invoice cannot be issued: customer billingName is missing.')
  }
  if (!c.billingAddressLine1 || c.billingAddressLine1.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: customer billingAddressLine1 is missing.',
    )
  }
  if (!c.billingPostalCode || c.billingPostalCode.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: customer billingPostalCode is missing.',
    )
  }
  if (!c.billingCity || c.billingCity.trim() === '') {
    throw new Error('Invoice cannot be issued: customer billingCity is missing.')
  }
  if (!c.billingCountry || c.billingCountry.trim().length !== 2) {
    throw new Error(
      'Invoice cannot be issued: customer billingCountry must be a 2-letter ISO code.',
    )
  }
}

function assertServicePeriod(
  period: InvoiceServicePeriod | null,
): asserts period is InvoiceServicePeriod {
  if (!period) {
    throw new Error(
      'Invoice cannot be issued: service period is missing. ' +
        'Bestätige oder ergänze den Leistungszeitraum vor dem Ausstellen.',
    )
  }
  if (!period.label || period.label.trim() === '') {
    throw new Error('Invoice cannot be issued: service period label is empty.')
  }
}

// ── Snapshot Builder (Public) ─────────────────────────────────────────────────

/**
 * Erzeugt den vollständigen §14-Snapshot für die Issue-Transition.
 * Wirft mit klarer Fehlermeldung bei jeder Daten-Lücke.
 */
export function buildInvoiceSnapshot(input: SnapshotInput): SnapshotResult {
  const {
    job,
    offer,
    acceptedChangeOrders,
    supplementaryPayments,
    provider,
    customer,
    servicePeriod,
    lineItemOverrides,
  } = input

  // 1. Hard-Gate Provider + Customer + Service-Period vor jeder weiteren Arbeit.
  assertProviderSnapshotComplete(provider)
  assertCustomerSnapshotComplete(customer)
  assertServicePeriod(servicePeriod)

  // 2. Positionen aufbauen: Offer-Basis + akzeptierte ChangeOrders.
  const baseLines = buildOfferBaseLines(offer, job)
  const changeOrderLines = buildChangeOrderLines(acceptedChangeOrders)
  const combined = [...baseLines, ...changeOrderLines]
  if (combined.length === 0) {
    throw new Error(
      `Invoice cannot be issued: no line items derivable for job "${job.id}". ` +
        'Offer und ChangeOrders enthalten keine verwertbaren Positionen.',
    )
  }

  const overridden = applyOverrides(combined, lineItemOverrides)

  // 3. Tax-Modell anwenden (Provider-Default, Kleinunternehmer 0 %).
  const taxProvider: TaxModelProvider = {
    isKleinunternehmer: provider.isKleinunternehmer,
    defaultVatRate: provider.defaultVatRate,
  }
  const lineItems = applyTaxDefaults(overridden, taxProvider)

  // 4. Konsistenz: jede Position muss vatRate, vatAmount, gross gesetzt haben.
  for (const item of lineItems) {
    if (typeof item.vatRate !== 'number') {
      throw new Error(
        `Invoice cannot be issued: line item "${item.id}" has no vatRate after tax-model resolution.`,
      )
    }
    if (typeof item.vatAmount !== 'number') {
      throw new Error(
        `Invoice cannot be issued: line item "${item.id}" has no vatAmount after tax-model resolution.`,
      )
    }
    if (typeof item.gross !== 'number') {
      throw new Error(
        `Invoice cannot be issued: line item "${item.id}" has no gross after tax-model resolution.`,
      )
    }
    if (item.total <= 0) {
      throw new Error(
        `Invoice cannot be issued: line item "${item.id}" has a non-positive net total.`,
      )
    }
  }

  // 5. Aggregate + Tax-Breakdown.
  const amounts = buildAmountsFromLineItems(lineItems)
  if (amounts.grossAmount <= VAT_EPSILON) {
    throw new Error(
      'Invoice cannot be issued: gross amount must be greater than 0.',
    )
  }
  const taxBreakdown = buildTaxBreakdown(lineItems)
  assertTaxConsistency(lineItems, amounts, taxBreakdown)

  // 6. Provider/Customer/Tax-Note.
  const providerSnapshot: ProviderInvoiceSnapshot = {
    providerId: provider.providerId,
    companyName: provider.companyName.trim(),
    businessAddress: (provider.businessAddress ?? '').trim(),
    taxNumber: provider.taxNumber?.trim() || null,
    vatId: provider.vatId?.trim() || null,
    legalForm: provider.legalForm?.trim() || null,
    isKleinunternehmer: provider.isKleinunternehmer,
    defaultVatRate: provider.defaultVatRate,
    iban: provider.iban?.trim() || null,
    bic: provider.bic?.trim() || null,
  }

  const customerSnapshot: CustomerInvoiceSnapshot = {
    userId: customer.userId,
    billingName: (customer.billingName ?? '').trim(),
    billingAddressLine1: (customer.billingAddressLine1 ?? '').trim(),
    billingAddressLine2: customer.billingAddressLine2?.trim() || null,
    billingPostalCode: (customer.billingPostalCode ?? '').trim(),
    billingCity: (customer.billingCity ?? '').trim(),
    billingCountry: customer.billingCountry.trim().toUpperCase(),
    billingEmail: customer.billingEmail?.trim() || null,
    billingPhone: customer.billingPhone?.trim() || null,
    isBusiness: customer.isBusiness,
    businessName: customer.businessName?.trim() || null,
    vatId: customer.vatId?.trim() || null,
  }

  const taxNote = deriveTaxNote(taxProvider)

  // 7. parties wird mit den Snapshot-Daten gespiegelt, damit existing UI-
  //    Reads (CustomerInvoiceCard etc.) weiterhin korrekte Aussteller-/
  //    Empfänger-Namen sehen, ohne den Snapshot-Pfad zu kennen.
  const parties: Invoice['parties'] = {
    issuerName: providerSnapshot.companyName,
    issuerAddress: providerSnapshot.businessAddress,
    customerName: customerSnapshot.billingName,
  }

  // 8. Audit-IDs.
  const sourceChangeOrderIds = acceptedChangeOrders.map((co) => co.id)
  const sourceSupplementaryPaymentIds = supplementaryPayments
    .filter((sp) => sourceChangeOrderIds.includes(sp.changeOrderId))
    .map((sp) => sp.id)

  return {
    parties,
    lineItems,
    amounts,
    servicePeriod,
    taxBreakdown,
    taxNote,
    providerSnapshot,
    customerSnapshot,
    sourceOfferId: offer?.id ?? null,
    sourceChangeOrderIds,
    sourceSupplementaryPaymentIds,
  }
}
