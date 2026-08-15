import { assertTaxConsistency } from './invoiceTaxModel'
import type { Invoice } from './types'

/**
 * Known placeholder issuer names written by createInvoiceFromJob when no real
 * issuer data is provided. These must be blocked at issuance time to enforce
 * that every issued invoice carries real craftsman identity data.
 */
export const KNOWN_PLACEHOLDER_ISSUER_NAMES = new Set([
  'SaFix Partnerbetrieb',
])

/**
 * Known placeholder issuer addresses written by createInvoiceFromJob when no
 * real issuer data is provided.
 */
export const KNOWN_PLACEHOLDER_ISSUER_ADDRESSES = new Set([
  'Handwerkerstraße 12, 80331 München',
])

/**
 * Baseline-Validierung für jeden draft → issued Übergang. Wird vom Engine
 * (`transitionInvoiceStatus`) zwingend gerufen.
 *
 * Block 7.1B3: Engine bleibt schmal — Snapshot- und §14-Hard-Gates leben in
 * `validateInvoiceSnapshotComplete` und werden vom Issue-Workflow gerufen,
 * BEVOR die Engine-Transition läuft. Auf der Engine-Ebene reichen die
 * Baseline-Checks, damit Test- und Legacy-Pfade nicht hart brechen, während
 * der Production-Issue-Pfad (UI → IssueInvoiceSheet → Workflow) immer durch
 * die volle B3-Validierung muss.
 */
export function validateInvoiceIssuancePreconditions(invoice: Invoice): void {
  if (!invoice.parties.issuerName || invoice.parties.issuerName.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: parties.issuerName is missing or empty',
    )
  }

  if (KNOWN_PLACEHOLDER_ISSUER_NAMES.has(invoice.parties.issuerName)) {
    throw new Error(
      'Invoice cannot be issued: parties.issuerName is a placeholder value. ' +
        'Real craftsman issuer data is required before issuing an invoice.',
    )
  }

  if (
    !invoice.parties.issuerAddress ||
    invoice.parties.issuerAddress.trim() === ''
  ) {
    throw new Error(
      'Invoice cannot be issued: parties.issuerAddress is missing or empty',
    )
  }

  if (KNOWN_PLACEHOLDER_ISSUER_ADDRESSES.has(invoice.parties.issuerAddress)) {
    throw new Error(
      'Invoice cannot be issued: parties.issuerAddress is a placeholder value. ' +
        'Real craftsman issuer data is required before issuing an invoice.',
    )
  }

  if (!invoice.parties.issuerAddress.includes(',')) {
    throw new Error(
      'Invoice cannot be issued: parties.issuerAddress is incomplete. ' +
        'A full address is required (expected format: "Street Number, PostalCode City").',
    )
  }

  if (
    !invoice.parties.customerName ||
    invoice.parties.customerName.trim() === ''
  ) {
    throw new Error(
      'Invoice cannot be issued: parties.customerName is missing or empty',
    )
  }

  if (!invoice.lineItems || invoice.lineItems.length === 0) {
    throw new Error(
      'Invoice cannot be issued: lineItems must contain at least one entry',
    )
  }

  for (const item of invoice.lineItems) {
    if (!item.label || item.label.trim() === '') {
      throw new Error(
        `Invoice cannot be issued: lineItem "${item.id}" has no label`,
      )
    }
  }

  // Block 7.1B4 — Korrekturbelege (Storno-Rechnung / Gutschrift) tragen
  // negierte Summen. Engine-Baseline lässt das zu, sofern der Δ-Betrag nicht
  // Null ist; die fachliche Konsistenz (Vorzeichen, Summe vs. Original)
  // prüft `validateInvoiceCorrectionContext` im Workflow.
  if (invoice.kind === 'cancellation' || invoice.kind === 'credit_note') {
    if (invoice.amounts.grossAmount === 0) {
      throw new Error(
        'Invoice cannot be issued: correction amounts.grossAmount must be non-zero',
      )
    }
  } else if (invoice.amounts.grossAmount <= 0) {
    throw new Error(
      'Invoice cannot be issued: amounts.grossAmount must be greater than 0',
    )
  }
}

/**
 * Block 7.1B4 — Validiert den fachlichen Kontext eines Korrekturbelegs
 * (Storno-Rechnung oder Gutschrift) gegen die Originalrechnung und alle
 * bereits existierenden Korrekturen. Wird vom `invoiceCorrectionWorkflow`
 * vor jedem Insert/Issue aufgerufen.
 *
 * Invarianten:
 *
 *   - `correction.kind` ∈ {'cancellation','credit_note'}.
 *   - `correction.originalInvoiceId` zeigt auf eine existierende `kind='invoice'`.
 *   - Originalrechnung ist `issued | sent | paid` (nicht draft, nicht cancelled).
 *   - `correction.correctionReason` ist nicht leer.
 *   - `correction.correctionAmountCents` ≠ 0 und exakt das Negativ des
 *     entsprechenden Original-Anteils:
 *       Storno  → −originalGrossCents (volle Stornierung)
 *       Gutschr → −x mit |x| ≤ verbleibender Forderung
 *   - Nur EINE offene Stornorechnung pro Originalrechnung.
 *   - Summe aller Gutschrift-Beträge (vorher + neu) darf den Original-
 *     Bruttobetrag nicht übersteigen.
 *   - Nach erfolgter Storno darf keine Gutschrift mehr folgen (Original ist
 *     buchhalterisch nichtig).
 */
export function validateInvoiceCorrectionContext(
  correction: Invoice,
  original: Invoice,
  existingCorrectionsForOriginal: Invoice[],
): void {
  if (correction.kind !== 'cancellation' && correction.kind !== 'credit_note') {
    throw new Error(
      `Invoice correction must have kind 'cancellation' or 'credit_note' (got "${correction.kind}").`,
    )
  }
  if (!correction.originalInvoiceId || correction.originalInvoiceId !== original.id) {
    throw new Error(
      'Invoice correction: originalInvoiceId does not match the supplied original invoice.',
    )
  }
  if (original.kind !== 'invoice') {
    throw new Error(
      'Invoice correction: cannot correct another correction document. Only original invoices may be corrected.',
    )
  }
  if (original.status === 'draft') {
    throw new Error(
      'Invoice correction: original invoice is still a draft and cannot be corrected. Issue or discard the draft instead.',
    )
  }
  if (original.status === 'cancelled') {
    throw new Error(
      'Invoice correction: original invoice is already cancelled.',
    )
  }
  if (
    !correction.correctionReason ||
    correction.correctionReason.trim() === ''
  ) {
    throw new Error('Invoice correction: correctionReason is required.')
  }
  if (
    typeof correction.correctionAmountCents !== 'number' ||
    correction.correctionAmountCents === 0
  ) {
    throw new Error('Invoice correction: correctionAmountCents must be non-zero.')
  }

  const originalGrossCents = Math.round(original.amounts.grossAmount * 100)

  // Bereits gemerkte Storno-/Gutschrift-Summen für dieses Original.
  const existingCancellation = existingCorrectionsForOriginal.find(
    (c) => c.kind === 'cancellation',
  )
  const sumExistingCreditCents = existingCorrectionsForOriginal
    .filter((c) => c.kind === 'credit_note')
    .reduce(
      (sum, c) =>
        sum + Math.abs(c.correctionAmountCents ?? 0),
      0,
    )

  if (existingCancellation) {
    throw new Error(
      'Invoice correction: original invoice already has a cancellation document; further corrections are not allowed.',
    )
  }

  if (correction.kind === 'cancellation') {
    if (correction.correctionAmountCents !== -originalGrossCents) {
      throw new Error(
        'Invoice correction: cancellation amount must equal the negated full gross of the original invoice.',
      )
    }
    if (sumExistingCreditCents > 0) {
      // Edge case: partial credit notes already issued. Cancellation is no longer
      // the right instrument — would double-refund. Block.
      throw new Error(
        'Invoice correction: cannot cancel an invoice that already has credit notes. Issue further credit notes instead.',
      )
    }
  }

  if (correction.kind === 'credit_note') {
    if (correction.correctionAmountCents >= 0) {
      throw new Error(
        'Invoice correction: credit_note correctionAmountCents must be negative (refund Δ).',
      )
    }
    const newCreditCents = Math.abs(correction.correctionAmountCents)
    if (sumExistingCreditCents + newCreditCents > originalGrossCents) {
      throw new Error(
        'Invoice correction: credit_note exceeds the remaining unrefunded amount on the original invoice.',
      )
    }
  }
}

/**
 * Block 7.1B3 — Vollständige §14-UStG-Hard-Gates. Wird vom Issue-Workflow
 * gerufen, NACHDEM Snapshot-Daten vom Snapshot-Builder in die Invoice
 * geschrieben wurden, aber BEVOR die Engine-Transition läuft.
 *
 * Set:
 *   - Provider-Snapshot komplett mit Geschäftsanschrift + (taxNumber || vatId).
 *   - Customer-Snapshot komplett mit Empfänger-Anschrift.
 *   - Service-Period gesetzt mit nicht-leerem Label.
 *   - LineItems alle mit category, vatRate, vatAmount, gross.
 *   - amounts > 0 und konsistent mit LineItem-Summen + TaxBreakdown.
 *   - taxBreakdown nicht leer.
 *   - Bei Kleinunternehmer: ausschliesslich 0 %-Sätze + §19-taxNote gesetzt.
 */
export function validateInvoiceSnapshotComplete(invoice: Invoice): void {
  // Baseline läuft auch hier — Doppel-Run schadet nicht und schützt Caller,
  // die `validateInvoiceSnapshotComplete` direkt benutzen.
  validateInvoiceIssuancePreconditions(invoice)

  // Provider-Snapshot
  const provider = invoice.providerSnapshot
  if (!provider) {
    throw new Error(
      'Invoice cannot be issued: provider snapshot is missing. ' +
        'Trage Steuer-/Bankprofil unter „Profil → Steuer & Bank" ein.',
    )
  }
  const providerHasTaxId =
    (provider.taxNumber && provider.taxNumber.trim() !== '') ||
    (provider.vatId && provider.vatId.trim() !== '')
  if (!providerHasTaxId) {
    throw new Error(
      'Invoice cannot be issued: provider snapshot lacks tax_number and vat_id.',
    )
  }
  if (
    !provider.businessAddress ||
    provider.businessAddress.trim() === '' ||
    !provider.businessAddress.includes(',')
  ) {
    throw new Error(
      'Invoice cannot be issued: provider snapshot businessAddress is incomplete.',
    )
  }

  // Customer-Snapshot
  const customer = invoice.customerSnapshot
  if (!customer) {
    throw new Error(
      'Invoice cannot be issued: customer billing snapshot is missing.',
    )
  }
  if (!customer.billingName || customer.billingName.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: customer billing name is missing.',
    )
  }
  if (
    !customer.billingAddressLine1 ||
    customer.billingAddressLine1.trim() === '' ||
    !customer.billingPostalCode ||
    customer.billingPostalCode.trim() === '' ||
    !customer.billingCity ||
    customer.billingCity.trim() === ''
  ) {
    throw new Error(
      'Invoice cannot be issued: customer billing address is incomplete (street, postal code, city required).',
    )
  }
  if (
    !customer.billingCountry ||
    customer.billingCountry.trim().length !== 2
  ) {
    throw new Error(
      'Invoice cannot be issued: customer billingCountry must be a 2-letter ISO code.',
    )
  }

  // Service-Period
  const period = invoice.servicePeriod
  if (!period || !period.label || period.label.trim() === '') {
    throw new Error(
      'Invoice cannot be issued: service period is missing.',
    )
  }

  // Line items §14-konform
  for (const item of invoice.lineItems) {
    if (typeof item.vatRate !== 'number') {
      throw new Error(
        `Invoice cannot be issued: lineItem "${item.id}" has no vatRate`,
      )
    }
    if (typeof item.vatAmount !== 'number') {
      throw new Error(
        `Invoice cannot be issued: lineItem "${item.id}" has no vatAmount`,
      )
    }
    if (typeof item.gross !== 'number') {
      throw new Error(
        `Invoice cannot be issued: lineItem "${item.id}" has no gross amount`,
      )
    }
  }

  // Tax breakdown
  const breakdown = invoice.taxBreakdown
  if (!breakdown || breakdown.length === 0) {
    throw new Error(
      'Invoice cannot be issued: taxBreakdown is empty (§14 (4) Nr. 7+8 UStG).',
    )
  }
  assertTaxConsistency(invoice.lineItems, invoice.amounts, breakdown)

  // Kleinunternehmer §19
  if (provider.isKleinunternehmer) {
    if (breakdown.some((entry) => entry.vatRate !== 0)) {
      throw new Error(
        'Invoice cannot be issued: Kleinunternehmer (§19 UStG) muss alle Sätze mit 0 % ausstellen.',
      )
    }
    if (!invoice.taxNote || invoice.taxNote.trim() === '') {
      throw new Error(
        'Invoice cannot be issued: Kleinunternehmer-Hinweis (§19 UStG) fehlt.',
      )
    }
  }
}
