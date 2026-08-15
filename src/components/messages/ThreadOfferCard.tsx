import { useState } from 'react'
import type { Offer } from '../../lib/offers/types'
import type { MessageRole } from '../../lib/messages'
import {
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../lib/workflow/offerWorkflow'
import DiagnosticDebugBlock from '../DiagnosticDebugBlock'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../../lib/diagnostics'
import { formatOfferPrice } from '../../lib/shared/formatters'

import type { OfferPaymentPhase } from '../../lib/messages/threadArtifactTypes'
import type { PaymentState } from '../../lib/shared/coreTypes'

type Props = {
  offer: Offer
  role: MessageRole
  /** Derived lifecycle phase from OfferPaymentArtifact */
  phase?: OfferPaymentPhase
  /** Actionable payment state from the linked job (post-acceptance) */
  paymentState?: PaymentState | null
  onUpdated?: () => void
}

/**
 * Compact inline card shown in a message thread when an offer exists.
 *
 * - Pending state: shows price + accept/decline CTAs (customer only)
 * - Accepted state: shows confirmation with linked job info
 * - Declined state: shows declined status
 *
 * Craftsman sees the offer state but cannot accept/decline.
 */
export default function ThreadOfferCard({ offer, role, phase, paymentState, onUpdated }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<RuntimeDiagnostic | null>(null)

  const isPending = offer.status === 'pending'
  const isAccepted = offer.status === 'accepted'
  const isDeclined = offer.status === 'declined'
  const isCustomer = role === 'customer'

  const handleAccept = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setDebugInfo(null)
    try {
      const result = await acceptOfferWorkflow(offer.id)
      if (!result || result.status !== 'accepted') {
        const diagnostic = buildDiagnostic({
          source: 'OFFER_ACCEPT',
          step: 'accept_offer_result',
          name: 'ThreadOfferCard.handleAccept',
          error: result ?? undefined,
          details: { offerId: offer.id, status: result?.status },
          hint: 'Offer not accepted; inspect workflow return value.',
        })
        emitDiagnostic(diagnostic)
        setDebugInfo(diagnostic)
        setError('Angebot konnte nicht angenommen werden.')
        return
      }
      onUpdated?.()
    } catch (err) {
      const diagnostic = buildDiagnostic({
        source: 'OFFER_ACCEPT',
        step: 'accept_offer_throw',
        name: 'ThreadOfferCard.handleAccept',
        error: err,
        details: { offerId: offer.id },
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setError('Annahme fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setBusy(false)
    }
  }

  const handleDecline = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await declineOfferWorkflow(offer.id)
      onUpdated?.()
    } catch {
      setError('Ablehnung fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  const isPaymentDue = phase === 'payment_due'

  const statusIcon = isPaymentDue ? '💳' : isAccepted ? '✅' : isDeclined ? '❌' : '📋'
  const statusLabel = isPaymentDue
    ? 'Zahlung fällig'
    : isAccepted
      ? 'Angebot angenommen'
      : isDeclined
        ? 'Angebot abgelehnt'
        : 'Angebot liegt vor'

  const ringColor = isPaymentDue
    ? 'ring-amber-200/80'
    : isAccepted
      ? 'ring-emerald-200/80'
      : isDeclined
        ? 'ring-slate-200/70'
      : 'ring-blue-200/80'

  return (
    <div
      className={[
        'rounded-[14px] bg-white px-3.5 py-3 ring-1 shadow-[0_8px_20px_-18px_rgba(2,6,23,0.10)]',
        ringColor,
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className="text-[16px] leading-none">{statusIcon}</span>
        <span className="text-[13px] font-semibold text-slate-800">
          {statusLabel}
        </span>
        <span className="ml-auto text-[14px] font-bold text-slate-900">
          {formatOfferPrice(offer.price)}
        </span>
      </div>

      {offer.description && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
          {offer.description}
        </p>
      )}

      {offer.timingNote && (
        <p className="mt-1 text-[11px] text-slate-400">
          🕐 {offer.timingNote}
        </p>
      )}

      {isPending && isCustomer && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleAccept}
            className="flex-1 rounded-full bg-emerald-600 px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition active:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? '…' : '✅ Annehmen'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleDecline}
            className="flex-1 rounded-full bg-white px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200 shadow-sm transition active:bg-slate-50 disabled:opacity-50"
          >
            Ablehnen
          </button>
        </div>
      )}

      {isPending && !isCustomer && (
        <p className="mt-2 text-[11px] text-slate-400">
          Wartet auf Kundenentscheidung
        </p>
      )}

      {/* Payment/deposit CTA — shown when offer is accepted and payment is due */}
      {isPaymentDue && isCustomer && (
        <div className="mt-3">
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200/60">
            {statusIcon} {paymentState === 'deposit_required'
              ? 'Zahlung erforderlich — der vollständige Betrag wird vorab gesichert.'
              : 'Zahlung ausstehend.'}
          </div>
        </div>
      )}

      {isPaymentDue && !isCustomer && (
        <p className="mt-2 text-[11px] text-amber-600">
          Zahlung ausstehend — Kunde wurde benachrichtigt
        </p>
      )}

      {error && (
        <p className="mt-2 text-[12px] text-red-500" role="alert">
          {error}
        </p>
      )}
      <DiagnosticDebugBlock diagnostic={debugInfo} />
    </div>
  )
}
