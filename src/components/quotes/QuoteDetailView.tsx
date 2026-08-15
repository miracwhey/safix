/**
 * QuoteDetailView — Grouped presentation of commercial documents.
 *
 * Type-aware (Paket 4c): renders diagnosis as its own product path,
 * not as a variant of binding_offer or estimate.
 *
 * Sections:
 *   1. Header — document type, status badge, version, timestamps
 *   2. Status Meaning — business-readable explanation per type + status
 *   3. Project Context — title, description, category, location
 *   4. Price Structure — gross/net/VAT, labor/material/other, line items
 *   5. Scope & Exclusions — included, excluded, assumptions
 *   6. Conditions — validity, payment terms, cancellation, type-specific hint
 *   7. Actions Area — type+status+role-aware CTAs and follow-path hints
 *   8. Notes — internal craftsman notes
 */

import { FileText, ClipboardList, CheckCircle2, XCircle, Clock, RefreshCw, Ban, Lock, CreditCard, AlertTriangle, Shield, TrendingUp, ExternalLink, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Icon } from '../primitives'
import Spinner from '../system/Spinner'
import DiagnosisPaymentSheet from '../payments/DiagnosisPaymentSheet'
import type { Offer, OfferStatus } from '../../lib/offers'
import {
  isQuotePaymentReady,
  deriveQuotePaymentBasis,
  getQuotePaymentGatingReason,
} from '../../lib/offers'
import {
  deriveEscrowPlanSummary,
  getEscrowPlanStatusLabel,
} from '../../lib/payments/escrow'
import type { EscrowTrancheKind } from '../../lib/payments/escrow'
import { formatCents as sharedFormatCents, formatOfferPrice } from '../../lib/shared/formatters'

function getTrancheKindLabel(kind: EscrowTrancheKind): string {
  switch (kind) {
    case 'deposit_release': return 'Arbeitsbeginn'
    case 'final_release': return 'Fertigstellung'
  }
}

type Props = {
  offer: Offer
  /** Whether the viewer is the customer (affects actions area). */
  isCustomer?: boolean
  /** Callback to accept a pending quote (customer only). */
  onAccept?: () => void
  /** Callback to decline a pending quote (customer only). */
  onDecline?: () => void
  /** Whether an accept/decline action is currently in progress. */
  busy?: boolean
  /** Error message to show in the actions area. */
  actionError?: string | null
  /**
   * Follow-up binding_offer created after this diagnosis (if any).
   * Passed when offer.documentType === 'diagnosis' and a follow-up exists.
   * Used to show reverse link: diagnosis → follow-up offer.
   */
  followUpOffer?: Offer
  /**
   * Diagnosis payment state — only relevant when offer.documentType === 'diagnosis'
   * and offer.status === 'accepted'. Used to show the in-app payment form.
   * 'pending' = payment due; 'completed' = already paid; null = no payment record yet.
   */
  diagnosisPaymentState?: 'pending' | 'completed' | null
}

// ── Status display ────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  draft:      { label: 'Entwurf',     color: 'bg-neutral/10 text-neutral',  icon: FileText },
  pending:    { label: 'Offen',       color: 'bg-brand/10 text-brand',      icon: ClipboardList },
  accepted:   { label: 'Angenommen',  color: 'bg-ok/10 text-ok',            icon: CheckCircle2 },
  declined:   { label: 'Abgelehnt',   color: 'bg-danger/10 text-danger',    icon: XCircle },
  expired:    { label: 'Abgelaufen',  color: 'bg-warn/10 text-warn',        icon: Clock },
  superseded: { label: 'Ersetzt',     color: 'bg-neutral/10 text-neutral',  icon: RefreshCw },
  cancelled:  { label: 'Storniert',   color: 'bg-neutral/10 text-neutral',  icon: Ban },
}

// ── Status meaning — default (binding_offer) ──────────────────────────────

const STATUS_MEANING: Record<OfferStatus, { banner: string; bannerColor: string }> = {
  draft: {
    banner: 'Dieses verbindliche Angebot ist ein Entwurf und wurde noch nicht an den Kunden gesendet.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
  pending: {
    banner: 'Dieses Angebot wurde gesendet und wartet auf die Entscheidung des Kunden.',
    bannerColor: 'bg-brand/5 text-brand ring-brand/20',
  },
  accepted: {
    banner: 'Dieses Angebot wurde angenommen und ist jetzt die verbindliche Auftragsgrundlage. Preise, Leistungsumfang und Konditionen gelten als vereinbart.',
    bannerColor: 'bg-ok/5 text-ok ring-ok/20',
  },
  declined: {
    banner: 'Dieses Angebot wurde vom Kunden abgelehnt. Es ist nicht mehr gültig.',
    bannerColor: 'bg-danger/5 text-danger ring-danger/20',
  },
  expired: {
    banner: 'Die Gültigkeitsdauer dieses Angebots ist abgelaufen. Es kann nicht mehr angenommen werden.',
    bannerColor: 'bg-warn/5 text-warn ring-warn/20',
  },
  superseded: {
    banner: 'Dieses Angebot wurde durch eine neuere Version ersetzt und ist nicht mehr gültig.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
  cancelled: {
    banner: 'Dieses Angebot wurde storniert und ist nicht mehr gültig.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
}

// ── Cost-estimate overrides ───────────────────────────────────────────────

const COST_ESTIMATE_STATUS_MEANING: Partial<Record<OfferStatus, { banner: string; bannerColor: string }>> = {
  draft: {
    banner: 'Dieser Kostenvoranschlag ist ein Entwurf und wurde noch nicht gesendet.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
  pending: {
    banner: 'Dieser Kostenvoranschlag wurde gesendet. Er ist kein verbindlicher Auftragsabschluss und löst keinen Zahlungskorridor aus.',
    bannerColor: 'bg-sky-50 text-sky-700 ring-sky-200/60',
  },
  accepted: {
    banner: 'Dieser Kostenvoranschlag wurde bestätigt. Kein Zahlungskorridor — für eine verbindliche Auftragserteilung ist ein Verbindliches Angebot erforderlich.',
    bannerColor: 'bg-ok/5 text-ok ring-ok/20',
  },
}

// ── Estimate-mode overrides ───────────────────────────────────────────────

const ESTIMATE_STATUS_MEANING: Partial<Record<OfferStatus, { banner: string; bannerColor: string }>> = {
  pending: {
    banner: 'Diese Schätzung ist unverbindlich und dient der Orientierung. Sie löst keine Zahlungspflicht aus.',
    bannerColor: 'bg-warn/5 text-warn ring-warn/20',
  },
  accepted: {
    banner: 'Diese Schätzung wurde bestätigt. Sie ist unverbindlich — keine Zahlungspflicht entsteht. Details werden direkt vereinbart.',
    bannerColor: 'bg-ok/5 text-ok ring-ok/20',
  },
}

// ── Diagnosis-mode overrides ──────────────────────────────────────────────
// Diagnosis is its own product path — not a variant of binding_offer or estimate.
// Freigabe ≠ Vollauftrag. Weitere Arbeiten brauchen ein neues Angebot.

const DIAGNOSIS_STATUS_MEANING: Partial<Record<OfferStatus, { banner: string; bannerColor: string }>> = {
  draft: {
    banner: 'Dieser Diagnose-Einsatz ist ein Entwurf und wurde noch nicht an den Kunden gesendet.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
  pending: {
    banner: 'Dieser Diagnose-Einsatz wartet auf die Freigabe des Kunden. Mit Freigabe wird eine Sofortzahlung ausgelöst (5 % Plattformgebühr). Der Handwerker ist ausschließlich zur Durchführung des Diagnoseeinsatzes berechtigt. Weitergehende Ausführungsarbeiten sind nicht enthalten.',
    bannerColor: 'bg-purple-50 text-purple-700 ring-purple-200/60',
  },
  accepted: {
    banner: 'Dieser Diagnose-Einsatz wurde freigegeben und die Zahlung ist ausgelöst. Der Handwerker ist befugt, die Diagnose durchzuführen. Weitere Ausführungsarbeiten erfordern ein separates Verbindliches Angebot und eine neue Zustimmung.',
    bannerColor: 'bg-ok/5 text-ok ring-ok/20',
  },
  declined: {
    banner: 'Dieser Diagnose-Einsatz wurde abgelehnt. Er ist nicht mehr gültig.',
    bannerColor: 'bg-danger/5 text-danger ring-danger/20',
  },
  expired: {
    banner: 'Die Gültigkeitsdauer dieses Diagnose-Einsatzes ist abgelaufen. Er kann nicht mehr freigegeben werden.',
    bannerColor: 'bg-warn/5 text-warn ring-warn/20',
  },
  superseded: {
    banner: 'Dieser Diagnose-Einsatz wurde durch eine neuere Version ersetzt.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
  cancelled: {
    banner: 'Dieser Diagnose-Einsatz wurde storniert.',
    bannerColor: 'bg-canvas text-ink-muted ring-edge',
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatCents(cents: number | undefined): string {
  if (cents == null) return '–'
  return sharedFormatCents(cents)
}

function formatDate(ms: number | undefined): string {
  if (!ms) return '–'
  return new Date(ms).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDateOnly(isoOrMs: string | number | undefined): string {
  if (!isoOrMs) return '–'
  const d = typeof isoOrMs === 'string' ? new Date(isoOrMs) : new Date(isoOrMs)
  if (isNaN(d.getTime())) return String(isoOrMs)
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function staleReasonText(reason: Offer['staleReason']): string {
  switch (reason) {
    case 'measurement_changed':
      return 'Eine Wand-Höhe wurde nach dem Versand des Angebots um mehr als 5 % korrigiert.'
    case 'high_severity_pin_added':
      return 'Es wurde ein neuer Schadens-Pin mit hoher Priorität ergänzt.'
    case 'layout_changed':
      return 'Eine Wand oder eine Öffnung im Raum wurde geändert.'
    default:
      return 'Die Aufmaß-Basis dieses Angebots wurde nach dem Versand verändert.'
  }
}

// ── Section wrapper ───────────────────────────────────────────────────────

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-card bg-surface p-4 ring-1 ring-edge shadow-subtle" data-testid={testId}>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
        {title}
      </h3>
      {children}
    </div>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (!value || value === '–') return null
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <span className="text-[12px] text-ink-muted">{label}</span>
      <span className={['text-[13px] font-medium text-ink text-right', mono ? 'tabular-nums' : ''].join(' ')}>
        {value}
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export default function QuoteDetailView({ offer, isCustomer, onAccept, onDecline, busy, actionError, followUpOffer, diagnosisPaymentState }: Props) {
  const statusCfg = STATUS_CONFIG[offer.status] ?? STATUS_CONFIG.pending
  // documentType is the leading field (Paket 1+); offerMode is legacy fallback
  const isEstimate = offer.documentType === 'estimate' || (!offer.documentType && offer.offerMode === 'estimate')
  const isCostEstimate = offer.documentType === 'cost_estimate'
  const isDiagnosis = offer.documentType === 'diagnosis'

  const acceptLabel = isDiagnosis
    ? 'Diagnoseeinsatz freigeben & bezahlen'
    : isEstimate
      ? 'Schätzung bestätigen'
      : isCostEstimate
        ? 'Kostenvoranschlag bestätigen'
        : 'Verbindliches Angebot annehmen'

  // Type-aware status meaning: diagnosis > estimate > cost_estimate > binding_offer default
  const statusMeaning =
    isDiagnosis && DIAGNOSIS_STATUS_MEANING[offer.status]
      ? DIAGNOSIS_STATUS_MEANING[offer.status]!
      : (isEstimate && ESTIMATE_STATUS_MEANING[offer.status])
        ? ESTIMATE_STATUS_MEANING[offer.status]!
        : (isCostEstimate && COST_ESTIMATE_STATUS_MEANING[offer.status])
          ? COST_ESTIMATE_STATUS_MEANING[offer.status]!
          : (STATUS_MEANING[offer.status] ?? STATUS_MEANING.pending)

  const hasPriceBreakdown = offer.grossTotal != null || offer.netTotal != null || offer.vatAmount != null
  const hasCostSplit = offer.laborCost != null || offer.materialCost != null || offer.otherCost != null
  const hasScope = offer.scopeSummary || offer.scopeIncluded || offer.scopeExcluded || offer.assumptions

  // ── Payment gating — only relevant for binding_offer ──────────────────
  const paymentReady = isQuotePaymentReady(offer)
  const paymentBasis = deriveQuotePaymentBasis(offer)
  const paymentGating = getQuotePaymentGatingReason(offer)
  const escrowSummary = paymentReady ? deriveEscrowPlanSummary(offer.id) : null
  const hasConditions = offer.validUntil || offer.paymentTerms || offer.cancellationTerms || offer.escrowRequired != null
  const hasProjectContext = offer.projectTitleSnapshot || offer.customerDescriptionSnapshot || offer.locationSnapshot || offer.description || offer.craftsmanNameSnapshot

  return (
    <div className="flex flex-col gap-3" data-testid="quote-detail-view">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon
            icon={isEstimate ? TrendingUp : isCostEstimate ? FileText : isDiagnosis ? AlertTriangle : statusCfg.icon}
            size="md"
            className={isEstimate ? 'text-warn' : isCostEstimate ? 'text-sky-600' : isDiagnosis ? 'text-purple-600' : statusCfg.color.split(' ')[1]}
          />
          <div>
            <h2 className="text-[17px] font-bold text-ink leading-none">
              {isEstimate ? 'Schätzung' : isCostEstimate ? 'Kostenvoranschlag' : isDiagnosis ? 'Diagnose-Einsatz' : 'Verbindliches Angebot'}
            </h2>
            {offer.offerRef && (
              <p className="text-[11px] text-ink-muted mt-0.5">{offer.offerRef}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={['rounded-chip px-2.5 py-0.5 text-[11px] font-semibold', statusCfg.color].join(' ')}
            data-testid="quote-status-badge"
          >
            {statusCfg.label}
          </span>
          {isEstimate && (
            <span
              className="rounded-chip px-2 py-0.5 text-[10px] font-semibold bg-warn/10 text-warn"
              data-testid="quote-mode-badge"
            >
              Schätzung
            </span>
          )}
          {isCostEstimate && (
            <span
              className="rounded-chip px-2 py-0.5 text-[10px] font-semibold bg-sky-50 text-sky-700"
              data-testid="quote-cost-estimate-badge"
            >
              Kostenvoranschlag
            </span>
          )}
          {isDiagnosis && (
            <span
              className="rounded-chip px-2 py-0.5 text-[10px] font-semibold bg-purple-50 text-purple-700"
              data-testid="quote-diagnosis-badge"
            >
              Diagnose-Einsatz
            </span>
          )}
        </div>
      </div>

      {/* Version + timestamps */}
      <div className="flex flex-wrap gap-3 text-[11px] text-ink-muted">
        {offer.version != null && offer.version > 1 && <span>Version {offer.version}</span>}
        <span>Erstellt: {formatDate(offer.createdAt)}</span>
        {offer.sentAt && offer.sentAt !== offer.createdAt && (
          <span>Gesendet: {formatDate(offer.sentAt)}</span>
        )}
        {offer.acceptedAt && <span>{isDiagnosis ? 'Freigegeben' : 'Angenommen'}: {formatDate(offer.acceptedAt)}</span>}
        {offer.declinedAt && <span>Abgelehnt: {formatDate(offer.declinedAt)}</span>}
      </div>

      {/* ── Folge-Angebot origin banner (Paket 4d) ──────────────────────── */}
      {offer.sourceDiagnosisId && (
        <div
          className="rounded-card bg-purple-50 p-3 text-[12px] leading-snug text-purple-700 ring-1 ring-purple-200/60"
          data-testid="quote-follow-up-origin"
        >
          Folge-Angebot nach Diagnose-Einsatz — dieses Angebot ist eigenständig und ersetzt nicht die Diagnose.
        </div>
      )}

      {/* ── Status Meaning Banner ──────────────────────────────────────── */}
      <div
        className={['rounded-card p-3 text-[13px] leading-snug ring-1', statusMeaning.bannerColor].join(' ')}
        data-testid="quote-status-meaning"
      >
        {statusMeaning.banner}
      </div>

      {/* ── Spatial · QUOTE-STALE banner (VF-2) ─────────────────────────── */}
      {offer.isStale === true && offer.status === 'pending' && (
        <div
          className="rounded-card border border-warn/30 bg-warn/5 p-3"
          data-testid="quote-stale-banner"
          role="status"
          aria-live="polite"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-warn">
            <Icon icon={AlertTriangle} size="sm" className="shrink-0" />
            Angebot nicht mehr aktuell
          </p>
          <p className="mt-1 text-[12px] text-ink/80">
            {staleReasonText(offer.staleReason)}{' '}
            {isCustomer
              ? 'Du kannst es weiterhin annehmen — wir empfehlen aber, vom Handwerksbetrieb ein aktualisiertes Angebot anzufordern.'
              : 'Wir empfehlen, ein aktualisiertes Angebot zu senden.'}
          </p>
          {offer.staleMarkedAt && (
            <p className="mt-1 text-[11px] text-ink-muted">
              Markiert am {formatDate(offer.staleMarkedAt)}
            </p>
          )}
        </div>
      )}

      {/* ── Accepted indicator — binding_offer only ──────────────────────── */}
      {offer.status === 'accepted' && !isEstimate && !isCostEstimate && !isDiagnosis && (
        <div
          className="rounded-card border border-ok/30 bg-ok/5 p-3"
          data-testid="quote-accepted-binding"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ok">
            <Icon icon={Lock} size="sm" className="shrink-0" />
            Verbindliche Auftragsgrundlage
          </p>
          <p className="mt-1 text-[12px] text-ok/80">
            Dieses verbindliche Angebot ist die vereinbarte Grundlage für den Auftrag.
            Preise, Leistungen und Konditionen sind bindend.
            {' '}Änderungen sind nicht mehr möglich.
          </p>
          {offer.acceptedAt && (
            <p className="mt-1 text-[11px] text-ok/70">
              Angenommen am {formatDate(offer.acceptedAt)}
            </p>
          )}
          {offer.createdJobId && (
            <p className="mt-0.5 text-[11px] text-ok/70">
              Auftrag erstellt: {offer.createdJobId}
            </p>
          )}
        </div>
      )}

      {/* ── Accepted indicator — cost_estimate ──────────────────────────── */}
      {offer.status === 'accepted' && isCostEstimate && (
        <div
          className="rounded-card border border-sky-200/60 bg-sky-50/60 p-3"
          data-testid="quote-accepted-cost-estimate"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-sky-700">
            <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
            Kostenvoranschlag bestätigt
          </p>
          <p className="mt-1 text-[12px] text-sky-700/80">
            Dieser Kostenvoranschlag wurde bestätigt. Für einen verbindlichen Auftragsabschluss mit Zahlungskorridor ist ein Verbindliches Angebot erforderlich.
          </p>
          {offer.acceptedAt && (
            <p className="mt-1 text-[11px] text-sky-600/70">
              Bestätigt am {formatDate(offer.acceptedAt)}
            </p>
          )}
        </div>
      )}

      {/* ── Accepted indicator — estimate ───────────────────────────────── */}
      {offer.status === 'accepted' && isEstimate && (
        <div
          className="rounded-card border border-warn/30 bg-warn/5 p-3"
          data-testid="quote-accepted-estimate"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-warn">
            <Icon icon={TrendingUp} size="sm" className="shrink-0" />
            Schätzung bestätigt
          </p>
          <p className="mt-1 text-[12px] text-warn/80">
            Diese Schätzung wurde bestätigt. Sie ist unverbindlich und löst keine Zahlungspflicht aus.
            Preis und Details werden direkt vereinbart.
          </p>
          {offer.acceptedAt && (
            <p className="mt-1 text-[11px] text-warn/70">
              Bestätigt am {formatDate(offer.acceptedAt)}
            </p>
          )}
        </div>
      )}

      {/* ── Accepted indicator — diagnosis ──────────────────────────────── */}
      {offer.status === 'accepted' && isDiagnosis && (
        <div
          className="rounded-card border border-purple-200/60 bg-purple-50/60 p-3"
          data-testid="quote-accepted-diagnosis"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-purple-700">
            <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
            Diagnoseeinsatz freigegeben
          </p>
          <p className="mt-1 text-[12px] text-purple-700/80">
            Der Handwerker ist befugt, den Diagnoseeinsatz durchzuführen.
            Preis und Umfang des Diagnoseeinsatzes sind mit dieser Freigabe vereinbart.
          </p>
          {followUpOffer ? (
            <div className="mt-2 rounded-[10px] bg-ok/5 px-2.5 py-1.5 text-[11px] text-ok ring-1 ring-ok/20">
              ✅ Folgeangebot vorhanden — weitere Ausführungsarbeiten wurden angeboten.
            </div>
          ) : (
            <div className="mt-2 rounded-[10px] bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200/50">
              ⚠️ Weitere Ausführungsarbeiten über den Diagnoseeinsatz hinaus erfordern ein neues Angebot und eine neue Zustimmung.
            </div>
          )}
          {offer.acceptedAt && (
            <p className="mt-1.5 text-[11px] text-purple-600/70">
              Freigegeben am {formatDate(offer.acceptedAt)}
            </p>
          )}
        </div>
      )}

      {/* ── Follow-up Angebot — Reverse Link: Diagnose → Folgeangebot ─────
          Only shown when this is an accepted diagnosis and a follow-up
          binding_offer already exists. Prevents duplicate follow-up creation
          and makes the Diagnose → Folgeangebot chain navigable.
      ── */}
      {offer.status === 'accepted' && isDiagnosis && followUpOffer && (
        <div
          className="rounded-card bg-surface p-4 ring-1 ring-edge shadow-subtle"
          data-testid="quote-followup-offer-section"
        >
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
            Folgeangebot
          </h3>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold text-ink">
                {followUpOffer.price}
                {followUpOffer.offerRef && (
                  <span className="ml-2 text-[11px] font-normal text-ink-muted">{followUpOffer.offerRef}</span>
                )}
              </p>
              <p className="text-[12px] text-ink-muted mt-0.5">
                {(() => {
                  switch (followUpOffer.status) {
                    case 'pending':   return 'Ausstehend — wartet auf Kundenentscheidung'
                    case 'accepted':  return 'Angenommen — verbindliche Auftragsgrundlage'
                    case 'declined':  return 'Abgelehnt'
                    case 'cancelled': return 'Storniert'
                    case 'expired':   return 'Abgelaufen'
                    case 'superseded': return 'Ersetzt durch neuere Version'
                    default:          return followUpOffer.status
                  }
                })()}
              </p>
            </div>
            <Link
              to={isCustomer
                ? `/quotes/${followUpOffer.id}`
                : `/craftsman/quotes/${followUpOffer.id}`}
              className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-brand hover:text-brand/80"
              data-testid="quote-followup-offer-link"
            >
              Ansehen <Icon icon={ExternalLink} size="sm" className="shrink-0" />
            </Link>
          </div>
        </div>
      )}

      {/* ── Payment Readiness (binding_offer only) ─────────────────────── */}
      {paymentReady && paymentBasis && (
        <div
          className="rounded-card border border-brand/20 bg-brand/5 p-3"
          data-testid="quote-payment-readiness"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-brand">
            <Icon icon={CreditCard} size="sm" className="shrink-0" />
            Zahlungsbasis aus angenommenem Angebot
          </p>
          <p className="mt-1 text-[12px] text-brand/80">
            {paymentGating.explanation}
          </p>
          {paymentBasis.totalAmountFormatted && (
            <div className="mt-2 flex flex-col gap-0.5">
              <p className="text-[12px] text-ink">
                <span className="font-semibold">Zahlung (100 %):</span>{' '}
                <span data-testid="quote-payment-total">{paymentBasis.totalAmountFormatted}</span>
              </p>
              <p className="text-[11px] text-brand/80">
                Der vollständige Betrag wird vorab über Stripe abgesichert und nach Leistungsfortschritt freigegeben.
              </p>
              {paymentBasis.depositAmountFormatted && (
                <p className="text-[11px] text-brand/80">
                  Freigabe bei Arbeitsbeginn ({paymentBasis.depositPercent} %): {paymentBasis.depositAmountFormatted}
                </p>
              )}
              {paymentBasis.finalAmountFormatted && (
                <p className="text-[11px] text-brand/80">
                  Freigabe bei Fertigstellung ({100 - paymentBasis.depositPercent} %): {paymentBasis.finalAmountFormatted}
                </p>
              )}
            </div>
          )}
          {/* ── Escrow Payment Plan (persisted basis) ─────────────────── */}
          {escrowSummary && (
            <div className="mt-2 border-t border-brand/20 pt-2" data-testid="quote-escrow-plan">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-brand">
                <Icon icon={Lock} size="sm" className="shrink-0" />
                Zahlungsplan
              </p>
              <p className="text-[11px] text-brand/80" data-testid="quote-escrow-plan-status">
                Status: {getEscrowPlanStatusLabel(escrowSummary.plan.status)}
              </p>
              <p className="text-[11px] text-brand/80" data-testid="quote-escrow-plan-model">
                Freigabemodell: 25 % bei Arbeitsbeginn / 75 % bei Fertigstellung
              </p>
              {escrowSummary.depositTranche && (
                <p className="text-[11px] text-brand/70" data-testid="quote-escrow-tranche-deposit">
                  Tranche 1: {escrowSummary.depositTranche.percentage} % — {getTrancheKindLabel(escrowSummary.depositTranche.kind)}
                </p>
              )}
              {escrowSummary.finalTranche && (
                <p className="text-[11px] text-brand/70" data-testid="quote-escrow-tranche-final">
                  Tranche 2: {escrowSummary.finalTranche.percentage} % — {getTrancheKindLabel(escrowSummary.finalTranche.kind)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 1. Project Context ──────────────────────────────────────────── */}
      {hasProjectContext && (
        <Section title={isDiagnosis ? 'Diagnose-Kontext' : 'Projektkontext'} testId="quote-section-project">
          {offer.craftsmanNameSnapshot && (
            <DetailRow label="Handwerker" value={offer.craftsmanNameSnapshot} />
          )}
          <DetailRow label="Projekt" value={offer.projectTitleSnapshot} />
          <DetailRow label="Kundenbeschreibung" value={offer.customerDescriptionSnapshot} />
          {/* Fallback: show description as project context when no snapshot exists */}
          {!offer.customerDescriptionSnapshot && offer.description && (
            <DetailRow label="Beschreibung" value={offer.description} />
          )}
          <DetailRow label="Standort" value={offer.locationSnapshot} />
          {offer.timingNote && (
            <DetailRow label={isDiagnosis ? 'Termin / Verfügbarkeit' : 'Zeitplanung'} value={offer.timingNote} />
          )}
        </Section>
      )}

      {/* ── 2. Price Structure ──────────────────────────────────────────── */}
      <Section title={isDiagnosis ? 'Diagnose-Pauschale' : 'Preisübersicht'} testId="quote-section-price">
        {/* Always show the human-readable price */}
        <div className="mb-2 text-[22px] font-bold text-ink" data-testid="quote-gross-price">
          {formatOfferPrice(offer.price)}
        </div>

        {/* VAT basis indicator */}
        <p className="mb-1 text-[11px] text-ink-muted">
          {offer.vatIncluded === false ? 'Netto-Preis (zzgl. MwSt.)' : 'Brutto-Preis (inkl. MwSt.)'}
        </p>

        {/* Diagnosis: explicit scope note under price */}
        {isDiagnosis && (
          <p className="mb-1 text-[11px] text-purple-600">
            Gilt ausschließlich für den Diagnoseeinsatz. Keine Leistungsausführung enthalten.
          </p>
        )}

        {hasPriceBreakdown && (
          <div className="border-t border-edge pt-2">
            <DetailRow label="Gesamtpreis brutto" value={formatCents(offer.grossTotal)} mono />
            <DetailRow label="Netto" value={formatCents(offer.netTotal)} mono />
            <DetailRow label="MwSt." value={offer.vatAmount != null
              ? `${formatCents(offer.vatAmount)}${offer.vatRate != null ? ` (${offer.vatRate} %)` : ''}`
              : undefined} mono />
          </div>
        )}

        {hasCostSplit && (
          <div className="mt-1 border-t border-edge pt-2">
            <DetailRow label="Arbeitskosten" value={formatCents(offer.laborCost)} mono />
            <DetailRow label="Materialkosten" value={formatCents(offer.materialCost)} mono />
            <DetailRow label="Sonstige Kosten" value={formatCents(offer.otherCost)} mono />
          </div>
        )}

        {/* Line items — if present */}
        {offer.lineItems && offer.lineItems.length > 0 && (
          <div className="mt-1 border-t border-edge pt-2">
            <p className="mb-1 text-[11px] font-semibold text-ink-muted">Positionen</p>
            {offer.lineItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-0.5 text-[12px]">
                <span className="text-ink-sub">
                  {item.label}
                  {item.quantity > 1 && <span className="text-ink-muted"> × {item.quantity}{item.unit ? ` ${item.unit}` : ''}</span>}
                </span>
                <span className="tabular-nums font-medium text-ink">
                  {formatCents(item.netAmount * item.quantity)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Hint when no structured price data exists */}
        {!hasPriceBreakdown && !hasCostSplit && (
          <p className="mt-1 text-[11px] text-ink-muted">
            Detaillierte Preisaufschlüsselung nicht verfügbar.
          </p>
        )}
      </Section>

      {/* ── 3. Scope & Exclusions ───────────────────────────────────────── */}
      {(hasScope || offer.description) && (
        <Section title={isDiagnosis ? 'Diagnose-Umfang' : 'Leistungsumfang'} testId="quote-section-scope">
          {offer.scopeSummary && (
            <div className="mb-2">
              <p className="mb-0.5 text-[11px] font-semibold text-ink-muted">
                {isDiagnosis ? 'Diagnose-Beschreibung' : 'Zusammenfassung'}
              </p>
              <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.scopeSummary}</p>
            </div>
          )}

          {offer.scopeIncluded && (
            <div className="mb-2">
              <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-ok">
                <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
                {isDiagnosis ? 'Im Diagnoseeinsatz enthalten' : 'Was wird gemacht'}
              </p>
              <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.scopeIncluded}</p>
            </div>
          )}

          {offer.scopeExcluded && (
            <div className="mb-2">
              <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-danger">
                <Icon icon={XCircle} size="sm" className="shrink-0" />
                {isDiagnosis ? 'Nicht im Diagnoseeinsatz enthalten' : 'Was ist NICHT enthalten'}
              </p>
              <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.scopeExcluded}</p>
            </div>
          )}

          {offer.assumptions && (
            <div className="mb-2">
              <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-warn">
                <Icon icon={AlertTriangle} size="sm" className="shrink-0" />
                Annahmen / Voraussetzungen
              </p>
              <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.assumptions}</p>
            </div>
          )}

          {/* Backward-compat: show description if no structured scope fields */}
          {!hasScope && offer.description && (
            <div>
              <p className="mb-0.5 text-[11px] font-semibold text-ink-muted">Beschreibung</p>
              <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.description}</p>
            </div>
          )}
        </Section>
      )}

      {/* ── 4. Conditions (always visible) ──────────────────────────────── */}
      <Section title="Konditionen" testId="quote-section-conditions">
        {hasConditions && (
          <>
            <DetailRow label="Gültig bis" value={formatDateOnly(offer.validUntil)} />
            {/* paymentTerms is "Sonderbedingungen" — optional execution notes, never a substitute
                for the platform escrow model. Not rendered for diagnosis (own payment path). */}
            {offer.paymentTerms && !isDiagnosis && (
              <DetailRow label="Sonderbedingungen" value={offer.paymentTerms} />
            )}
            <DetailRow label="Stornobedingungen" value={offer.cancellationTerms} />
            {offer.escrowRequired != null && !isDiagnosis && !isCostEstimate && !isEstimate && (
              <DetailRow
                label="SaFix Zahlungsschutz"
                value={offer.escrowRequired ? 'Aktiviert' : 'Nicht aktiviert'}
              />
            )}
          </>
        )}

        {/* Show timing note in conditions when not already shown in project context */}
        {offer.timingNote && !hasProjectContext && (
          <DetailRow label={isDiagnosis ? 'Termin' : 'Zeitplanung'} value={offer.timingNote} />
        )}

        {/* SaFix payment protection hint — binding_offer only */}
        {!isEstimate && !isCostEstimate && !isDiagnosis && (
          <div className="mt-2 flex items-start gap-1.5 border-t border-edge pt-2" data-testid="quote-fixup-escrow-hint">
            <Icon icon={Shield} size="sm" className="mt-0.5 shrink-0 text-ok" />
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Alle Zahlungen über SaFix sind durch den SaFix-Zahlungsschutz abgesichert.
              {offer.escrowRequired
                ? ' Für diesen Auftrag ist die Zahlungsabsicherung aktiviert.'
                : ' Details zu den Zahlungsmodalitäten werden bei Auftragserteilung festgelegt.'}
            </p>
          </div>
        )}

        {/* Kostenvoranschlag hint */}
        {isCostEstimate && (
          <div className="mt-2 flex items-start gap-1.5 border-t border-edge pt-2" data-testid="quote-cost-estimate-hint">
            <Icon icon={FileText} size="sm" className="mt-0.5 shrink-0 text-sky-600" />
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Dies ist ein Kostenvoranschlag. Er ist kein verbindlicher Auftragsabschluss. Für einen verbindlichen Auftrag mit Zahlungs-Zahlungsschutz ist ein Verbindliches Angebot erforderlich.
            </p>
          </div>
        )}

        {/* Estimate hint */}
        {isEstimate && (
          <div className="mt-2 flex items-start gap-1.5 border-t border-edge pt-2" data-testid="quote-estimate-hint">
            <Icon icon={TrendingUp} size="sm" className="mt-0.5 shrink-0 text-warn" />
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Dies ist eine unverbindliche Schätzung. Preis und Konditionen werden direkt zwischen Handwerker und Kunde vereinbart.
            </p>
          </div>
        )}

        {/* Diagnosis conditions hint + payment path */}
        {isDiagnosis && (
          <>
            <div className="mt-2 flex items-start gap-1.5 border-t border-edge pt-2" data-testid="quote-diagnosis-hint">
              <Icon icon={AlertTriangle} size="sm" className="mt-0.5 shrink-0 text-purple-600" />
              <p className="text-[11px] leading-relaxed text-ink-muted">
                Dies ist ein Diagnose-Einsatz. Er umfasst ausschließlich die Diagnose der beschriebenen Problemstellung.
                Weitergehende Ausführungsarbeiten sind nicht enthalten und erfordern ein separates Angebot sowie eine neue Zustimmung.
              </p>
            </div>
            {/* Diagnosis payment model — shown for all states to set expectations */}
            <div className="mt-2 rounded-[10px] bg-purple-50 px-3 py-2 text-[11px] text-purple-700 ring-1 ring-purple-200/60" data-testid="quote-diagnosis-payment-model">
              <p className="font-semibold mb-0.5">Zahlungsmodell: Diagnose-Sofortzahlung</p>
              <p className="opacity-80">
                Bei Freigabe wird eine Sofortzahlung über SaFix ausgelöst. Plattformgebühr: 5 % des Diagnosebetrags.
                Kein Standard-Zahlungskorridor.
              </p>
            </div>
          </>
        )}
      </Section>

      {/* ── 5. Actions Area ─────────────────────────────────────────────── */}
      <div className="rounded-card bg-canvas p-4 ring-1 ring-edge" data-testid="quote-section-actions">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
          Aktionen
        </h3>

        {/* ── pending + customer ── */}
        {offer.status === 'pending' && isCustomer && (
          <>
            <p className="mb-3 text-[12px] text-ink-muted">
              {isDiagnosis
                ? 'Dieser Diagnose-Einsatz berechtigt den Handwerker ausschließlich zur Durchführung der Diagnose. Prüfen Sie Umfang und Preis. Bei Freigabe wird eine Sofortzahlung ausgelöst. Weitere Ausführungsarbeiten sind nicht enthalten.'
                : isEstimate
                  ? 'Diese Schätzung ist unverbindlich. Sie können sie bestätigen (keine Zahlungspflicht) oder ablehnen.'
                  : isCostEstimate
                    ? 'Dieser Kostenvoranschlag ist kein verbindlicher Auftragsabschluss. Bestätigung löst keinen Zahlungskorridor aus.'
                    : 'Dieses verbindliche Angebot wartet auf Ihre Entscheidung. Mit Annahme erteilen Sie den Auftrag und die sichere Zahlungsabwicklung über Stripe wird gestartet.'}
            </p>
            {onAccept && onDecline && (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={onAccept}
                  className="flex-1 rounded-chip bg-ok px-4 py-2.5 text-[13px] font-semibold text-white shadow-subtle transition active:scale-[0.98] disabled:opacity-50"
                  data-testid="quote-action-accept"
                >
                  {busy ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <Spinner size="sm" tone="onDark" inButton />
                      {acceptLabel}
                    </span>
                  ) : (
                    acceptLabel
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDecline}
                  className="flex-1 rounded-chip bg-surface px-4 py-2.5 text-[13px] font-medium text-ink-sub ring-1 ring-edge shadow-subtle transition active:scale-[0.98] disabled:opacity-50"
                  data-testid="quote-action-decline"
                >
                  Ablehnen
                </button>
              </div>
            )}
          </>
        )}

        {/* ── pending + craftsman ── */}
        {offer.status === 'pending' && !isCustomer && (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-muted" data-testid="quote-action-waiting">
            <Icon icon={Clock} size="sm" className="shrink-0" />
            {isDiagnosis
              ? 'Wartet auf Freigabe des Kunden. Der Kunde kann den Diagnose-Einsatz freigeben (und die Zahlung auslösen) oder ablehnen.'
              : isCostEstimate
                ? 'Wartet auf Bestätigung des Kunden. Kostenvoranschlag löst keinen Zahlungskorridor aus.'
                : 'Wartet auf Kundenentscheidung. Der Kunde kann dieses Angebot annehmen oder ablehnen.'}
          </p>
        )}

        {/* ── accepted + binding_offer ── */}
        {offer.status === 'accepted' && !isEstimate && !isCostEstimate && !isDiagnosis && (
          <div data-testid="quote-action-locked">
            <p className="flex items-center gap-1.5 text-[12px] text-ok">
              <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
              Dieses verbindliche Angebot wurde angenommen — verbindliche Auftragsgrundlage.
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
              <Icon icon={Lock} size="sm" className="shrink-0" />
              Preise, Leistungen und Konditionen sind festgelegt. Änderungen erfolgen über Nachträge.
            </p>
            {paymentBasis?.totalAmountFormatted && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-brand" data-testid="quote-action-payment-basis">
                <Icon icon={CreditCard} size="sm" className="shrink-0" />
                Zahlungsbasis: {paymentBasis.totalAmountFormatted} — Zahlungskorridor aktiv.
              </p>
            )}
          </div>
        )}

        {/* ── accepted + cost_estimate ── */}
        {offer.status === 'accepted' && isCostEstimate && (
          <div data-testid="quote-action-cost-estimate-confirmed">
            <p className="flex items-center gap-1.5 text-[12px] text-sky-700">
              <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
              Kostenvoranschlag bestätigt.
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">
              Kein Zahlungskorridor — für eine verbindliche Auftragserteilung ist ein Verbindliches Angebot erforderlich.
            </p>
          </div>
        )}

        {/* ── accepted + estimate ── */}
        {offer.status === 'accepted' && isEstimate && (
          <div data-testid="quote-action-estimate-confirmed">
            <p className="flex items-center gap-1.5 text-[12px] text-warn">
              <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
              Diese Schätzung wurde bestätigt.
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">
              Sie ist unverbindlich — keine Zahlungspflicht entsteht. Preis und Konditionen werden direkt vereinbart.
              {offer.createdJobId && ' Ein Auftrag zur internen Verfolgung wurde angelegt.'}
            </p>
          </div>
        )}

        {/* ── accepted + diagnosis ── */}
        {offer.status === 'accepted' && isDiagnosis && (
          <div data-testid="quote-action-diagnosis-approved">
            <p className="flex items-center gap-1.5 text-[12px] text-ok">
              <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
              {diagnosisPaymentState === 'completed'
                ? 'Diagnoseeinsatz freigegeben & bezahlt.'
                : 'Diagnoseeinsatz wurde freigegeben.'}
            </p>

            {/* Customer: show payment form when payment is still pending */}
            {isCustomer && diagnosisPaymentState === 'pending' && offer.createdJobId && (
              <DiagnosisPaymentSheet
                jobId={offer.createdJobId}
                totalAmount={offer.grossTotal != null ? offer.grossTotal / 100 : 0}
              />
            )}

            {/* Customer: payment completed indicator */}
            {isCustomer && diagnosisPaymentState === 'completed' && (
              <p className="mt-1 text-[11px] text-purple-700">
                Zahlung abgeschlossen — der Handwerker darf den Diagnose-Einsatz durchführen.
              </p>
            )}

            {followUpOffer ? (
              <p className="mt-1 text-[11px] text-ink-muted">
                {isCustomer
                  ? 'Ein Folgeangebot für weitere Ausführungsarbeiten liegt bereits vor.'
                  : 'Sie haben bereits ein Folgeangebot für weitere Ausführungsarbeiten erstellt.'}
                {' '}
                <Link
                  to={isCustomer
                    ? `/quotes/${followUpOffer.id}`
                    : `/craftsman/quotes/${followUpOffer.id}`}
                  className="font-semibold text-brand hover:text-brand/80"
                >
                  Folgeangebot ansehen →
                </Link>
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-ink-muted">
                {isCustomer
                  ? diagnosisPaymentState !== 'pending'
                    ? 'Der Handwerker darf den Diagnoseeinsatz durchführen. Weitere Arbeiten außerhalb dieses Einsatzes bedürfen Ihrer neuen Zustimmung und eines neuen Angebots.'
                    : 'Bitte schließen Sie die Zahlung ab, um den Diagnoseeinsatz zu aktivieren.'
                  : diagnosisPaymentState === 'completed'
                    ? 'Zahlung eingegangen. Sie sind berechtigt, den Diagnoseeinsatz durchzuführen.'
                    : diagnosisPaymentState === 'pending'
                      ? 'Warte auf Kundenzahlung.'
                      : 'Sie sind berechtigt, den Diagnoseeinsatz durchzuführen. Weitere Ausführungsarbeiten außerhalb des Diagnoseeinsatzes erfordern ein neues Angebot und die erneute Zustimmung des Kunden.'}
              </p>
            )}
          </div>
        )}

        {/* ── declined ── */}
        {offer.status === 'declined' && (
          <div data-testid="quote-action-declined">
            <p className="flex items-center gap-1.5 text-[12px] text-danger">
              <Icon icon={XCircle} size="sm" className="shrink-0" />
              {isDiagnosis
                ? 'Dieser Diagnose-Einsatz wurde abgelehnt.'
                : isCostEstimate
                  ? 'Dieser Kostenvoranschlag wurde abgelehnt.'
                  : isEstimate
                    ? 'Diese Schätzung wurde abgelehnt.'
                    : 'Dieses Angebot wurde abgelehnt und ist nicht mehr gültig.'}
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">
              {isCustomer
                ? isDiagnosis
                  ? 'Sie können den Handwerker kontaktieren, um einen neuen Diagnose-Einsatz zu besprechen.'
                  : 'Sie können den Handwerker kontaktieren, um ein neues Dokument zu besprechen.'
                : isDiagnosis
                  ? 'Der Kunde hat den Diagnose-Einsatz abgelehnt. Sie können einen neuen Diagnose-Einsatz erstellen.'
                  : 'Der Kunde hat abgelehnt. Sie können ein neues Dokument erstellen.'}
            </p>
          </div>
        )}

        {/* ── expired / superseded / cancelled ── */}
        {(offer.status === 'expired' || offer.status === 'superseded' || offer.status === 'cancelled') && (
          <p className="text-[12px] text-ink-muted">
            {isDiagnosis ? 'Diese Diagnose-Anfrage ist nicht mehr aktiv.' : 'Dieses Angebot ist nicht mehr aktiv.'}
            {offer.status === 'expired' && ' Die Gültigkeitsdauer ist abgelaufen.'}
            {offer.status === 'superseded' && ' Es wurde durch eine neuere Version ersetzt.'}
            {offer.status === 'cancelled' && ' Es wurde storniert.'}
          </p>
        )}

        {/* ── draft ── */}
        {offer.status === 'draft' && (
          <p className="text-[12px] text-ink-muted">
            {isDiagnosis
              ? 'Diese Diagnose-Anfrage wurde noch nicht gesendet.'
              : 'Dieser Entwurf wurde noch nicht gesendet.'}
          </p>
        )}

        {/* ── action error ── */}
        {actionError && (
          <p className="mt-2 text-[11px] text-danger" role="alert" data-testid="quote-action-error">
            {actionError}
          </p>
        )}
      </div>

      {/* ── Notes (craftsman internal — never visible to customer) ─────────── */}
      {offer.notes && !isCustomer && (
        <Section title="Interne Notizen" testId="quote-section-notes">
          <p className="text-[13px] text-ink-sub whitespace-pre-line">{offer.notes}</p>
        </Section>
      )}
    </div>
  )
}
