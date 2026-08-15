import { useNavigate } from 'react-router-dom'
import {
  BarChart3,
  FileText,
  ClipboardList,
  Search,
  CreditCard,
  CheckCircle,
  XCircle,
  Clock,
  type LucideIcon,
} from 'lucide-react'
import { Icon } from '../primitives'
import type { MessageRole } from '../../lib/messages'
import type { OfferPaymentArtifact } from '../../lib/messages/threadArtifactTypes'
import type { OfferDocumentType } from '../../lib/offers/types'

type Props = {
  artifact: OfferPaymentArtifact
  role: MessageRole
  onUpdated?: () => void
}

// ── Type metadata ─────────────────────────────────────────────────────────────

type DocTypeMeta = {
  icon: LucideIcon
  badge: string
  pendingLabel: string
  acceptedLabel: string
  declinedLabel: string
  pendingCta: string
  waitingHint: string
  pendingRing: string
}

const DOC_TYPE_META: Record<OfferDocumentType, DocTypeMeta> = {
  estimate: {
    icon: BarChart3,
    badge: 'Schätzung',
    pendingLabel: 'Schätzung liegt vor',
    acceptedLabel: 'Schätzung bestätigt',
    declinedLabel: 'Schätzung abgelehnt',
    pendingCta: 'Schätzung ansehen →',
    waitingHint: 'Wartet auf Rückmeldung des Kunden',
    pendingRing: 'ring-violet-200/80',
  },
  cost_estimate: {
    icon: FileText,
    badge: 'Kostenvoranschlag',
    pendingLabel: 'Kostenvoranschlag liegt vor',
    acceptedLabel: 'Kostenvoranschlag bestätigt',
    declinedLabel: 'Kostenvoranschlag abgelehnt',
    pendingCta: 'Kostenvoranschlag prüfen →',
    waitingHint: 'Wartet auf Rückmeldung des Kunden',
    pendingRing: 'ring-sky-200/80',
  },
  binding_offer: {
    icon: ClipboardList,
    badge: 'Verbindliches Angebot',
    pendingLabel: 'Verbindliches Angebot liegt vor',
    acceptedLabel: 'Verbindliches Angebot angenommen',
    declinedLabel: 'Verbindliches Angebot abgelehnt',
    pendingCta: 'Angebot prüfen →',
    waitingHint: 'Wartet auf Kundenentscheidung',
    pendingRing: 'ring-blue-200/80',
  },
  diagnosis: {
    icon: Search,
    badge: 'Diagnose-Einsatz',
    pendingLabel: 'Diagnose-Einsatz liegt vor',
    acceptedLabel: 'Diagnose-Einsatz freigegeben',
    declinedLabel: 'Diagnose-Einsatz abgelehnt',
    pendingCta: 'Diagnose-Einsatz ansehen →',
    waitingHint: 'Wartet auf Freigabe',
    pendingRing: 'ring-purple-200/80',
  },
}

// ── Validity helpers ──────────────────────────────────────────────────────────

function formatValidUntil(iso: string): string {
  const parts = iso.split('-')
  if (parts.length !== 3) return iso
  return `${parts[2]}.${parts[1]}.${parts[0]}`
}

function isExpiredDate(iso: string): boolean {
  const today = new Date().toISOString().slice(0, 10)
  return iso < today
}

/**
 * Renders an offer / payment lifecycle card from a canonical OfferPaymentArtifact.
 *
 * LAYER 1 — PERSISTENT STATUS SUMMARY.
 * Slim status block — NOT a full-size timeline card.
 * Shows document type, current state, version, validity and price at a glance.
 * Deeplinks to QuoteDetailScreen where accept/decline decisions are made.
 *
 * Type-aware (Paket 4b):
 *   binding_offer — "Angebot liegt vor" · blue ring · "Angebot prüfen →"
 *   estimate      — "Schätzung liegt vor" · violet ring · "Schätzung ansehen →"
 *   diagnosis     — "Diagnose liegt vor" · amber ring · "Diagnose ansehen →"
 *
 * Inline accept/decline CTAs have been removed from this card.
 * The offer decision belongs in QuoteDetailScreen, not in the chat thread.
 */
export default function ThreadArtifactOfferCard({ artifact, role }: Props) {
  const navigate = useNavigate()

  const { offer, snapshot, phase, paymentState, documentType } = artifact
  const meta = DOC_TYPE_META[documentType] ?? DOC_TYPE_META.binding_offer
  const isCustomer = role === 'customer'

  const isPending = offer ? offer.status === 'pending' : phase === 'sent'
  const isAccepted = offer ? offer.status === 'accepted' : phase === 'accepted'
  const isDeclined = offer ? offer.status === 'declined' : phase === 'declined'
  const isPaymentDue = phase === 'payment_due'
  const isDiagnosisPaymentDue = phase === 'diagnosis_payment_due'

  // Display data: prefer full entity, fall back to snapshot
  const price = offer?.price ?? snapshot?.price ?? ''
  const description = offer?.description ?? snapshot?.summary
  const timingNote = offer?.timingNote
  const version = offer?.version ?? snapshot?.version
  const validUntil = offer?.validUntil ?? snapshot?.validUntil

  // Status icon + label
  const StatusIcon: LucideIcon = isPaymentDue
    ? CreditCard
    : isDiagnosisPaymentDue
      ? CreditCard
      : isAccepted
        ? CheckCircle
        : isDeclined
          ? XCircle
          : meta.icon
  const statusIconColor = isPaymentDue
    ? 'text-amber-600'
    : isDiagnosisPaymentDue
      ? 'text-purple-600'
      : isAccepted
        ? 'text-emerald-600'
        : isDeclined
          ? 'text-slate-400'
          : 'text-slate-500'
  const statusLabel = isPaymentDue
    ? 'Zahlung fällig'
    : isDiagnosisPaymentDue
      ? 'Diagnose-Zahlung fällig'
      : isAccepted
        ? meta.acceptedLabel
        : isDeclined
          ? meta.declinedLabel
          : meta.pendingLabel

  const ringColor = isPaymentDue
    ? 'ring-amber-200/80'
    : isDiagnosisPaymentDue
      ? 'ring-purple-200/80'
      : isAccepted
        ? 'ring-emerald-200/80'
        : isDeclined
          ? 'ring-slate-200/70'
          : meta.pendingRing

  const offerId = offer?.id ?? snapshot?.offerId
  const detailPath = offerId
    ? isCustomer
      ? `/quotes/${offerId}`
      : `/craftsman/quotes/${offerId}`
    : null

  // Validity display
  const expired = validUntil ? isExpiredDate(validUntil) : false

  return (
    <div
      className={[
        'rounded-[12px] bg-white px-3 py-2 ring-1 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)]',
        ringColor,
      ].join(' ')}
    >
      {/* Primary row: icon · status · price */}
      <div className="flex items-center gap-2">
        <Icon icon={StatusIcon} size="sm" className={statusIconColor} />
        <span className="text-[12px] font-semibold text-slate-700">
          {statusLabel}
        </span>
        {price && (
          <span className="ml-auto text-[13px] font-bold text-slate-900">
            {price}
          </span>
        )}
      </div>

      {/* Meta row: type badge · version · validity */}
      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
          {meta.badge}
        </span>
        {version != null && version > 1 && (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
            v{version}
          </span>
        )}
        {validUntil && (
          expired ? (
            <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-semibold text-red-500 ring-1 ring-red-200/60">
              Abgelaufen
            </span>
          ) : (
            <span className="text-[9px] text-slate-400">
              Gültig bis {formatValidUntil(validUntil)}
            </span>
          )
        )}
      </div>

      {/* Secondary: compact description + timing on one line */}
      {(description || timingNote) && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
          {description && <span className="truncate">{description}</span>}
          {timingNote && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Icon icon={Clock} size="sm" /> {timingNote}
            </span>
          )}
        </div>
      )}

      {/* Detail CTA — navigates to QuoteDetailScreen (the canonical decision surface) */}
      {detailPath && (
        <button
          type="button"
          onClick={() => navigate(detailPath)}
          className="mt-1.5 text-[11px] font-medium text-blue-600 transition hover:text-blue-700"
          data-testid="quote-detail-link"
        >
          {isPending && isCustomer ? meta.pendingCta : 'Details anzeigen →'}
        </button>
      )}

      {isPending && !isCustomer && (
        <p className="mt-1 text-[10px] text-slate-400">
          {meta.waitingHint}
        </p>
      )}

      {isPaymentDue && isCustomer && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200/60">
          <Icon icon={CreditCard} size="sm" className="mt-px shrink-0" />
          <span>
            {paymentState === 'deposit_required'
              ? 'Zahlung erforderlich — der vollständige Betrag wird vorab gesichert.'
              : 'Zahlung ausstehend.'}
          </span>
        </div>
      )}

      {isPaymentDue && !isCustomer && (
        <p className="mt-1 text-[10px] text-amber-600">
          Zahlung ausstehend — Kunde wurde benachrichtigt
        </p>
      )}

      {isDiagnosisPaymentDue && isCustomer && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-purple-50 px-2.5 py-1.5 text-[11px] text-purple-800 ring-1 ring-purple-200/60">
          <Icon icon={CreditCard} size="sm" className="mt-px shrink-0" />
          <span>Diagnose-Zahlung ausstehend — bitte im Dokument abschließen.</span>
        </div>
      )}

      {isDiagnosisPaymentDue && !isCustomer && (
        <p className="mt-1 text-[10px] text-purple-600">
          Diagnose-Zahlung ausstehend — Kunde wurde benachrichtigt
        </p>
      )}
    </div>
  )
}
