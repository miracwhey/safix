/**
 * QuoteDetailScreen — Full Kostenvoranschlag / Quote Detail View
 *
 * The real information-rich offer view, reachable from the compact
 * timeline quote card (ThreadArtifactOfferCard / QuoteSendEventCard).
 *
 * Grouped sections:
 *   1. Project Context — title, description, category, location
 *   2. Price Structure — gross, net, VAT, labor/material/other split
 *   3. Scope & Exclusions — included, excluded, assumptions
 *   4. Timing / Validity / Conditions — validity, payment terms, cancellation
 *   5. Actions Area — accept/decline (customer), waiting (craftsman), locked/inactive states
 *
 * Data source: Offer entity from the offer repository.
 * Route: /quotes/:offerId  (customer)
 *        /craftsman/quotes/:offerId  (craftsman)
 *
 * DETERMINISTIC QUOTE DETAIL LOADING CONTRACT:
 *   1. Resolve route param via resolveCanonicalQuoteId (direct offerId → jobId fallback).
 *   2. If offer found → loaded, render detail.
 *   3. If offer NOT found AND repository is hydrated → loaded, render "not found".
 *   4. If offer NOT found AND repository NOT hydrated → stay in loading state,
 *      subscribeOffers will re-check on every repository change (including hydration).
 *   No timeout. The not-found decision is only made after the canonical data
 *   source has definitively completed its initial load.
 */

import { useEffect, useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import QuoteDetailView from '../components/quotes/QuoteDetailView'
import {
  resolveCanonicalQuoteId,
  subscribeOffers,
  isOfferRepositoryHydrated,
  getFollowUpOfferForDiagnosis,
} from '../lib/offers'
import { acceptOfferWorkflow, declineOfferWorkflow } from '../lib/workflow/offerWorkflow'
import { normalizeErrorMessage } from '../lib/diagnostics'
import { getProjectByJobId } from '../lib/projects'
import { isSpatialOffer, type Offer } from '../lib/offers'
import { shareOrDownloadOfferPdf } from '../lib/offers/pdf/generateOfferPdf'
import { getThreadByLegacyConversationId } from '../lib/chat'
import {
  getChangeOrdersByJobId,
  subscribeChangeOrders,
} from '../lib/changeOrders'
import type { ChangeOrder } from '../lib/changeOrders/types'
import { formatCents } from '../lib/shared/formatters'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenError from '../components/system/ScreenError'
import ScreenNotFound from '../components/system/ScreenNotFound'
import { getPaymentForJob, subscribePayments } from '../lib/payments'
import { useSmartBack } from '../hooks/useSmartBack'
import { useHaptics } from '../hooks/useHaptics'
import { useToast } from '../hooks/useToast'

// ── Status label for ChangeOrder list ────────────────────────────────────────

function coStatusLabel(status: ChangeOrder['status']): string {
  switch (status) {
    case 'pending':   return 'Ausstehend'
    case 'accepted':  return 'Angenommen'
    case 'declined':  return 'Abgelehnt'
    case 'cancelled': return 'Zurückgezogen'
    default:          return status
  }
}

function coStatusColor(status: ChangeOrder['status']): string {
  switch (status) {
    case 'pending':   return 'text-amber-700'
    case 'accepted':  return 'text-emerald-700'
    case 'declined':  return 'text-rose-700'
    case 'cancelled': return 'text-slate-500'
    default:          return 'text-slate-500'
  }
}

export default function QuoteDetailScreen() {
  const { offerId } = useParams<{ offerId: string }>()
  const navigate = useNavigate()
  const haptics = useHaptics()
  const toast = useToast()
  const goBack = useSmartBack('/messages')
  const location = useLocation()
  const initialOffer = offerId ? resolveCanonicalQuoteId(offerId) : undefined
  const [offer, setOffer] = useState<Offer | undefined>(initialOffer)
  const [loaded, setLoaded] = useState(() => {
    if (initialOffer) return true
    return isOfferRepositoryHydrated()
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Follow-up offer for diagnosis reverse link (diagnosis → follow-up binding_offer)
  const [followUpOffer, setFollowUpOffer] = useState<Offer | undefined>(() => {
    if (!initialOffer || initialOffer.documentType !== 'diagnosis') return undefined
    return getFollowUpOfferForDiagnosis(initialOffer.id)
  })

  // ChangeOrders for this offer's job (only when offer is accepted binding_offer)
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>(() => {
    if (!initialOffer?.createdJobId) return []
    return getChangeOrdersByJobId(initialOffer.createdJobId).filter(
      (co) => co.status !== 'cancelled'
    )
  })

  // Diagnosis payment state — only relevant for diagnosis offers
  function deriveDiagnosisPaymentState(o: Offer | undefined): 'pending' | 'completed' | null {
    if (!o || o.documentType !== 'diagnosis' || !o.createdJobId) return null
    const payment = getPaymentForJob(o.createdJobId)
    if (!payment) return null
    if (payment.state === 'diagnosis_payment_completed') return 'completed'
    if (payment.state === 'diagnosis_payment_pending') return 'pending'
    return null
  }

  const [diagnosisPaymentState, setDiagnosisPaymentState] = useState<'pending' | 'completed' | null>(
    () => deriveDiagnosisPaymentState(initialOffer)
  )

  // Determine role from route path: /quotes/:id = customer, /craftsman/quotes/:id = craftsman
  const isCustomer = !location.pathname.startsWith('/craftsman/')
  const messagesBase = isCustomer ? '/messages' : '/craftsman/messages'
  // Navigate back to the originating thread when the offer is loaded,
  // otherwise fall back to the messages list.
  const backPath = offer?.conversationId
    ? `${messagesBase}/${offer.conversationId}`
    : messagesBase

  useEffect(() => {
    if (!offerId) return

    function refresh() {
      const found = resolveCanonicalQuoteId(offerId!)
      setOffer(found)

      // Deterministic loaded decision:
      //   - offer found → loaded
      //   - offer not found AND repo hydrated → loaded (will render "not found")
      //   - offer not found AND repo NOT hydrated → stay loading (subscription will re-check)
      if (found || isOfferRepositoryHydrated()) {
        setLoaded(true)
      }

      // Keep followUpOffer in sync when offer store changes
      if (found?.documentType === 'diagnosis') {
        setFollowUpOffer(getFollowUpOfferForDiagnosis(found.id))
      } else {
        setFollowUpOffer(undefined)
      }

      // Keep changeOrders in sync when offer store changes
      if (found?.createdJobId) {
        setChangeOrders(
          getChangeOrdersByJobId(found.createdJobId).filter((co) => co.status !== 'cancelled')
        )
      }

      setDiagnosisPaymentState(deriveDiagnosisPaymentState(found))
    }

    refresh()
    const unsubOffers = subscribeOffers(refresh)
    const unsubCOs = subscribeChangeOrders(() => {
      const current = resolveCanonicalQuoteId(offerId!)
      if (current?.createdJobId) {
        setChangeOrders(
          getChangeOrdersByJobId(current.createdJobId).filter((co) => co.status !== 'cancelled')
        )
      }
    })
    const unsubPayments = subscribePayments(() => {
      const current = resolveCanonicalQuoteId(offerId!)
      setDiagnosisPaymentState(deriveDiagnosisPaymentState(current))
    })
    return () => { unsubOffers(); unsubCOs(); unsubPayments() }
  }, [offerId])

  const handleAccept = async () => {
    if (busy || !offer) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await acceptOfferWorkflow(offer.id)
      if (!result || result.status !== 'accepted') {
        setActionError('Angebot konnte nicht angenommen werden.')
        return
      }
      haptics.success()
      toast.success('Angebot angenommen ✓')
      if (isCustomer) {
        const project = result.createdJobId ? getProjectByJobId(result.createdJobId) : undefined
        navigate(project ? `/projects/${project.id}` : '/projects', { replace: true })
      } else {
        navigate(result.createdJobId ? `/craftsman/jobs/${result.createdJobId}` : '/craftsman/jobs', { replace: true })
      }
    } catch (err) {
      setActionError(`Annahme fehlgeschlagen: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDecline = async () => {
    if (busy || !offer) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await declineOfferWorkflow(offer.id)
      if (!result || result.status !== 'declined') {
        setActionError('Angebot konnte nicht abgelehnt werden.')
        return
      }
      navigate(backPath, { replace: true })
    } catch (err) {
      setActionError(`Ablehnung fehlgeschlagen: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!offerId) {
    return (
      <AppShell>
        <ScreenError title="Angebot-ID fehlt" description="Die Angebots-Adresse ist ungültig." backTo="/" backLabel="← Zurück" />
      </AppShell>
    )
  }

  if (!loaded) {
    return (
      <AppShell>
        <ScreenSkeleton />
      </AppShell>
    )
  }

  if (!offer) {
    return (
      <AppShell>
        <ScreenNotFound
          title="Angebot nicht gefunden"
          subtitle="Das Angebot konnte nicht geladen werden oder existiert nicht mehr."
          backTo={backPath}
          backLabel="Zurück"
        />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="px-4 pb-8 pt-4">
        {/* Back navigation */}
        <button
          type="button"
          onClick={goBack}
          className="mb-4 text-[14px] font-medium text-brand"
          data-testid="quote-detail-back"
        >
          ← Zurück
        </button>

        {/* C-10 · C10.6 — Spatial-Origin badge + C10.8 PDF-Download */}
        <div className="mb-3 flex items-center justify-between gap-2">
          {isSpatialOffer(offer) ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DBEAFE] bg-[#EFF6FF] px-2.5 py-1 text-[11px] font-bold text-brand">
              <span aria-hidden="true">📐</span>
              Vom 3D-Aufmaß
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => {
              setActionError(null)
              void shareOrDownloadOfferPdf(offer, {
                customerName: offer.conversationId
                  ? getThreadByLegacyConversationId(offer.conversationId)?.displayMetadata
                      ?.customerName
                  : null,
              }).catch((err) =>
                setActionError(`PDF konnte nicht erstellt werden: ${normalizeErrorMessage(err)}`),
              )
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-canvas px-2.5 py-1 text-[11px] font-bold text-ink hover:bg-surface"
            data-testid="quote-detail-pdf-download"
            aria-label="Angebot als PDF teilen oder herunterladen"
          >
            <span aria-hidden="true">⬇</span>
            PDF
          </button>
        </div>


        <QuoteDetailView
          offer={offer}
          isCustomer={isCustomer}
          onAccept={handleAccept}
          onDecline={handleDecline}
          busy={busy}
          actionError={actionError}
          followUpOffer={followUpOffer}
          diagnosisPaymentState={diagnosisPaymentState}
        />

        {/* ── ChangeOrders section — shown for accepted binding_offers ──
            Reverse link: accepted Offer → its ChangeOrders.
            Customer and craftsman both see the CO list with status and a
            deep-link to ChangeOrderDetailScreen.
        ── */}
        {offer.status === 'accepted' && changeOrders.length > 0 && (
          <div
            className="rounded-card bg-surface p-4 ring-1 ring-edge shadow-subtle"
            data-testid="quote-change-orders-section"
          >
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
              Nachträge
            </h3>
            <ul className="space-y-2">
              {changeOrders.map((co) => {
                const deltaLabel = co.grossTotal != null
                  ? (co.grossTotal >= 0 ? '+' : '') + formatCents(co.grossTotal)
                  : co.price
                const coPath = isCustomer
                  ? `/nachtrag/${co.id}`
                  : `/craftsman/nachtrag/${co.id}`
                return (
                  <li
                    key={co.id}
                    className="flex items-center justify-between gap-3 rounded-card bg-canvas px-3 py-2 ring-1 ring-edge/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={['text-[11px] font-semibold', coStatusColor(co.status)].join(' ')}>
                          {coStatusLabel(co.status)}
                        </span>
                        <span className="ml-auto text-[13px] font-bold text-ink">
                          {deltaLabel}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                        {co.description}
                      </p>
                    </div>
                    <Link
                      to={coPath}
                      className="shrink-0 text-[11px] font-semibold text-brand hover:text-brand/80"
                    >
                      Details →
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </AppShell>
  )
}
