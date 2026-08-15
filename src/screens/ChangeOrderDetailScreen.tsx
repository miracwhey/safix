/**
 * ChangeOrderDetailScreen — Nachtrag-Detailansicht
 *
 * Canonical detail view for a ChangeOrder (Nachtrag).
 * Accessible by both craftsman and customer.
 *
 * Routes:
 *   /craftsman/nachtrag/:changeOrderId  (craftsman)
 *   /nachtrag/:changeOrderId             (customer)
 *
 * Role is determined from the URL path prefix.
 *
 * Customer (pending):     Accept / Decline buttons
 * Craftsman (pending):    Cancel button
 * Accepted + locked:      SupplementaryPaymentRequest section
 *                         Customer: acknowledge obligation
 *                         Craftsman: confirm receipt / waive
 * Terminal states:        Read-only detail view
 */

import { useEffect, useState } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import {
  CheckCircle,
  CreditCard,
  Undo2,
  Clock,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react'
import { Icon } from '../components/primitives'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenNotFound from '../components/system/ScreenNotFound'
import InlineFeedback from '../components/system/InlineFeedback'
import {
  getChangeOrderById,
  subscribeChangeOrders,
  isChangeOrderRepositoryHydrated,
} from '../lib/changeOrders'
import type { ChangeOrder } from '../lib/changeOrders/types'
import {
  acceptChangeOrderWorkflow,
  declineChangeOrderWorkflow,
} from '../lib/workflow/changeOrderWorkflow'
import { getJobById } from '../lib/jobs'
import { getPaymentForJobWorkflow } from '../lib/workflow'
import { getOfferById } from '../lib/offers'
import { shareOrDownloadChangeOrderPdf } from '../lib/changeOrders/pdf/generateChangeOrderPdf'
import { getThreadByLegacyConversationId } from '../lib/chat'
import {
  getSupplementaryPaymentByChangeOrderId,
  acknowledgeSupplementaryPayment,
  markSupplementaryPaymentPaid,
  waiiveSupplementaryPayment,
  subscribeSupplementaryPayments,
  getSupplementaryPaymentStatusLabel,
  isSupplementaryPaymentTerminal,
  canInitiateSupplementaryFunding,
  reconcileSupplementaryTimelineEvents,
} from '../lib/payments/supplementary'
import type { SupplementaryPaymentRequest } from '../lib/payments/supplementary'
import { formatEuro, formatCents } from '../lib/shared/formatters'
import { normalizeErrorMessage } from '../lib/diagnostics'
import { useSession } from '../hooks/useSession'
import { useSmartBack } from '../hooks/useSmartBack'
import { useStoreSubscriptions } from '../lib/reactive'
import { subscribeJobs } from '../lib/jobs'

// ── Structured description parsing ───────────────────────────────────────────

interface ParsedDescription {
  leistung: string
  ursache: string | null
  termin: string | null
}

function parseStructuredDescription(desc: string): ParsedDescription {
  const grundIdx = desc.indexOf('\n\nGrund: ')
  if (grundIdx === -1) return { leistung: desc, ursache: null, termin: null }

  const leistung = desc.slice(0, grundIdx)
  const rest = desc.slice(grundIdx + '\n\nGrund: '.length)
  const terminIdx = rest.indexOf('\n\nTermin: ')
  if (terminIdx === -1) return { leistung, ursache: rest, termin: null }

  return {
    leistung,
    ursache: rest.slice(0, terminIdx),
    termin: rest.slice(terminIdx + '\n\nTermin: '.length),
  }
}

// ── Status display ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ChangeOrder['status'] }) {
  const map: Record<ChangeOrder['status'], { label: string; classes: string }> = {
    draft:     { label: 'Entwurf',          classes: 'bg-slate-100 text-slate-600' },
    pending:   { label: 'Ausstehend',        classes: 'bg-amber-100 text-amber-800' },
    accepted:  { label: 'Angenommen',        classes: 'bg-emerald-100 text-emerald-800' },
    declined:  { label: 'Abgelehnt',         classes: 'bg-rose-100 text-rose-700' },
    cancelled: { label: 'Zurückgezogen',     classes: 'bg-slate-100 text-slate-500' },
  }
  const { label, classes } = map[status] ?? { label: status, classes: 'bg-slate-100 text-slate-600' }
  return (
    <span className={['inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold', classes].join(' ')}>
      {label}
    </span>
  )
}

// ── Supplementary Payment Section ─────────────────────────────────────────────

function SupplementaryPaymentSection({
  request,
  isCraftsman,
  onAction,
}: {
  request: SupplementaryPaymentRequest
  isCraftsman: boolean
  onAction: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const amountLabel = formatCents(request.amountCents)
  const statusLabel = getSupplementaryPaymentStatusLabel(request.status)
  const isTerminal = isSupplementaryPaymentTerminal(request.status)
  const canFund = canInitiateSupplementaryFunding(request.status)

  const statusColors: Record<string, string> = {
    pending: 'bg-amber-50 ring-amber-200/60 text-amber-900',
    acknowledged: 'bg-blue-50 ring-blue-200/60 text-blue-900',
    funding_initiated: 'bg-blue-50 ring-blue-200/60 text-blue-900',
    funded: 'bg-teal-50 ring-teal-200/60 text-teal-900',
    released: 'bg-emerald-50 ring-emerald-200/60 text-emerald-900',
    paid: 'bg-emerald-50 ring-emerald-200/60 text-emerald-900',
    waived: 'bg-slate-50 ring-slate-200/60 text-slate-700',
  }
  const tone = statusColors[request.status] ?? statusColors.pending

  // Status icon — inherits the card tone color via currentColor.
  const headerIcon: LucideIcon =
    request.status === 'released' || request.status === 'paid'
      ? CheckCircle
      : request.status === 'funded'
        ? CreditCard
        : request.status === 'waived'
          ? Undo2
          : request.status === 'funding_initiated'
            ? Clock
            : AlertTriangle

  const handleAcknowledge = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await acknowledgeSupplementaryPayment(request.id)
      onAction()
    } catch (err) {
      setError(`Fehler: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleMarkPaid = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await markSupplementaryPaymentPaid(request.id)
      onAction()
    } catch (err) {
      setError(`Fehler: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleWaive = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await waiiveSupplementaryPayment(request.id)
      onAction()
    } catch (err) {
      setError(`Fehler: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={['rounded-card px-4 py-4 ring-1 space-y-3', tone].join(' ')}>
      {/* Header */}
      <div className="flex items-start gap-2">
        <Icon icon={headerIcon} size="sm" className="mt-px shrink-0" />
        <div className="flex-1">
          <p className="text-[13px] font-semibold">
            {request.status === 'released'
              ? 'Nachzahlung freigegeben'
              : request.status === 'funded'
                ? 'Nachzahlung bezahlt — Auszahlung läuft'
                : request.status === 'paid'
                  ? 'Nachzahlung erhalten'
                  : request.status === 'waived'
                    ? 'Nachzahlung erlassen'
                    : request.status === 'funding_initiated'
                      ? 'Zahlung wird verarbeitet'
                      : 'Nachzahlung erforderlich'}
          </p>
          <p className="mt-0.5 text-[12px] opacity-75">
            Status: {statusLabel}
          </p>
        </div>
        <span className="text-[15px] font-bold">{amountLabel}</span>
      </div>

      {/* Explanation for non-terminal states */}
      {!isTerminal && (
        <p className="text-[12px] leading-relaxed opacity-80">
          Die ursprüngliche Zahlung ist bereits gesichert.
          Der Nachtragsbetrag von <strong>{amountLabel}</strong> muss separat
          beglichen werden.
        </p>
      )}

      <InlineFeedback error={error} onDismiss={() => setError(null)} />

      {/* Customer: "Jetzt bezahlen" CTA → SupplementaryFundingScreen */}
      {!isCraftsman && canFund && (
        <Link
          to={`/supplementary-funding/${request.id}`}
          className="block w-full rounded-card bg-emerald-600 px-4 py-2.5 text-center text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98]"
          data-testid="supplementary-pay-now"
        >
          {amountLabel} jetzt bezahlen
        </Link>
      )}

      {/* Customer: acknowledge (if they want to confirm awareness before paying) */}
      {!isCraftsman && request.status === 'pending' && (
        <button
          type="button"
          onClick={() => void handleAcknowledge()}
          disabled={busy}
          className="w-full rounded-card border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="acknowledge-supplementary-payment"
        >
          {busy ? 'Wird gespeichert…' : 'Erst zur Kenntnis nehmen'}
        </button>
      )}

      {/* Craftsman: mark paid or waive (blocked during funding_initiated/funded — Stripe payment in-flight or collected) */}
      {isCraftsman && !isTerminal && request.status !== 'funding_initiated' && request.status !== 'funded' && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void handleMarkPaid()}
            disabled={busy}
            className="w-full rounded-card bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="mark-supplementary-payment-paid"
          >
            {busy ? 'Wird gespeichert…' : `Eingang von ${amountLabel} bestätigen`}
          </button>
          <button
            type="button"
            onClick={() => void handleWaive()}
            disabled={busy}
            className="w-full rounded-card border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="waive-supplementary-payment"
          >
            {busy ? 'Wird gespeichert…' : 'Nachzahlung erlassen'}
          </button>
        </div>
      )}

      {/* Timestamps */}
      {request.acknowledgedAt && (
        <p className="text-[11px] text-slate-400">
          Bestätigt: {new Date(request.acknowledgedAt).toLocaleDateString('de-DE')}
        </p>
      )}
      {request.fundingInitiatedAt && (
        <p className="text-[11px] text-slate-400">
          Zahlung gestartet: {new Date(request.fundingInitiatedAt).toLocaleDateString('de-DE')}
        </p>
      )}
      {request.fundedAt && (
        <p className="text-[11px] text-slate-400">
          Bezahlt (Plattform): {new Date(request.fundedAt).toLocaleDateString('de-DE')}
        </p>
      )}
      {request.releasedAt && (
        <p className="text-[11px] text-slate-400">
          Ausgezahlt: {new Date(request.releasedAt).toLocaleDateString('de-DE')}
        </p>
      )}
      {request.paidAt && (
        <p className="text-[11px] text-slate-400">
          Eingang bestätigt: {new Date(request.paidAt).toLocaleDateString('de-DE')}
        </p>
      )}
      {request.waivedAt && (
        <p className="text-[11px] text-slate-400">
          Erlassen: {new Date(request.waivedAt).toLocaleDateString('de-DE')}
        </p>
      )}
    </div>
  )
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function ChangeOrderDetailScreen() {
  const { changeOrderId } = useParams<{ changeOrderId: string }>()
  const goBack = useSmartBack('/craftsman/jobs')
  const location = useLocation()
  const { user } = useSession()

  const isCraftsman = location.pathname.startsWith('/craftsman/')

  const [changeOrder, setChangeOrder] = useState<ChangeOrder | undefined>(
    changeOrderId ? getChangeOrderById(changeOrderId) : undefined
  )
  const [loaded, setLoaded] = useState(() => {
    if (changeOrderId && getChangeOrderById(changeOrderId)) return true
    return isChangeOrderRepositoryHydrated()
  })
  const [supplementaryPayment, setSupplementaryPayment] = useState<SupplementaryPaymentRequest | undefined>(
    changeOrderId ? getSupplementaryPaymentByChangeOrderId(changeOrderId) : undefined
  )
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [exportingPdf, setExportingPdf] = useState(false)

  useStoreSubscriptions([
    {
      subscribe: subscribeChangeOrders,
      onChange: () => {
        if (!changeOrderId) return
        const found = getChangeOrderById(changeOrderId)
        setChangeOrder(found)
        if (found || isChangeOrderRepositoryHydrated()) setLoaded(true)
      },
    },
    {
      subscribe: subscribeJobs,
      onChange: () => {
        if (changeOrderId) setChangeOrder(getChangeOrderById(changeOrderId))
      },
    },
    {
      subscribe: subscribeSupplementaryPayments,
      onChange: () => {
        if (changeOrderId) {
          const spr = getSupplementaryPaymentByChangeOrderId(changeOrderId)
          setSupplementaryPayment(spr)
          if (spr) reconcileSupplementaryTimelineEvents(spr)
        }
      },
    },
  ])

  useEffect(() => {
    if (!changeOrderId) return
    const found = getChangeOrderById(changeOrderId)
    setChangeOrder(found)
    if (found || isChangeOrderRepositoryHydrated()) setLoaded(true)
    setSupplementaryPayment(getSupplementaryPaymentByChangeOrderId(changeOrderId))
  }, [changeOrderId])

  if (!changeOrderId) {
    return (
      <AppShell>
        <ScreenNotFound
          entity="Nachtrag"
          backTo={isCraftsman ? '/craftsman/jobs' : '/'}
          backLabel={isCraftsman ? '← Aufträge' : '← Zurück'}
        />
      </AppShell>
    )
  }

  if (!changeOrder && loaded) {
    return (
      <AppShell>
        <ScreenNotFound
          entity="Nachtrag"
          backTo={isCraftsman ? '/craftsman/jobs' : '/'}
          backLabel={isCraftsman ? '← Aufträge' : '← Zurück'}
        />
      </AppShell>
    )
  }

  if (!changeOrder) {
    return (
      <AppShell>
        <ScreenSkeleton eyebrow="Nachtrag" lines={5} />
      </AppShell>
    )
  }

  const job = getJobById(changeOrder.jobId)
  const payment = getPaymentForJobWorkflow(changeOrder.jobId)
  const sourceOffer = changeOrder.sourceOfferId ? getOfferById(changeOrder.sourceOfferId) : null
  const parsed = parseStructuredDescription(changeOrder.description)

  // Role guards for actions
  const canAccept = !isCraftsman && changeOrder.status === 'pending' && user?.id === changeOrder.customerUserId
  const canDecline = !isCraftsman && changeOrder.status === 'pending' && user?.id === changeOrder.customerUserId

  // Delta display
  const deltaLabel = changeOrder.grossTotal != null
    ? (changeOrder.grossTotal >= 0 ? '+' : '') + formatCents(changeOrder.grossTotal)
    : changeOrder.price

  // Current total + delta = new total (for context)
  const currentTotalEuros = payment?.amounts.totalAmount ?? 0
  const deltaEuros = changeOrder.grossTotal != null ? changeOrder.grossTotal / 100 : null
  const newTotalEuros = deltaEuros != null ? currentTotalEuros + deltaEuros : null

  // Payment lock: deposit has already been received — supplementary payment path
  const isPaymentLocked =
    changeOrder.status === 'accepted' &&
    payment != null &&
    payment.state !== 'deposit_required'

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleAccept = async () => {
    if (busy || !user?.id) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await acceptChangeOrderWorkflow(changeOrderId!, user.id)
      if (!result || result.status !== 'accepted') {
        setActionError('Nachtrag konnte nicht angenommen werden.')
      } else {
        setChangeOrder(result)
        // Refresh supplementary payment after accept (may have been created)
        setSupplementaryPayment(getSupplementaryPaymentByChangeOrderId(changeOrderId!))
      }
    } catch (err) {
      setActionError(`Annahme fehlgeschlagen: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDecline = async () => {
    if (busy || !user?.id) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await declineChangeOrderWorkflow(changeOrderId!, user.id)
      if (!result || result.status !== 'declined') {
        setActionError('Nachtrag konnte nicht abgelehnt werden.')
      } else {
        setChangeOrder(result)
      }
    } catch (err) {
      setActionError(`Ablehnung fehlgeschlagen: ${normalizeErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSupplementaryAction = () => {
    setSupplementaryPayment(getSupplementaryPaymentByChangeOrderId(changeOrderId!))
  }

  const handleExportPdf = async () => {
    if (!changeOrder || exportingPdf) return
    setExportingPdf(true)
    setActionError(null)
    try {
      await shareOrDownloadChangeOrderPdf(changeOrder, {
        sourceOffer,
        job,
        customerName: sourceOffer?.conversationId
          ? getThreadByLegacyConversationId(sourceOffer.conversationId)?.displayMetadata
              ?.customerName
          : null,
      })
    } catch (err) {
      setActionError(`PDF konnte nicht erstellt werden: ${normalizeErrorMessage(err)}`)
    } finally {
      setExportingPdf(false)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Back navigation */}
          <button
            type="button"
            onClick={goBack}
            className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
          >
            ← {isCraftsman ? 'Zurück zum Auftrag' : 'Zurück'}
          </button>

          {/* Title + status */}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Nachtrag
              </p>
              <h1 className="mt-0.5 text-[20px] font-bold text-slate-900">
                {deltaLabel}
              </h1>
            </div>
            <StatusBadge status={changeOrder.status} />
          </div>

          {/* Export as PDF — both roles (unconditional, like the offer PDF button) */}
          <button
            type="button"
            onClick={() => void handleExportPdf()}
            disabled={exportingPdf}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-card px-3 py-2 text-[13px] font-semibold text-blue-600 ring-1 ring-blue-200 transition active:scale-[0.98] disabled:opacity-50"
          >
            {exportingPdf ? 'PDF wird erstellt…' : 'Als PDF teilen'}
          </button>

          {/* Job context */}
          {job && (
            <div className="rounded-card bg-slate-50 px-3 py-2 ring-1 ring-edge">
              <p className="text-[11px] text-slate-400">Bezugsauftrag</p>
              <p className="text-[13px] font-semibold text-slate-800">
                {job.title ?? job.description ?? changeOrder.jobId}
              </p>
            </div>
          )}

          {/* Ursprungsbasis */}
          {sourceOffer != null && (
            <div className="rounded-card bg-slate-50 px-3 py-2 ring-1 ring-edge">
              <p className="text-[11px] text-slate-400">Ursprüngliche Auftragsbasis</p>
              {sourceOffer.grossTotal != null ? (
                <p className="text-[13px] font-semibold text-slate-800">
                  {formatCents(sourceOffer.grossTotal)}
                  <span className="ml-1.5 text-[11px] font-normal text-slate-400">(Angebot)</span>
                </p>
              ) : (
                <p className="text-[13px] font-semibold text-slate-500">Ursprungsangebot</p>
              )}
            </div>
          )}

          {/* ChangeOrder details */}
          <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle space-y-3">

            {/* Leistungsänderung */}
            <div>
              <p className="text-[11px] font-semibold text-slate-400">Leistungsänderung</p>
              <p className="mt-1 text-[14px] text-slate-800 leading-relaxed">
                {parsed.leistung}
              </p>
            </div>

            {/* Änderungsursache */}
            {parsed.ursache != null && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-[11px] font-semibold text-slate-400">Änderungsursache</p>
                <p className="mt-1 text-[13px] text-slate-700 leading-relaxed">
                  {parsed.ursache}
                </p>
              </div>
            )}

            {/* Terminauswirkung */}
            <div className="border-t border-slate-100 pt-3">
              <p className="text-[11px] font-semibold text-slate-400">Terminauswirkung</p>
              <p className="mt-1 text-[13px] text-slate-700">
                {parsed.termin ?? 'Keine Angabe'}
              </p>
            </div>

            {/* Delta + new total */}
            <div className="border-t border-slate-100 pt-3">
              <p className="text-[11px] font-semibold text-slate-400">Nachtragsbetrag</p>
              <p className={[
                'mt-1 text-[20px] font-bold',
                (changeOrder.grossTotal ?? 0) >= 0 ? 'text-slate-900' : 'text-rose-700',
              ].join(' ')}>
                {deltaLabel}
              </p>
              {(changeOrder.grossTotal ?? 0) < 0 && (
                <p className="text-[11px] text-rose-600">Minderkosten</p>
              )}
            </div>

            {/* Total context */}
            {newTotalEuros != null && currentTotalEuros > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-[11px] font-semibold text-slate-400">Auswirkung auf Gesamtbetrag</p>
                <div className="mt-1.5 flex items-center gap-2 text-[13px]">
                  <span className="text-slate-500">{formatEuro(currentTotalEuros)}</span>
                  <span className="text-slate-400">{(changeOrder.grossTotal ?? 0) >= 0 ? '+' : '−'}</span>
                  <span className="font-semibold text-slate-700">
                    {formatEuro(Math.abs((changeOrder.grossTotal ?? 0) / 100))}
                  </span>
                  <span className="text-slate-400">=</span>
                  <span className="font-bold text-slate-900">
                    {formatEuro(newTotalEuros)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  {changeOrder.status === 'accepted'
                    ? 'Neuer Gesamtbetrag nach Annahme'
                    : 'Neuer Gesamtbetrag bei Annahme'}
                </p>
              </div>
            )}

            {/* VAT info */}
            {changeOrder.vatRate != null && changeOrder.netTotal != null && (
              <div className="border-t border-slate-100 pt-3 space-y-1">
                <p className="text-[11px] font-semibold text-slate-400">Steuerinfo</p>
                <div className="flex justify-between text-[12px] text-slate-600">
                  <span>Nettobetrag</span>
                  <span>{formatCents(changeOrder.netTotal)}</span>
                </div>
                <div className="flex justify-between text-[12px] text-slate-600">
                  <span>MwSt. ({changeOrder.vatRate} %)</span>
                  <span>
                    {changeOrder.grossTotal != null && changeOrder.netTotal != null
                      ? formatCents(changeOrder.grossTotal - changeOrder.netTotal)
                      : '–'}
                  </span>
                </div>
                <div className="flex justify-between text-[13px] font-semibold text-slate-800">
                  <span>Bruttobetrag</span>
                  <span>{deltaLabel}</span>
                </div>
              </div>
            )}
          </div>

          {/* ── Supplementary Payment Section ──
           * Shows when ChangeOrder is accepted but payment was already locked.
           * Replaces the old static "not yet supported" warning with real runtime truth.
           */}
          {isPaymentLocked && supplementaryPayment && (
            <SupplementaryPaymentSection
              request={supplementaryPayment}
              isCraftsman={isCraftsman}
              onAction={handleSupplementaryAction}
            />
          )}

          {/* Edge case: CO accepted + locked but supplementary request doesn't exist yet
           * (e.g. negative delta, or creation failed). Show informational note only. */}
          {isPaymentLocked && !supplementaryPayment && (changeOrder.grossTotal ?? 0) > 0 && (
            <div className="rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200/60 space-y-1">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-900">
                <Icon icon={AlertTriangle} size="sm" className="shrink-0" />
                Zusatzzahlung ausstehend
              </p>
              <p className="text-[12px] text-amber-800">
                Die Anzahlung für diesen Auftrag ist bereits gesichert.
                Der Nachtragsbetrag von {deltaLabel} muss separat beglichen werden.
                Die Zahlungsanforderung wird geladen…
              </p>
            </div>
          )}

          {/* Feedback */}
          <InlineFeedback error={actionError} onDismiss={() => setActionError(null)} />

          {/* Customer actions: Accept / Decline */}
          {canAccept && (
            <div className="space-y-2">
              <div className="rounded-card bg-slate-50 px-4 py-3 ring-1 ring-edge">
                <p className="text-[13px] font-semibold text-slate-800">
                  Nachtrag annehmen oder ablehnen
                </p>
                <p className="mt-1 text-[12px] text-slate-500">
                  Mit Annahme stimmst du der Änderung zu.
                  Der Handwerker wird benachrichtigt und der Auftragsbetrag wird angepasst.
                  Diese Aktion kann nicht rückgängig gemacht werden.
                </p>
              </div>

              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={busy}
                className="w-full rounded-card bg-emerald-600 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="accept-change-order"
              >
                {busy ? 'Wird verarbeitet…' : 'Nachtrag annehmen'}
              </button>

              {canDecline && (
                <button
                  type="button"
                  onClick={() => void handleDecline()}
                  disabled={busy}
                  className="w-full rounded-card border border-slate-200 bg-white px-4 py-3 text-[14px] font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="decline-change-order"
                >
                  {busy ? 'Wird verarbeitet…' : 'Nachtrag ablehnen'}
                </button>
              )}
            </div>
          )}

          {/* Craftsman view: waiting hint for pending */}
          {isCraftsman && changeOrder.status === 'pending' && (
            <div className="rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200/60">
              <p className="flex items-start gap-1.5 text-[13px] text-amber-800">
                <Icon icon={Clock} size="sm" className="mt-px shrink-0" />
                <span>
                  Wartet auf Kundenentscheidung.
                  Du kannst den Nachtrag über den Auftragsscreen zurückziehen.
                </span>
              </p>
            </div>
          )}

          {/* Timestamps */}
          <div className="space-y-1 text-[11px] text-slate-400">
            <p>Erstellt: {new Date(changeOrder.createdAt).toLocaleDateString('de-DE')}</p>
            {changeOrder.sentAt && (
              <p>Gesendet: {new Date(changeOrder.sentAt).toLocaleDateString('de-DE')}</p>
            )}
            {changeOrder.acceptedAt && (
              <p>Angenommen: {new Date(changeOrder.acceptedAt).toLocaleDateString('de-DE')}</p>
            )}
            {changeOrder.declinedAt && (
              <p>Abgelehnt: {new Date(changeOrder.declinedAt).toLocaleDateString('de-DE')}</p>
            )}
          </div>

        </div>
      </section>
    </AppShell>
  )
}
