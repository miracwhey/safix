import type { Invoice, InvoiceStatus, InvoiceLineItem } from './types'
import type { Job } from '../jobs/types'
import type { Payment } from '../payments/types'
import { formatEuro } from '../shared/formatters'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'

export function getInvoiceStatusLabel(status: InvoiceStatus): string {
  if (status === 'draft') return 'Entwurf'
  if (status === 'issued') return 'Ausgestellt'
  if (status === 'sent') return 'Versendet'
  if (status === 'paid') return 'Bezahlt'
  return 'Storniert'
}

/**
 * Block 7.1B4 — Belegart-spezifischer Status-Text. Korrekturbelege werden
 * unabhängig vom DB-Status mit ihrer Belegart benannt; Originalrechnungen,
 * für die ein Storno-Beleg existiert, werden via {@link getLogicalInvoiceStatusLabel}
 * gehandhabt (lebt im Workflow, nicht hier — Selector bleibt rein).
 */
export function getInvoiceKindLabel(invoice: Invoice): string {
  if (invoice.kind === 'cancellation') return 'Stornorechnung'
  if (invoice.kind === 'credit_note') return 'Gutschrift'
  return getInvoiceStatusLabel(invoice.status)
}

/**
 * Block 7.1B4 — Filter, der Korrekturbelege aus den Listen „offene" und
 * „bezahlte" Originalrechnungen ausschließt. Korrekturbelege haben eigene
 * Sektionen / Anzeige-Pfade.
 */
function isPrimaryInvoice(invoice: Invoice): boolean {
  return (invoice.kind ?? 'invoice') === 'invoice'
}

/**
 * Block 7.1B5 — Originalrechnungen einer Liste (alles ohne kind=cancellation
 * | credit_note). Gegenstück zu {@link getCorrectionInvoices}; gemeinsam
 * decken sie die Gesamtmenge ab.
 */
export function getPrimaryInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.filter(isPrimaryInvoice)
}

/**
 * Formats a euro amount for invoice display.
 * Delegates to the canonical shared formatter for consistency.
 */
export function formatInvoiceEuro(amount: number): string {
  return formatEuro(amount)
}

export function isInvoiceOpen(invoice: Invoice): boolean {
  return invoice.status !== 'paid' && invoice.status !== 'cancelled'
}

export function getOpenInvoices(invoices: Invoice[]): Invoice[] {
  // Korrekturbelege erscheinen nicht in der Liste „offene Rechnungen" — sie
  // sind ihre eigene fachliche Klasse (Audit-Belege).
  return invoices.filter((inv) => isPrimaryInvoice(inv) && isInvoiceOpen(inv))
}

export function getPaidInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.filter(
    (invoice) => isPrimaryInvoice(invoice) && invoice.status === 'paid',
  )
}

/**
 * Block 7.1B4 — Liste aller Korrekturbelege (Storno-Rechnung + Gutschrift).
 * Sortierung nach `issuedAt` absteigend, damit der jüngste Beleg zuerst
 * erscheint. Filter wird in der UI für die separate Korrektur-Sektion genutzt.
 */
export function getCorrectionInvoices(invoices: Invoice[]): Invoice[] {
  return [...invoices]
    .filter((inv) => inv.kind === 'cancellation' || inv.kind === 'credit_note')
    .sort((a, b) => b.issuedAt - a.issuedAt)
}

/**
 * Block 7.1B4 — Korrekturbelege, die zu einer bestimmten Originalrechnung
 * gehören. Wird vom IssueInvoice-Sheet/Status-Adornment genutzt.
 */
export function getCorrectionsForInvoice(
  invoices: Invoice[],
  originalInvoiceId: string,
): Invoice[] {
  return invoices.filter(
    (inv) =>
      (inv.kind === 'cancellation' || inv.kind === 'credit_note') &&
      inv.originalInvoiceId === originalInvoiceId,
  )
}

/**
 * Block 7.1B4 — Originalrechnung wird durch eine bestehende Stornorechnung
 * buchhalterisch nichtig. UI-Schichten zeigen den Beleg dann als
 * „storniert durch X" — der DB-Status der Originalrechnung wird NICHT
 * verändert (Engine-Invariante `paid:[]` bleibt erhalten).
 */
export function isInvoiceLogicallyCancelled(
  invoice: Invoice,
  invoices: Invoice[],
): boolean {
  if (invoice.kind !== 'invoice') return false
  return invoices.some(
    (other) =>
      other.kind === 'cancellation' && other.originalInvoiceId === invoice.id,
  )
}

// ── Job–Invoice gap detection ────────────────────────────────────────────────

/** Returns true when a job *should* have an invoice but none exists yet. */
export function isJobWithoutInvoice(
  job: Job,
  payment: Payment | undefined,
  getInvoiceByJobId: (jobId: string) => Invoice | undefined
): boolean {
  // Use canonical payment state when available, fall back to job mirror only
  // when no payment entity exists (pre-creation).
  const paymentState = payment?.state ?? job.paymentState
  const invoiceRelevant =
    job.status === 'in_progress' ||
    job.status === 'scheduled' ||
    job.status === 'booked' ||
    job.status === 'waiting_payment' ||
    job.status === 'completed' ||
    paymentState === 'release_pending' ||
    paymentState === 'released'
  return invoiceRelevant && !getInvoiceByJobId(job.id)
}

// ── Customer Invoice Payment Surface ──────────────────────────────────────────

export type CustomerInvoicePaymentStatus =
  | 'pending'          // payment not yet due / still in deposit phase
  | 'awaiting_release' // work done, customer should release
  | 'released'         // payment released
  | 'disputed'         // under dispute
  | 'refunded'         // refunded

export type CustomerInvoiceViewModel = {
  invoiceNumber: string
  jobTitle: string
  craftsmanName: string
  lineItems: Array<{ id: string; label: string; quantity: number; unitPrice: number; total: number }>
  formattedNet: string
  formattedTax: string
  formattedTotal: string
  totalAmount: number
  paymentStatus: CustomerInvoicePaymentStatus
  paymentStatusLabel: string
  canReleasePayment: boolean
}

export function deriveCustomerInvoiceView(
  job: Job,
  payment?: Payment,
  invoice?: Invoice
): CustomerInvoiceViewModel | null {
  // Only show after work has been completed
  if (!job.workCompletedAt) return null

  const invoiceNumber = invoice?.invoiceNumber ?? ''
  const jobTitle = job.title
  const craftsmanName = invoice?.parties.issuerName ?? ''

  const invoiceLineItems: InvoiceLineItem[] = invoice?.lineItems ?? []

  const netAmount = invoice?.amounts.netAmount ?? 0
  const taxAmount = invoice?.amounts.taxAmount ?? 0
  const grossAmount = invoice?.amounts.grossAmount ?? 0

  // Fall back to canonical resolver when no invoice amounts
  const hasInvoiceAmounts = !!invoice
  const canonicalFallback = hasInvoiceAmounts ? '' : resolveCanonicalAmount(job.id).formatted
  const formattedNet = hasInvoiceAmounts
    ? formatInvoiceEuro(netAmount)
    : canonicalFallback
  const formattedTax = hasInvoiceAmounts
    ? formatInvoiceEuro(taxAmount)
    : '–'
  const formattedTotal = hasInvoiceAmounts
    ? formatInvoiceEuro(grossAmount)
    : canonicalFallback

  const totalAmount = hasInvoiceAmounts ? grossAmount : 0

  // Determine payment status from canonical payment state when available,
  // falling back to job-level fields for backward compatibility.
  let paymentStatus: CustomerInvoicePaymentStatus
  let paymentStatusLabel: string

  const canonicalState = payment?.state

  if (canonicalState === 'released' || (!canonicalState && job.paymentReleasedAt)) {
    paymentStatus = 'released'
    paymentStatusLabel = 'Zahlung erfolgt'
  } else if (canonicalState === 'disputed') {
    paymentStatus = 'disputed'
    paymentStatusLabel = 'Zahlung eingefroren'
  } else if (canonicalState === 'refunded') {
    paymentStatus = 'refunded'
    paymentStatusLabel = 'Betrag erstattet'
  } else if (
    !canonicalState &&
    (job.disputeStatus === 'open' ||
      job.disputeStatus === 'under_review' ||
      job.disputeStatus === 'customer_waiting' ||
      job.disputeStatus === 'provider_waiting')
  ) {
    // Fallback: no canonical payment available, use job-level dispute status
    paymentStatus = 'disputed'
    paymentStatusLabel = 'Zahlung eingefroren'
  } else {
    // workCompletedAt is guaranteed truthy here (checked at the top)
    paymentStatus = 'awaiting_release'
    paymentStatusLabel = 'Bestätigung ausstehend'
  }

  // Can release: work done, canonical payment not in terminal/blocked state
  const isBlocked = canonicalState === 'released' || canonicalState === 'refunded' || canonicalState === 'disputed'
  const canReleasePayment = canonicalState
    ? !!job.workCompletedAt && !isBlocked
    : !!job.workCompletedAt &&
      !job.paymentReleasedAt &&
      job.disputeStatus !== 'open' &&
      job.disputeStatus !== 'under_review' &&
      job.disputeStatus !== 'customer_waiting' &&
      job.disputeStatus !== 'provider_waiting'

  return {
    invoiceNumber,
    jobTitle,
    craftsmanName,
    lineItems: invoiceLineItems,
    formattedNet,
    formattedTax,
    formattedTotal,
    totalAmount,
    paymentStatus,
    paymentStatusLabel,
    canReleasePayment,
  }
}
