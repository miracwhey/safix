/**
 * Block 7.1B3 — Reines Steuermodell für die Invoice-Issuance.
 *
 * Verantwortlich für drei Dinge:
 *   1. Defaults pro Position (Steuersatz, Kategorie) aus dem
 *      Provider-Tax-Profile + Offer-LineItem-Quellen ableiten.
 *   2. Tax-Breakdown gruppiert nach Steuersatz erzeugen (§14 (4) Nr. 7+8 UStG).
 *   3. Steuerhinweis-Text setzen (Kleinunternehmer §19 UStG).
 *
 * Bewusst NICHT in B3:
 *   - Automatische 7 %-Erkennung (Catering, Druckerzeugnisse, ÖPNV …)
 *   - Differenzbesteuerung (§25a UStG)
 *   - §13b Reverse-Charge (Bauleistungen B2B) — Schema-Vorbereitung ist da,
 *     Aktivierung folgt in einem späteren Block.
 *
 * Das Modul ist pure (keine I/O). Aufrufer holen Provider-Profile und Offer
 * aus den jeweiligen Domains; das Tax-Modell bekommt nur die abgeleiteten
 * Eingaben.
 */

import type {
  InvoiceLineItem,
  InvoiceLineItemCategory,
  InvoiceTaxBreakdownEntry,
} from './types'

/**
 * §19-UStG-Hinweis-Text — gemeinsamer Wortlaut für PDF, IssueSheet,
 * Repository-Snapshot. Wird als immutable Snapshot eingefroren, damit ein
 * späterer Wording-Pass auf der App-Seite ältere Rechnungen nicht
 * retroaktiv „umschreibt".
 */
export const KLEINUNTERNEHMER_TAX_NOTE =
  'Gemäß §19 UStG wird keine Umsatzsteuer berechnet.'

const VAT_EPSILON = 0.005

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100
}

export type TaxModelProvider = {
  isKleinunternehmer: boolean
  defaultVatRate: number
}

/**
 * Validiert, dass ein eingegebener Steuersatz im erlaubten Set liegt. B3
 * erlaubt 0 / 7 / 19 — andere Sätze sind keine Auto-Detect-Fälle und müssen
 * über einen späteren Block aufgenommen werden.
 */
export function isAllowedVatRate(rate: number): boolean {
  return rate === 0 || rate === 7 || rate === 19
}

/**
 * Wendet Default-Werte für Kategorie und Steuersatz auf alle Positionen an,
 * ohne bestehende manuelle Overrides zu überschreiben.
 *
 * Reihenfolge der Default-Quellen pro Position:
 *   - `category`: vorhandener Wert > 'labor' (konservative Annahme; PDF
 *     blendet §35a-Hinweis nur ein, wenn Lohn-/Anfahrt-Anteil vorhanden ist).
 *   - `vatRate`: vorhandener Wert > Provider.defaultVatRate (bei
 *     Kleinunternehmer überschrieben auf 0).
 */
export function applyTaxDefaults(
  lineItems: InvoiceLineItem[],
  provider: TaxModelProvider,
): InvoiceLineItem[] {
  const baseRate = provider.isKleinunternehmer ? 0 : provider.defaultVatRate

  return lineItems.map((item) => {
    // Bei Kleinunternehmer wird jede Position hart auf 0 % gesetzt — auch
    // ein vorhandenes Override wird ignoriert. §19 UStG verbietet jeden
    // anderen Steuerausweis.
    const vatRate = provider.isKleinunternehmer
      ? 0
      : typeof item.vatRate === 'number' && isAllowedVatRate(item.vatRate)
        ? item.vatRate
        : isAllowedVatRate(baseRate)
          ? baseRate
          : 19
    const category: InvoiceLineItemCategory = item.category ?? 'labor'
    const vatAmount = roundTo2((item.total * vatRate) / 100)
    const gross = roundTo2(item.total + vatAmount)
    return {
      ...item,
      category,
      vatRate,
      vatAmount,
      gross,
    }
  })
}

/**
 * Erzeugt die Steuer-Aufstellung gruppiert nach `vatRate`. Erwartet, dass
 * jede Position bereits durchgerechnet ist (`vatAmount`, `gross` gesetzt) —
 * `applyTaxDefaults` ist die kanonische Vorstufe.
 */
export function buildTaxBreakdown(
  lineItems: InvoiceLineItem[],
): InvoiceTaxBreakdownEntry[] {
  const groups = new Map<
    number,
    { netAmount: number; taxAmount: number; grossAmount: number }
  >()

  for (const item of lineItems) {
    const rate = item.vatRate ?? 19
    const net = item.total
    const tax = item.vatAmount ?? roundTo2((net * rate) / 100)
    const gross = item.gross ?? roundTo2(net + tax)

    const existing = groups.get(rate) ?? {
      netAmount: 0,
      taxAmount: 0,
      grossAmount: 0,
    }
    groups.set(rate, {
      netAmount: roundTo2(existing.netAmount + net),
      taxAmount: roundTo2(existing.taxAmount + tax),
      grossAmount: roundTo2(existing.grossAmount + gross),
    })
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([vatRate, sums]) => ({
      vatRate,
      netAmount: sums.netAmount,
      taxAmount: sums.taxAmount,
      grossAmount: sums.grossAmount,
    }))
}

/**
 * Liefert den Pflicht-Steuerhinweis für die Rechnung. NULL wenn keine
 * Hinweispflicht. In B3 abgedeckt: §19 Kleinunternehmer.
 */
export function deriveTaxNote(provider: TaxModelProvider): string | null {
  if (provider.isKleinunternehmer) {
    return KLEINUNTERNEHMER_TAX_NOTE
  }
  return null
}

/**
 * Stellt sicher, dass die aggregierten Beträge auf der Invoice mit der
 * Position-Summe und dem Tax-Breakdown übereinstimmen. Toleranz 0,005 € pro
 * Spalte, um Float-Rundungsdrift zu absorbieren ohne echte Inkonsistenz
 * durchzulassen.
 */
export function assertTaxConsistency(
  lineItems: InvoiceLineItem[],
  amounts: { netAmount: number; taxAmount: number; grossAmount: number },
  taxBreakdown: InvoiceTaxBreakdownEntry[],
): void {
  const netSum = roundTo2(
    lineItems.reduce((acc, li) => acc + li.total, 0),
  )
  const taxSum = roundTo2(
    lineItems.reduce((acc, li) => acc + (li.vatAmount ?? 0), 0),
  )
  const grossSum = roundTo2(
    lineItems.reduce((acc, li) => acc + (li.gross ?? li.total), 0),
  )

  if (Math.abs(netSum - amounts.netAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: net amount ${amounts.netAmount.toFixed(
        2,
      )} does not match line-item sum ${netSum.toFixed(2)}.`,
    )
  }
  if (Math.abs(taxSum - amounts.taxAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: tax amount ${amounts.taxAmount.toFixed(
        2,
      )} does not match line-item sum ${taxSum.toFixed(2)}.`,
    )
  }
  if (Math.abs(grossSum - amounts.grossAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: gross amount ${amounts.grossAmount.toFixed(
        2,
      )} does not match line-item sum ${grossSum.toFixed(2)}.`,
    )
  }

  const breakdownNet = roundTo2(
    taxBreakdown.reduce((acc, e) => acc + e.netAmount, 0),
  )
  const breakdownTax = roundTo2(
    taxBreakdown.reduce((acc, e) => acc + e.taxAmount, 0),
  )
  const breakdownGross = roundTo2(
    taxBreakdown.reduce((acc, e) => acc + e.grossAmount, 0),
  )

  if (Math.abs(breakdownNet - amounts.netAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: tax breakdown net sum ${breakdownNet.toFixed(
        2,
      )} does not match invoice net amount ${amounts.netAmount.toFixed(2)}.`,
    )
  }
  if (Math.abs(breakdownTax - amounts.taxAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: tax breakdown tax sum ${breakdownTax.toFixed(
        2,
      )} does not match invoice tax amount ${amounts.taxAmount.toFixed(2)}.`,
    )
  }
  if (Math.abs(breakdownGross - amounts.grossAmount) > VAT_EPSILON) {
    throw new Error(
      `Invoice cannot be issued: tax breakdown gross sum ${breakdownGross.toFixed(
        2,
      )} does not match invoice gross amount ${amounts.grossAmount.toFixed(
        2,
      )}.`,
    )
  }
}
