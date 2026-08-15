/**
 * SpatialOfferStatusCard — Spatial Canonical · C-10 · C10.6
 *
 * Renders the current canonical-offer state for a Spatial scene. Reads the
 * offer via `scene.metadata.canonicalOfferId` (written by C10.4's
 * `handleQuoteSend`) and resolves it through the OfferRepository. Subscribes
 * to the repo so a customer accept/decline updates the card live.
 *
 * Role-aware:
 *   - Provider sees their sent quote's status + amount + documentType.
 *   - Customer sees the same plus accept/decline-CTA hints (the actual
 *     accept/decline wiring lives in C10.7's spatial-accept handler).
 *
 * Returns null when no canonical offer is linked yet (pre-send state) — the
 * BoM-Tab's own "send" button is the only call-to-action at that point.
 */

import { useSyncExternalStore } from 'react'
import { CheckCircle2, XCircle, Clock, Box } from 'lucide-react'
import { getOfferRepository } from '../../lib/offers/repository/registry'
import { isSpatialOffer, type Offer } from '../../lib/offers/types'
import type { SpatialScene } from '../../lib/spatial/canonical/repository/SpatialSceneRepository'

export interface SpatialOfferStatusCardProps {
  scene: SpatialScene
  /**
   * Provider sees "Angebot gesendet" labels + sent-state styling.
   * Customer sees "Angebot erhalten" labels + action hints.
   */
  role: 'provider' | 'customer'
}

function formatEur(cents: number | undefined): string {
  if (cents == null) return '—'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function documentTypeLabel(offer: Offer): string {
  if (offer.documentType === 'binding_offer') return 'Festpreis-Angebot'
  if (offer.documentType === 'cost_estimate') return 'Kostenvoranschlag'
  return 'Angebot'
}

function statusTextProvider(offer: Offer): { label: string; tone: 'pending' | 'ok' | 'rejected' } {
  if (offer.status === 'pending') return { label: 'Angebot gesendet · wartet auf Kund:in', tone: 'pending' }
  if (offer.status === 'accepted') return { label: 'Angebot angenommen', tone: 'ok' }
  if (offer.status === 'declined') return { label: 'Angebot abgelehnt', tone: 'rejected' }
  if (offer.status === 'expired') return { label: 'Angebot abgelaufen', tone: 'rejected' }
  if (offer.status === 'superseded') return { label: 'Durch neueres Angebot ersetzt', tone: 'rejected' }
  return { label: offer.status, tone: 'pending' }
}

function statusTextCustomer(offer: Offer): { label: string; tone: 'pending' | 'ok' | 'rejected' } {
  if (offer.status === 'pending') return { label: 'Du hast ein neues Angebot · bitte prüfen', tone: 'pending' }
  if (offer.status === 'accepted') return { label: 'Angebot von dir angenommen', tone: 'ok' }
  if (offer.status === 'declined') return { label: 'Angebot von dir abgelehnt', tone: 'rejected' }
  if (offer.status === 'expired') return { label: 'Angebot abgelaufen', tone: 'rejected' }
  if (offer.status === 'superseded') return { label: 'Neues Angebot vorhanden', tone: 'rejected' }
  return { label: offer.status, tone: 'pending' }
}

export default function SpatialOfferStatusCard({ scene, role }: SpatialOfferStatusCardProps) {
  const canonicalOfferId =
    typeof scene.metadata?.canonicalOfferId === 'string'
      ? scene.metadata.canonicalOfferId
      : null

  // useSyncExternalStore over the offer-repo's subscribe surface — preserves
  // idiomatic React 18 semantics (no cascading setState-in-effect lint), keeps
  // the snapshot referentially stable across renders (getById returns the same
  // reference until a real change occurs), and re-reads automatically when
  // canonicalOfferId changes via the dependency on the captured snapshot fn.
  const offer = useSyncExternalStore<Offer | undefined>(
    (onChange) => getOfferRepository().subscribe(onChange),
    () => (canonicalOfferId ? getOfferRepository().getById(canonicalOfferId) : undefined),
  )

  // Pre-send state: no canonical offer linked yet. The BoM-Tab's send button
  // is the only call-to-action — render nothing.
  if (!canonicalOfferId || !offer) return null

  // Defensive: if for some reason a non-spatial offer was linked here,
  // skip rendering rather than show conflicting copy.
  if (!isSpatialOffer(offer)) return null

  const status = role === 'provider' ? statusTextProvider(offer) : statusTextCustomer(offer)
  const toneClasses =
    status.tone === 'ok'
      ? 'border-[#A7F3D0] bg-[#D1FAE5] text-ok'
      : status.tone === 'rejected'
        ? 'border-[#FECACA] bg-[#FEE2E2] text-danger'
        : 'border-[#DBEAFE] bg-[#EFF6FF] text-brand'

  const Icon =
    status.tone === 'ok' ? CheckCircle2 : status.tone === 'rejected' ? XCircle : Clock

  return (
    <div
      className={[
        'flex items-start gap-[10px] rounded-[12px] border px-[12px] py-[10px]',
        toneClasses,
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      <span className="mt-[1px] flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-white">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-bold leading-snug">{status.label}</p>
        <p className="mt-0.5 flex items-center gap-[6px] text-[11px] font-semibold text-ink-sub">
          <Box size={11} aria-hidden="true" />
          <span>
            {documentTypeLabel(offer)} · {formatEur(offer.grossTotal)}
          </span>
        </p>
      </div>
    </div>
  )
}
