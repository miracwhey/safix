/**
 * Quote-Based Payment Gating — Domain Selectors
 *
 * These pure selectors derive payment readiness, due amounts, and gating
 * reasons from an accepted quote (Offer).  They enforce the rule that
 * payment readiness ONLY exists when a quote has been accepted.
 *
 * Rules:
 *   - pending / declined / expired / superseded / cancelled → no payment readiness
 *   - accepted → payment readiness depends on documentType policy
 *   - the due amount must come from the accepted quote's price, never arbitrary values
 *
 * PAKET 1 — documentType is the primary gate:
 *   `documentType` (via commercialDocumentPolicy) is the leading check.
 *   `offerMode` is consulted only as a legacy fallback for pre-Paket-1 offers
 *   that were persisted without a `documentType` field.
 */

import type { Offer, OfferStatus } from './types'
import { formatEuro } from '../shared/formatters'
import {
  documentTypeAllowsPayment,
  resolveEffectiveDocumentType,
} from './commercialDocumentPolicy'
import { calculateTrancheAmounts } from '../payments/escrow'

// ── Helpers ──────────────────────────────────────────────────────────────────

// DEPOSIT_PERCENT exposed only for display labels (e.g. "25 % Arbeitsbeginn").
// Amount calculations delegate to calculateTrancheAmounts — single source of truth.
const DEPOSIT_PERCENT = 25

function parseOfferPrice(raw: string | number | undefined | null): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') {
    return isFinite(raw) && raw > 0 ? raw : null
  }
  if (!raw.trim()) return null
  const firstPart = raw.split(/[–-]/)[0]
  const cleaned = firstPart
    .replace(/€/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/\s/g, '')
    .trim()
  const n = parseFloat(cleaned)
  return isNaN(n) || n <= 0 ? null : n
}

// ── Payment-eligible statuses ─────────────────────────────────────────────────

const PAYMENT_ELIGIBLE_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  'accepted',
])

// ── Public types ──────────────────────────────────────────────────────────────

export type PaymentBasis = {
  offerId: string
  offerPrice: string
  totalAmount: number | null
  totalAmountFormatted: string | null
  depositAmount: number | null
  depositAmountFormatted: string | null
  finalAmount: number | null
  finalAmountFormatted: string | null
  depositPercent: number
  changeOrderAdjustment: number | null
  acceptedAt: number
  createdJobId: string | null
}

export type PaymentGatingReason = {
  ready: boolean
  code:
    | 'accepted'
    | 'pending'
    | 'declined'
    | 'expired'
    | 'superseded'
    | 'cancelled'
    | 'draft'
    | 'estimate'
    | 'no_offer'
    | 'non_binding_document_type'
  explanation: string
}

// ── Core gating selectors ─────────────────────────────────────────────────────

/**
 * Returns true when the quote is in a state that allows payment readiness.
 *
 * PRIMARY check (Paket 1): uses `documentType` via commercialDocumentPolicy.
 * LEGACY fallback: uses `offerMode` for pre-Paket-1 offers without documentType.
 *
 * Only accepted binding offers unlock payment. Estimate, diagnosis, and any
 * document type with `allowsPaymentGating: false` always return false.
 */
export function isQuotePaymentReady(offer: Offer | null | undefined): boolean {
  if (!offer) return false

  // Primary check: documentType (Paket 1 — leading typing)
  if (offer.documentType != null) {
    return (
      documentTypeAllowsPayment(offer.documentType) &&
      PAYMENT_ELIGIBLE_STATUSES.has(offer.status)
    )
  }

  // Legacy fallback: offerMode for pre-Paket-1 offers without documentType.
  if ((offer.offerMode ?? 'binding') === 'estimate') return false

  return PAYMENT_ELIGIBLE_STATUSES.has(offer.status)
}

/**
 * Returns a structured reason explaining why payment is or isn't available.
 */
export function getQuotePaymentGatingReason(
  offer: Offer | null | undefined
): PaymentGatingReason {
  if (!offer) {
    return {
      ready: false,
      code: 'no_offer',
      explanation: 'Kein Angebot vorhanden. Zahlung nicht möglich.',
    }
  }

  // Non-binding documentType check (Paket 1 — primary)
  if (offer.documentType != null && !documentTypeAllowsPayment(offer.documentType)) {
    return {
      ready: false,
      code: 'non_binding_document_type',
      explanation:
        offer.documentType === 'diagnosis'
          ? 'Diagnose-Dokument — kein standard Zahlungskorridor. Eigener Diagnose-Pfad erforderlich.'
          : 'Unverbindliche Schätzung — keine Zahlungsverpflichtung. Zahlungen werden direkt vereinbart.',
    }
  }

  // Legacy fallback: offerMode check for pre-Paket-1 offers
  if (offer.documentType == null && offer.offerMode === 'estimate') {
    return {
      ready: false,
      code: 'estimate',
      explanation:
        'Unverbindliche Schätzung — keine Zahlungsverpflichtung. Zahlungen werden direkt vereinbart.',
    }
  }

  if (offer.status === 'accepted') {
    return {
      ready: true,
      code: 'accepted',
      explanation:
        'Angebot angenommen — der vollständige Betrag wird vorab über Stripe abgesichert. Freigabe erfolgt nach Leistungsfortschritt.',
    }
  }

  if (offer.status === 'pending') {
    return {
      ready: false,
      code: 'pending',
      explanation:
        'Angebot noch offen — Zahlung erst nach Annahme durch den Kunden möglich.',
    }
  }

  if (offer.status === 'declined') {
    return {
      ready: false,
      code: 'declined',
      explanation: 'Angebot abgelehnt — keine Zahlungsbasis vorhanden.',
    }
  }

  const explanations: Record<string, string> = {
    expired: 'Angebot abgelaufen — keine aktive Zahlungsbasis.',
    superseded: 'Angebot ersetzt — keine aktive Zahlungsbasis.',
    cancelled: 'Angebot storniert — keine aktive Zahlungsbasis.',
    draft: 'Angebotsentwurf — Zahlung erst nach Versand und Annahme möglich.',
  }

  return {
    ready: false,
    code: offer.status as PaymentGatingReason['code'],
    explanation:
      explanations[offer.status] ?? 'Keine aktive Zahlungsbasis vorhanden.',
  }
}

/**
 * Derives the payment basis from an accepted quote.
 * Returns null when the quote is not accepted (payment is gated).
 */
export function deriveQuotePaymentBasis(
  offer: Offer | null | undefined
): PaymentBasis | null {
  if (!offer) return null
  if (!isQuotePaymentReady(offer)) return null

  const totalAmount = parseOfferPrice(offer.price)

  let depositAmount: number | null = null
  let depositAmountFormatted: string | null = null
  let finalAmount: number | null = null
  let finalAmountFormatted: string | null = null

  if (totalAmount !== null) {
    const tranches = calculateTrancheAmounts(totalAmount)
    depositAmount = tranches.depositAmount
    finalAmount = tranches.finalAmount
    depositAmountFormatted = formatEuro(depositAmount)
    finalAmountFormatted = formatEuro(finalAmount)
  }

  return {
    offerId: offer.id,
    offerPrice: offer.price,
    totalAmount,
    totalAmountFormatted: totalAmount !== null ? formatEuro(totalAmount) : null,
    depositAmount,
    depositAmountFormatted,
    finalAmount,
    finalAmountFormatted,
    depositPercent: DEPOSIT_PERCENT,
    changeOrderAdjustment: null,
    acceptedAt: offer.acceptedAt!,
    createdJobId: offer.createdJobId ?? null,
  }
}

// ── Convenience helpers ───────────────────────────────────────────────────────

/**
 * Returns true if this offer is a binding offer (per documentType or legacy offerMode).
 */
export function isBindingOffer(offer: Offer | null | undefined): boolean {
  if (!offer) return false
  const effectiveType = resolveEffectiveDocumentType(offer.documentType, offer.offerMode)
  return effectiveType === 'binding_offer'
}
