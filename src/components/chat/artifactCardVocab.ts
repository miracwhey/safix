import type { OfferDocumentType } from '../../lib/offers/types'

/**
 * Shared artifact-card vocabulary — the ONE source of truth for status labels,
 * type labels, footer actions, brand theme, status tones, and money formatting
 * used by every stream artifact renderer (ChatArtifactCardCompact,
 * ProjectSendEventCard, QuoteSendEventCard, ThreadArtifactFundingCard) via the
 * shared `ArtifactCardShell`.
 *
 * Pure data + helpers (no JSX) so the component file can stay component-only
 * (react-refresh/only-export-components).
 *
 * NEVER add "Treuhand/Escrow" wording here (ZAG) — trust copy is "Gesichert" /
 * "über Stripe abgesichert" and lives on detail surfaces.
 */

export type ArtifactIconKey = 'Project' | 'OfferPayment' | 'FundingStep' | 'ChangeOrder' | 'Invoice'

export type StatusTone = 'pending' | 'accepted' | 'declined' | 'active' | 'expired'

export interface ArtifactCardView {
  iconKey: ArtifactIconKey
  /** Brand-tinted uppercase type label (PROJEKT / VERBINDLICHES ANGEBOT / ZAHLUNG / NACHTRAG). */
  typeLabel: string
  /** The prominent line: a title (Projekt/Angebot) or a Betrag (Zahlung/Nachtrag). */
  prominent: string
  prominentKind: 'title' | 'amount'
  /** Negative Betrag (Minderkosten) → rose. Only meaningful for prominentKind 'amount'. */
  amountNegative?: boolean
  /** Optional context line under the prominent line. */
  subtitle?: string
  statusLabel: string
  statusTone: StatusTone
}

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200/70',
  accepted: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70',
  declined: 'bg-rose-50 text-rose-700 ring-rose-200/60',
  active: 'bg-sky-50 text-sky-700 ring-sky-200/60',
  expired: 'bg-slate-100 text-slate-500 ring-slate-200/60',
}

/** Map a raw lifecycle status (any domain) → a shared visual tone. */
export function tone(status: string | undefined): StatusTone {
  switch (status) {
    case 'accepted':
    case 'funded':
    case 'completed':
      return 'accepted'
    case 'declined':
    case 'cancelled':
    case 'funding_failed':
      return 'declined'
    case 'in_progress':
    case 'scheduled':
    case 'funding_started':
    case 'funding_initiated':
    case 'review':
      return 'active'
    case 'expired':
    case 'superseded':
      return 'expired'
    default:
      // pending / sent / payment_due / diagnosis_payment_due → amber attention.
      return 'pending'
  }
}

export const TYPE_LABEL: Record<ArtifactIconKey, string> = {
  Project: 'Projekt',
  OfferPayment: 'Angebot',
  FundingStep: 'Zahlung',
  ChangeOrder: 'Nachtrag',
  Invoice: 'Rechnung',
}

/** Labelled footer action per artifact type. */
export const FOOTER_LABEL: Record<ArtifactIconKey, string> = {
  Project: 'Projekt öffnen',
  OfferPayment: 'Angebot ansehen',
  FundingStep: 'Zahlung ansehen',
  ChangeOrder: 'Nachtrag ansehen',
  Invoice: 'Rechnung öffnen',
}

export const OFFER_DOCTYPE_LABEL: Record<OfferDocumentType, string> = {
  binding_offer: 'Verbindliches Angebot',
  estimate: 'Schätzung',
  cost_estimate: 'Kostenvoranschlag',
  diagnosis: 'Diagnose',
}

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  request: 'Anfrage',
  accepted: 'Angenommen',
  scheduled: 'Geplant',
  in_progress: 'In Arbeit',
  review: 'Prüfung',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
}

export const CHANGE_ORDER_STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  pending: 'Liegt vor',
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
  cancelled: 'Zurückgezogen',
}

export const OFFER_STATUS_LABEL_BY_PHASE: Record<string, string> = {
  draft: 'Entwurf',
  pending: 'Liegt vor',
  sent: 'Liegt vor',
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
  cancelled: 'Storniert',
  expired: 'Abgelaufen',
  superseded: 'Ersetzt',
  payment_due: 'Zahlung fällig',
  diagnosis_payment_due: 'Zahlung fällig',
}

export const FUNDING_STATUS_LABEL: Record<string, string> = {
  created: 'Angefordert',
  sent: 'Angefordert',
  funding_started: 'In Bearbeitung',
  funding_initiated: 'In Bearbeitung',
  funded: 'Bestätigt',
  funding_failed: 'Fehlgeschlagen',
  cancelled: 'Storniert',
  expired: 'Abgelaufen',
}

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  issued: 'Gestellt',
  sent: 'Versendet',
  paid: 'Bezahlt',
  cancelled: 'Storniert',
}

/**
 * Invoice status → visual tone. The shared `tone()` helper mishandles invoice
 * statuses ('paid' / 'issued' / 'sent' fall through to amber), so the invoice
 * card uses this dedicated map instead: paid=emerald, cancelled=rose, sent=sky,
 * issued=amber, draft=slate.
 */
export const INVOICE_STATUS_TONE: Record<string, StatusTone> = {
  draft: 'expired',
  issued: 'pending',
  sent: 'active',
  paid: 'accepted',
  cancelled: 'declined',
}

export interface ArtifactTheme {
  label: string // type-label + footer-action text colour
  iconBg: string // icon tile background + ring
  icon: string // icon stroke colour
}

export const THEME: Record<ArtifactIconKey, ArtifactTheme> = {
  Project: { label: 'text-[#1D3866]', iconBg: 'bg-blue-50 ring-blue-100', icon: 'text-[#1D3866]' },
  OfferPayment: { label: 'text-violet-600', iconBg: 'bg-violet-50 ring-violet-100', icon: 'text-violet-600' },
  FundingStep: { label: 'text-amber-700', iconBg: 'bg-amber-50 ring-amber-100', icon: 'text-amber-600' },
  ChangeOrder: { label: 'text-orange-600', iconBg: 'bg-orange-50 ring-orange-100', icon: 'text-orange-600' },
  Invoice: { label: 'text-teal-700', iconBg: 'bg-teal-50 ring-teal-100', icon: 'text-teal-600' },
}

/** Format cents → de-DE EUR, optional leading sign for deltas. */
export function formatCents(cents: number, currency: string, signed: boolean): string {
  const sign = signed && cents >= 0 ? '+ ' : signed && cents < 0 ? '− ' : ''
  const value = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(cents) / 100)
  return sign + value
}
