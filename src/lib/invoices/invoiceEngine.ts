import type { Job } from '../jobs'
import type { Offer } from '../offers/types'
import type { Invoice, InvoiceLineItem, InvoiceStatus } from './types'
import { validateInvoiceIssuancePreconditions } from './invoiceValidation'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parses a human-readable Euro string (e.g. "1.234,56 €") to a float.
 * Returns 0 if the string is blank or unparseable — callers must check the
 * result and reject 0 explicitly; this function does not throw.
 */
function parseEuroAmount(value: string): number {
  const normalized = value
    .replace(/\./g, '')
    .replace(',', '.')
    .replace('€', '')
    .trim()

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Derives invoice amounts from an Offer.
 *
 * Offer amounts are stored in minor units (cents). This function converts
 * them to euros and computes net/tax from the gross using either:
 *   1. offer.netTotal (if present) — most accurate
 *   2. offer.vatRate — applies standard VAT math
 *   3. default 19% VAT rate — last resort
 */
function buildAmountsFromOffer(
  offer: Offer
): { grossAmount: number; netAmount: number; taxAmount: number } {
  // offer.grossTotal is validated > 0 before this is called
  const grossAmount = Number((offer.grossTotal! / 100).toFixed(2))

  if (offer.netTotal && offer.netTotal > 0) {
    const netAmount = Number((offer.netTotal / 100).toFixed(2))
    const taxAmount = Number((grossAmount - netAmount).toFixed(2))
    return { grossAmount, netAmount, taxAmount }
  }

  const vatRate = offer.vatRate ?? 19
  const netAmount = Number((grossAmount / (1 + vatRate / 100)).toFixed(2))
  const taxAmount = Number((grossAmount - netAmount).toFixed(2))
  return { grossAmount, netAmount, taxAmount }
}

/**
 * Builds Invoice line items from an Offer.
 *
 * Priority:
 *   1. offer.lineItems (structured, authoritative) → convert each QuoteLineItem
 *   2. No structured line items → single summary item using offer description or job title
 *
 * QuoteLineItem.netAmount is in minor units (cents) — converted to euros.
 */
function buildLineItemsFromOffer(
  job: Job,
  offer: Offer,
  netAmount: number
): InvoiceLineItem[] {
  if (offer.lineItems && offer.lineItems.length > 0) {
    return offer.lineItems.map((qli) => ({
      id: `li_${qli.id}`,
      label: qli.label,
      quantity: qli.quantity,
      unitPrice: Number((qli.netAmount / 100).toFixed(2)),
      total: Number(((qli.netAmount * qli.quantity) / 100).toFixed(2)),
    }))
  }

  // Offer has no structured line items — use a single summary item.
  // Label preference: scopeSummary → description → job title → generic fallback.
  const label =
    offer.scopeSummary?.trim() ||
    offer.description?.trim() ||
    job.title?.trim() ||
    'Handwerksleistung'

  return [
    {
      id: `li_${job.id}`,
      label,
      quantity: 1,
      unitPrice: netAmount,
      total: netAmount,
    },
  ]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates a new draft Invoice for the given Job.
 *
 * Commercial source of truth (priority order):
 *   1. Offer (when provided) — authoritative. Amounts and line items come
 *      exclusively from the Offer. job.amount is ignored if an Offer is present.
 *   2. job.amount — fallback only when no Offer is available.
 *
 * Throws if:
 *   - An Offer is provided but carries no valid grossTotal (> 0 cents)
 *   - No Offer is provided and job.amount is unparseable or resolves to <= 0
 *
 * The caller (ensureInvoiceForJob in invoiceService) is responsible for
 * loading the Offer and passing it here. If job.sourceOfferId is set but
 * the Offer cannot be loaded, the service throws before reaching this function.
 *
 * Invoice numbers are empty ('') at creation — assigned by the repository
 * at the draft → issued transition.
 *
 * Issuer identity (issuerName, issuerAddress) must be supplied by the caller
 * via the `issuerData` parameter. When absent, placeholder strings are used
 * and issuance will be blocked by validateInvoiceIssuancePreconditions until
 * real data is provided. The placeholder contract ensures drafts always carry
 * syntactically valid strings while being semantically invalid for issuance.
 */
export function createInvoiceFromJob(
  job: Job,
  offer?: Offer,
  issuerData?: { issuerName: string; issuerAddress: string }
): Invoice {
  const now = new Date()
  let amounts: { grossAmount: number; netAmount: number; taxAmount: number }
  let lineItems: InvoiceLineItem[]

  if (offer) {
    // ── Offer path (authoritative) ──────────────────────────────────────────
    if (!offer.grossTotal || offer.grossTotal <= 0) {
      throw new Error(
        `Invoice cannot be created: offer "${offer.id}" has no valid grossTotal. ` +
        `Offer is the authoritative commercial source but carries no usable amount.`
      )
    }
    amounts = buildAmountsFromOffer(offer)
    lineItems = buildLineItemsFromOffer(job, offer, amounts.netAmount)
  } else {
    // ── Fallback path (canonical resolver → job.amount last resort) ─────────
    const canonical = resolveCanonicalAmount(job.id)
    const grossAmount = canonical.amount ?? parseEuroAmount(job.amount)
    if (grossAmount <= 0) {
      throw new Error(
        `Invoice cannot be created: job "${job.id}" has no resolvable amount ` +
        `(canonical source: ${canonical.source}, job.amount: "${job.amount}"). ` +
        `Provide a structured Offer or ensure an escrow plan exists.`
      )
    }
    const netAmount = Number((grossAmount / 1.19).toFixed(2))
    const taxAmount = Number((grossAmount - netAmount).toFixed(2))
    amounts = { grossAmount, netAmount, taxAmount }
    lineItems = [
      {
        id: `li_${job.id}`,
        label: job.title || 'Handwerksleistung',
        quantity: 1,
        unitPrice: netAmount,
        total: netAmount,
      },
    ]
  }

  return {
    id: job.id,
    jobId: job.id,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: issuerData?.issuerName ?? 'SaFix Partnerbetrieb',
      issuerAddress: issuerData?.issuerAddress ?? 'Handwerkerstraße 12, 80331 München',
      customerName: job.customer,
    },
    lineItems,
    amounts,
    issuedAt: 0,
    issuedAtLabel: 'Noch nicht ausgestellt',
    dueAtLabel: 'Noch nicht fällig',
    sentAt: 0,
    // Block 7.1B3 — §14-Snapshot wird beim draft → issued Übergang vom
    // Snapshot-Builder befüllt. In draft sind alle Snapshot-Felder leer.
    servicePeriod: null,
    taxBreakdown: null,
    taxNote: null,
    providerSnapshot: null,
    customerSnapshot: null,
    sourceOfferId: offer?.id ?? null,
    sourceChangeOrderIds: [],
    sourceSupplementaryPaymentIds: [],
    // Block 7.1B4 — Originalrechnung. Korrekturbelege werden ausschließlich
    // über den `invoiceCorrectionWorkflow` erzeugt und tragen dort `kind`,
    // `originalInvoiceId`, `correctionReason` und `correctionAmountCents`.
    kind: 'invoice',
    originalInvoiceId: null,
    correctionReason: null,
    correctionAmountCents: null,
    originalInvoiceNumber: null,
    originalInvoiceIssuedAtLabel: null,
    refundEventId: null,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  }
}

/**
 * Invoice State Machine
 *
 * Allowed transitions:
 *   draft      → issued | cancelled
 *   issued     → sent | paid | cancelled
 *   sent       → paid | cancelled
 *   paid       → (terminal — no further transitions)
 *   cancelled  → (terminal — no further transitions)
 *
 * All other transitions throw. Reversions (e.g. paid → issued) are
 * never allowed. A cancelled invoice cannot be reactivated.
 *
 * Precondition validation:
 *   draft → issued validates all business preconditions via
 *   validateInvoiceIssuancePreconditions(). The transition is blocked if
 *   any required field is missing or invalid.
 *
 * Timestamp assignment:
 *   issuedAt — set when transitioning to 'issued'
 *   sentAt   — set when transitioning to 'sent'; only via explicit craftsman
 *              action (markInvoiceSentWorkflow). Payment sync does not trigger
 *              this transition on draft invoices — see syncInvoiceWithPayment
 *              in invoiceService.ts for the hard draft guard.
 *
 * Invoice number assignment:
 *   The engine does NOT assign invoice numbers. That responsibility belongs
 *   to the repository layer:
 *   - InMemoryInvoiceRepository: uses a per-instance sequential counter.
 *   - SupabaseInvoiceRepository: relies on a DB trigger that fires atomically
 *     on the draft → issued UPDATE. The repository re-reads the number from
 *     the DB after a successful issued transition.
 */
export function transitionInvoiceStatus(
  invoice: Invoice,
  nextStatus: InvoiceStatus
): Invoice {
  const allowed: Record<InvoiceStatus, InvoiceStatus[]> = {
    draft: ['issued', 'cancelled'],
    issued: ['sent', 'cancelled', 'paid'],
    sent: ['paid', 'cancelled'],
    paid: [],
    cancelled: [],
  }

  if (!allowed[invoice.status].includes(nextStatus)) {
    throw new Error(
      `Illegal invoice transition: ${invoice.status} → ${nextStatus}`
    )
  }

  if (invoice.status === 'draft' && nextStatus === 'issued') {
    validateInvoiceIssuancePreconditions(invoice)
  }

  const now = Date.now()

  return {
    ...invoice,
    status: nextStatus,
    issuedAt: nextStatus === 'issued' ? now : invoice.issuedAt,
    issuedAtLabel:
      nextStatus === 'issued' && invoice.issuedAtLabel === 'Noch nicht ausgestellt'
        ? 'Heute'
        : invoice.issuedAtLabel,
    dueAtLabel:
      nextStatus === 'paid'
        ? 'Bezahlt'
        : nextStatus === 'issued'
        ? 'In 7 Tagen'
        : invoice.dueAtLabel,
    sentAt: nextStatus === 'sent' ? now : invoice.sentAt,
    updatedAt: now,
  }
}
