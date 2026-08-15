/**
 * Block 7.1B4 — Invoice-Korrekturworkflow (Stornorechnung / Gutschrift)
 *
 * Liefert die zwei produktionsreifen Eintrittspunkte für den buchhalterischen
 * Korrekturpfad nach Refund/Dispute:
 *
 *   - `createCancellationInvoiceWorkflow` — Full Refund: Stornorechnung über
 *     den vollen Bruttobetrag der Originalrechnung.
 *   - `createCreditNoteWorkflow`          — Partial/Split Refund: Gutschrift
 *     über einen Teilbetrag.
 *
 * Architektur-Entscheidungen:
 *
 *   1. Originalrechnung wird NIE retroaktiv mutiert. Stattdessen wird ein
 *      neuer Beleg mit `kind = 'cancellation' | 'credit_note'` erzeugt, der
 *      die Originalrechnung über `originalInvoiceId` referenziert. UI-Schichten
 *      derivieren den „logisch storniert"-Status aus dieser Verknüpfung.
 *
 *   2. Stripe-/Escrow-Refund-Logik wird hier NICHT neu erfunden. Aufrufer
 *      übergeben einen optionalen `refundEventId` (z. B. `stripe_re_…` oder
 *      die Dispute-Resolution-ID) als Audit-Anker.
 *
 *   3. Snapshot-Daten (Provider/Customer/Tax-Note/Service-Period) werden eins
 *      zu eins aus dem Original übernommen, damit der Korrekturbeleg §14-konform
 *      ohne Nachladen externer Profile rendert.
 *
 *   4. Beträge werden für Stornorechnungen 1:1 negiert; für Gutschriften wird
 *      der Δ-Betrag gegen die Tax-Breakdown der Originalrechnung gerechnet
 *      (B4-Skopus: nur Originale mit einheitlichem USt-Satz; multi-rate
 *      Korrekturen sind explizit out-of-scope, dokumentiert in Open Gaps).
 *
 *   5. Belegnummer wird vom DB-Trigger atomar bei `draft → issued` aus den
 *      separaten Sequenzen `cancellation_invoice_seq` / `credit_note_seq`
 *      vergeben. Format: `FX-S-YYYY-NNNN` (Storno) bzw. `FX-G-YYYY-NNNN`
 *      (Gutschrift).
 */

import type {
  Invoice,
  InvoiceAmounts,
  InvoiceLineItem,
  InvoiceTaxBreakdownEntry,
} from '../invoices/types'
import { transitionInvoiceStatus } from '../invoices/invoiceEngine'
import { validateInvoiceCorrectionContext } from '../invoices/invoiceValidation'
import { getInvoiceRepository } from '../invoices/repository'
import { isInvoiceRepositoryHydrated } from '../invoices/invoiceStore'
import { ensureTimelineEvent } from '../timeline'
import { logWarning } from '../observability'
import { generateUUID } from '../shared/generateUUID'

// ── Public input contracts ───────────────────────────────────────────────────

export type CancellationInvoiceInput = {
  /** UUID der zu stornierenden Originalrechnung. */
  originalInvoiceId: string
  /**
   * Pflicht-Begründung des Storno (z. B. „Voller Refund nach Dispute-Refund-
   * Resolution", „Stripe charge.refunded - full refund").
   */
  reason: string
  /**
   * Optionaler Audit-Anker auf das auslösende Event (Stripe-Refund-ID,
   * Dispute-Resolution-ID …). Wird in `refund_event_id` persistiert.
   */
  refundEventId?: string
}

export type CreditNoteInput = {
  /** UUID der zu korrigierenden Originalrechnung. */
  originalInvoiceId: string
  /**
   * Refundierter Bruttobetrag in Cent (positiv übergeben). Muss
   *   0 < refundAmountCents < originalGrossCents
   * sein. Der Workflow speichert den Wert als negativen Δ.
   */
  refundAmountCents: number
  /** Pflicht-Begründung der Gutschrift. */
  reason: string
  /** Optionaler Audit-Anker (Stripe-Refund-ID, Dispute-Resolution-ID …). */
  refundEventId?: string
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const DRAFT_PLACEHOLDER_LABEL = 'Noch nicht ausgestellt'

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100
}

function existingCorrectionsFor(originalId: string): Invoice[] {
  return getInvoiceRepository()
    .getAll()
    .filter((i) => i.originalInvoiceId === originalId)
}

function loadOriginalOrThrow(originalInvoiceId: string): Invoice {
  const repo = getInvoiceRepository()
  const original = repo.getAll().find((inv) => inv.id === originalInvoiceId)
  if (!original) {
    throw new Error(
      `Invoice correction: original invoice "${originalInvoiceId}" not found.`,
    )
  }
  return original
}

function buildNegatedLineItems(original: Invoice, prefix: string): InvoiceLineItem[] {
  return original.lineItems.map((li) => ({
    ...li,
    id: `${prefix}_${li.id}`,
    label: `Storno: ${li.label}`,
    quantity: li.quantity,
    unitPrice: -li.unitPrice,
    total: -li.total,
    vatAmount: typeof li.vatAmount === 'number' ? -li.vatAmount : undefined,
    gross: typeof li.gross === 'number' ? -li.gross : undefined,
  }))
}

function buildNegatedAmounts(original: Invoice): InvoiceAmounts {
  return {
    netAmount: -original.amounts.netAmount,
    taxAmount: -original.amounts.taxAmount,
    grossAmount: -original.amounts.grossAmount,
  }
}

function buildNegatedTaxBreakdown(
  original: Invoice,
): InvoiceTaxBreakdownEntry[] | null {
  if (!original.taxBreakdown) return null
  return original.taxBreakdown.map((entry) => ({
    vatRate: entry.vatRate,
    netAmount: -entry.netAmount,
    taxAmount: -entry.taxAmount,
    grossAmount: -entry.grossAmount,
  }))
}

function buildCreditNoteLineItem(
  original: Invoice,
  refundCents: number,
): { lineItems: InvoiceLineItem[]; amounts: InvoiceAmounts; taxBreakdown: InvoiceTaxBreakdownEntry[] } {
  // B4-Skopus: nur Originale mit einheitlichem USt-Satz. Mehr-Rate-Gutschriften
  // wären eine eigene Komplexitätsklasse (anteilige Auflösung pro Steuerklasse)
  // und sind in den Open Gaps dokumentiert.
  if (!original.taxBreakdown || original.taxBreakdown.length === 0) {
    throw new Error(
      'Invoice correction: original invoice has no tax breakdown — cannot build credit note line items.',
    )
  }
  if (original.taxBreakdown.length > 1) {
    throw new Error(
      'Invoice correction: credit notes for invoices with multiple VAT rates are not supported in this version. Issue a full cancellation invoice instead.',
    )
  }

  const rate = original.taxBreakdown[0].vatRate
  const grossEur = -roundTo2(refundCents / 100)
  const netEur = roundTo2(grossEur / (1 + rate / 100))
  const taxEur = roundTo2(grossEur - netEur)

  const lineItem: InvoiceLineItem = {
    id: `cn_${original.id}`,
    label: `Gutschrift zur Rechnung ${original.invoiceNumber}`,
    quantity: 1,
    unitPrice: netEur,
    total: netEur,
    category: 'other',
    vatRate: rate,
    vatAmount: taxEur,
    gross: grossEur,
  }

  const amounts: InvoiceAmounts = {
    netAmount: netEur,
    taxAmount: taxEur,
    grossAmount: grossEur,
  }
  const taxBreakdown: InvoiceTaxBreakdownEntry[] = [
    {
      vatRate: rate,
      netAmount: netEur,
      taxAmount: taxEur,
      grossAmount: grossEur,
    },
  ]

  return { lineItems: [lineItem], amounts, taxBreakdown }
}

function buildCorrectionDraft(params: {
  original: Invoice
  kind: 'cancellation' | 'credit_note'
  reason: string
  refundEventId?: string
  lineItems: InvoiceLineItem[]
  amounts: InvoiceAmounts
  taxBreakdown: InvoiceTaxBreakdownEntry[] | null
  correctionAmountCents: number
}): Invoice {
  const {
    original,
    kind,
    reason,
    refundEventId,
    lineItems,
    amounts,
    taxBreakdown,
    correctionAmountCents,
  } = params
  const now = Date.now()
  return {
    id: generateUUID(),
    jobId: original.jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: { ...original.parties },
    lineItems,
    amounts,
    issuedAt: 0,
    issuedAtLabel: DRAFT_PLACEHOLDER_LABEL,
    dueAtLabel:
      kind === 'cancellation'
        ? 'Storno-Beleg'
        : 'Gutschrift',
    sentAt: 0,
    servicePeriod: original.servicePeriod
      ? { ...original.servicePeriod }
      : null,
    taxBreakdown,
    taxNote: original.taxNote,
    providerSnapshot: original.providerSnapshot
      ? { ...original.providerSnapshot }
      : null,
    customerSnapshot: original.customerSnapshot
      ? { ...original.customerSnapshot }
      : null,
    sourceOfferId: original.sourceOfferId,
    sourceChangeOrderIds: [...original.sourceChangeOrderIds],
    sourceSupplementaryPaymentIds: [...original.sourceSupplementaryPaymentIds],
    kind,
    originalInvoiceId: original.id,
    correctionReason: reason.trim(),
    correctionAmountCents,
    originalInvoiceNumber: original.invoiceNumber || null,
    originalInvoiceIssuedAtLabel: original.issuedAtLabel || null,
    refundEventId: refundEventId ?? null,
    createdAt: now,
    updatedAt: now,
  }
}

// ── Public workflows ─────────────────────────────────────────────────────────

/**
 * Erzeugt eine Stornorechnung (Full Refund) für die Originalrechnung.
 *
 * Idempotent: existiert bereits ein Storno für diese Originalrechnung, wird
 * der bestehende Beleg zurückgegeben.
 *
 * Wirft, wenn die Originalrechnung nicht existiert, draft/cancelled ist,
 * bereits Gutschriften trägt oder selbst ein Korrekturbeleg ist.
 */
export async function createCancellationInvoiceWorkflow(
  input: CancellationInvoiceInput,
): Promise<Invoice> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.cancellation.skipped_unhydrated', {
      originalInvoiceId: input.originalInvoiceId,
    })
    throw new Error(
      'Invoice repository not hydrated; cannot create cancellation invoice yet.',
    )
  }

  const repo = getInvoiceRepository()
  const original = loadOriginalOrThrow(input.originalInvoiceId)

  // Idempotency: ein vorhandener Storno für dasselbe Original wird unverändert
  // zurückgegeben. Doppelaufruf darf weder DB-State doppelt schreiben noch
  // einen weiteren Beleg erzeugen.
  const existing = existingCorrectionsFor(original.id).find(
    (c) => c.kind === 'cancellation',
  )
  if (existing) {
    logWarning('invoice.cancellation.already_exists', {
      originalInvoiceId: original.id,
      existingId: existing.id,
    })
    return existing
  }

  const correctionAmountCents = -Math.round(original.amounts.grossAmount * 100)

  const draft = buildCorrectionDraft({
    original,
    kind: 'cancellation',
    reason: input.reason,
    refundEventId: input.refundEventId,
    lineItems: buildNegatedLineItems(original, 's'),
    amounts: buildNegatedAmounts(original),
    taxBreakdown: buildNegatedTaxBreakdown(original),
    correctionAmountCents,
  })

  // Fachliche Pflichtprüfung gegen alle bestehenden Korrekturen.
  validateInvoiceCorrectionContext(
    draft,
    original,
    existingCorrectionsFor(original.id),
  )

  await repo.add(draft)
  await repo.update(draft.id, (inv) => transitionInvoiceStatus(inv, 'issued'))

  ensureTimelineEvent({ jobId: original.jobId, type: 'invoice_cancelled' })

  return repo.getAll().find((i) => i.id === draft.id) ?? draft
}

/**
 * Erzeugt eine Gutschrift (Partial/Split Refund) für die Originalrechnung.
 *
 * Wirft, wenn der Refundbetrag <= 0, > Restforderung oder die Originalrechnung
 * mehrere USt-Sätze hat (B4-Skopus).
 */
export async function createCreditNoteWorkflow(
  input: CreditNoteInput,
): Promise<Invoice> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.creditNote.skipped_unhydrated', {
      originalInvoiceId: input.originalInvoiceId,
    })
    throw new Error(
      'Invoice repository not hydrated; cannot create credit note yet.',
    )
  }

  if (
    !Number.isFinite(input.refundAmountCents) ||
    input.refundAmountCents <= 0 ||
    !Number.isInteger(input.refundAmountCents)
  ) {
    throw new Error(
      'Invoice correction: refundAmountCents must be a positive integer (cents).',
    )
  }

  const repo = getInvoiceRepository()
  const original = loadOriginalOrThrow(input.originalInvoiceId)

  const { lineItems, amounts, taxBreakdown } = buildCreditNoteLineItem(
    original,
    input.refundAmountCents,
  )

  const draft = buildCorrectionDraft({
    original,
    kind: 'credit_note',
    reason: input.reason,
    refundEventId: input.refundEventId,
    lineItems,
    amounts,
    taxBreakdown,
    correctionAmountCents: -input.refundAmountCents,
  })

  validateInvoiceCorrectionContext(
    draft,
    original,
    existingCorrectionsFor(original.id),
  )

  await repo.add(draft)
  await repo.update(draft.id, (inv) => transitionInvoiceStatus(inv, 'issued'))

  ensureTimelineEvent({
    jobId: original.jobId,
    type: 'invoice_credit_note_issued',
  })

  return repo.getAll().find((i) => i.id === draft.id) ?? draft
}

// ── Public derivations ───────────────────────────────────────────────────────

/**
 * Liefert den logisch abgeleiteten Status einer Originalrechnung. Originale
 * mit einer existierenden Stornorechnung gelten als „cancelled_by_correction"
 * — der DB-Status der Originalrechnung wird dabei NICHT verändert.
 *
 * UI-Schichten nutzen diese Ableitung, um in der Liste „Bezahlte Rechnungen"
 * die Statusbadge auf „Storniert durch X" zu setzen, ohne die Engine-
 * Invariante `paid:[]` zu verletzen.
 */
export type LogicalInvoiceStatus =
  | 'draft'
  | 'issued'
  | 'sent'
  | 'paid'
  | 'cancelled'
  | 'cancelled_by_correction'

export function getLogicalInvoiceStatus(
  invoice: Invoice,
  allInvoices: Invoice[],
): LogicalInvoiceStatus {
  if (invoice.kind !== 'invoice') return invoice.status
  const cancellationExists = allInvoices.some(
    (i) => i.kind === 'cancellation' && i.originalInvoiceId === invoice.id,
  )
  if (cancellationExists) return 'cancelled_by_correction'
  return invoice.status
}

