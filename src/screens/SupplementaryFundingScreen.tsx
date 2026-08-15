/**
 * SupplementaryFundingScreen — Stripe-backed payment for supplementary amounts
 *
 * Dedicated screen for paying the delta amount from an accepted ChangeOrder
 * (Nachtrag) when the original escrow was already locked.
 *
 * Route: /supplementary-funding/:supplementaryPaymentId
 *
 * Flow:
 *   1. Load supplementary payment request from local store
 *   2. Customer clicks "Jetzt bezahlen" → initiate-supplementary-funding API
 *   3. Stripe Elements renders PaymentElement with clientSecret
 *   4. Customer submits → stripe.confirmPayment()
 *   5. On success → confirm-supplementary-funding API
 *      a. Server OK  → phase 'success'
 *      b. Server !OK → phase 'server-confirming' (webhook will reconcile)
 *
 * Reload-safe: re-entering after funding_initiated resumes the existing intent.
 * Already-funded requests show a success state without a payment form.
 */

import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useSmartBack } from '../hooks/useSmartBack'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenNotFound from '../components/system/ScreenNotFound'
import InlineFeedback from '../components/system/InlineFeedback'
import {
  getSupplementaryPaymentById,
  subscribeSupplementaryPayments,
  isSupplementaryPaymentRepositoryHydrated,
  canInitiateSupplementaryFunding,
  reconcileSupplementaryTimelineEvents,
} from '../lib/payments/supplementary'
import { ensureTimelineEvent } from '../lib/timeline'
import type { SupplementaryPaymentRequest } from '../lib/payments/supplementary'
import { initiateSupplementaryFunding } from '../lib/funding/initiateSupplementaryFundingApi'
import type { AttributionBlockInfo } from '../lib/commercialAttribution/attributionBlockUi'
import { confirmSupplementaryFunding } from '../lib/funding/confirmSupplementaryFundingApi'
import { formatCents } from '../lib/shared/formatters'
import { normalizeErrorMessage } from '../lib/diagnostics'
import { getPublicWebOrigin } from '../lib/platform'
import { useStoreSubscriptions } from '../lib/reactive'

// ── Stripe singleton ──────────────────────────────────────────────────────────

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
const stripePromise = stripePublishableKey ? loadStripe(stripePublishableKey) : null

// ── Payment phases ────────────────────────────────────────────────────────────

type PaymentPhase =
  | 'idle'                    // Ready to start — "Jetzt bezahlen" button visible
  | 'preparing'               // API call to create PaymentIntent in flight
  | 'form-ready'              // Stripe PaymentElement mounted
  | 'confirming'              // stripe.confirmPayment() in flight
  | 'server-confirming'       // Stripe OK, server confirm failed — webhook will reconcile
  | 'success'                 // Payment completed and server-confirmed
  | 'already-funded'          // Request was already funded, released, or paid
  | 'waived'                  // Craftsman waived this supplementary request
  | 'attribution-blocked'     // Server 402 — commercial attribution not finalized / dlq / invalid
  | 'error'                   // Recoverable error

// ── Inner form component (inside Stripe Elements provider) ────────────────────

function SupplementaryPaymentForm({
  request,
  paymentIntentId,
  onSuccess,
  onPendingConfirm,
  onError,
}: {
  request: SupplementaryPaymentRequest
  paymentIntentId: string
  onSuccess: () => void
  onPendingConfirm: () => void
  onError: (msg: string) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const amountLabel = formatCents(request.amountCents)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements || submitting) return

    setSubmitting(true)

    try {
      const { error: stripeError } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${getPublicWebOrigin()}/supplementary-funding/${request.id}`,
        },
        redirect: 'if_required',
      })

      if (stripeError) {
        onError(stripeError.message ?? 'Stripe-Zahlung fehlgeschlagen.')
        setSubmitting(false)
        return
      }

      // Stripe succeeded — confirm on server
      const confirmResult = await confirmSupplementaryFunding({
        paymentIntentId,
        supplementaryPaymentId: request.id,
      })

      // Emit timeline event for funded state — server updated DB but client
      // service layer was bypassed, so ensureTimelineEvent in the service
      // function never fired.  Direct emission here covers the active flow.
      ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_funded' })

      if (confirmResult.ok) {
        onSuccess()
      } else {
        // Stripe payment succeeded but server confirm failed.
        // Webhook will reconcile the store to 'funded' — the subscription
        // in SupplementaryFundingScreen transitions phase to 'success' when
        // the store status reaches funded/released/paid.
        onPendingConfirm()
      }
    } catch (err) {
      onError(normalizeErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <PaymentElement />
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="w-full rounded-card bg-emerald-600 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="supplementary-pay-submit"
      >
        {submitting ? 'Wird verarbeitet…' : `${amountLabel} jetzt bezahlen`}
      </button>
    </form>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SupplementaryFundingScreen() {
  const { supplementaryPaymentId } = useParams<{ supplementaryPaymentId: string }>()
  const navigate = useNavigate()
  const goBack = useSmartBack('/')

  const [request, setRequest] = useState<SupplementaryPaymentRequest | undefined>(
    supplementaryPaymentId ? getSupplementaryPaymentById(supplementaryPaymentId) : undefined
  )
  const [loaded, setLoaded] = useState(() => {
    if (supplementaryPaymentId && getSupplementaryPaymentById(supplementaryPaymentId)) return true
    return isSupplementaryPaymentRepositoryHydrated()
  })

  const [phase, setPhase] = useState<PaymentPhase>(() => {
    const initial = supplementaryPaymentId ? getSupplementaryPaymentById(supplementaryPaymentId) : undefined
    if (initial) {
      if (initial.status === 'funded' || initial.status === 'released' || initial.status === 'paid') return 'already-funded'
      if (initial.status === 'waived') return 'waived'
    }
    return 'idle'
  })
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attributionBlock, setAttributionBlock] = useState<AttributionBlockInfo | null>(null)

  // ── server-confirming timeout ────────────────────────────────────────────
  // After 45 s without webhook resolution the card switches to a timeout
  // message that makes clear (a) the Stripe charge is already secured and
  // (b) the user can safely leave.  Timer resets whenever phase changes.
  const [serverConfirmTimedOut, setServerConfirmTimedOut] = useState(false)

  useEffect(() => {
    if (phase !== 'server-confirming') return
    const timer = setTimeout(() => setServerConfirmTimedOut(true), 45_000)
    return () => {
      clearTimeout(timer)
      setServerConfirmTimedOut(false)
    }
  }, [phase])

  // ── Store subscriptions ──────────────────────────────────────────────────
  useStoreSubscriptions([
    {
      subscribe: subscribeSupplementaryPayments,
      onChange: () => {
        if (!supplementaryPaymentId) return
        const found = getSupplementaryPaymentById(supplementaryPaymentId)
        setRequest(found)
        if (found || isSupplementaryPaymentRepositoryHydrated()) setLoaded(true)

        if (!found) return

        // Craftsman waived the request — transition immediately regardless of
        // current phase so the phase is never left in a conflicting state.
        if (found.status === 'waived') {
          setPhase('waived')
          return
        }

        // React to external status changes (webhook reconciliation or server confirm).
        // This is the authoritative transition out of 'server-confirming'.
        if (found.status === 'funded' || found.status === 'released' || found.status === 'paid') {
          reconcileSupplementaryTimelineEvents(found)
          setPhase('success')
        }
      },
    },
  ])

  // ── Initiate payment ─────────────────────────────────────────────────────
  const jobId = request?.jobId

  const handleInitiate = useCallback(async () => {
    if (!supplementaryPaymentId || phase === 'preparing') return
    setPhase('preparing')
    setError(null)
    setAttributionBlock(null)

    try {
      const result = await initiateSupplementaryFunding(supplementaryPaymentId)

      if (result.ok && result.outcome === 'PAYMENT_ALREADY_FUNDED') {
        setPhase('already-funded')
        return
      }

      if (result.ok && (result.outcome === 'PAYMENT_FORM_READY' || result.outcome === 'PAYMENT_RETRY_READY')) {
        setClientSecret(result.data.clientSecret)
        setPaymentIntentId(result.data.paymentIntentId)
        setPhase('form-ready')
        // Emit timeline event — server wrote funding_initiated to DB but
        // client service layer was bypassed (API wrapper, not service fn).
        if (jobId) {
          ensureTimelineEvent({ jobId, type: 'supplementary_funding_initiated' })
        }
        return
      }

      if (!result.ok) {
        // Attribution-block 402 → distinct phase so the UI can render a
        // fachlichen Zustand (retry hint for unresolved/lookup_failed,
        // Support-CTA for dlq/invalid) instead of a generic error toast.
        if (result.attributionBlock) {
          setAttributionBlock(result.attributionBlock)
          setPhase('attribution-blocked')
          return
        }
        setError(result.message)
        setPhase('error')
        return
      }

      // Unexpected but valid response shape — guards against future API drift.
      setError('Unerwartete Serverantwort. Bitte erneut versuchen.')
      setPhase('error')
    } catch (err) {
      setError(normalizeErrorMessage(err))
      setPhase('error')
    }
  }, [supplementaryPaymentId, phase, jobId])

  // ── Render guards ────────────────────────────────────────────────────────

  if (!supplementaryPaymentId) {
    return (
      <AppShell>
        <ScreenNotFound entity="Nachzahlung" backTo="/" backLabel="← Zurück" />
      </AppShell>
    )
  }

  if (!request && loaded) {
    return (
      <AppShell>
        <ScreenNotFound entity="Nachzahlung" backTo="/" backLabel="← Zurück" />
      </AppShell>
    )
  }

  if (!request) {
    return (
      <AppShell>
        <ScreenSkeleton eyebrow="Nachzahlung" lines={4} />
      </AppShell>
    )
  }

  const amountLabel = formatCents(request.amountCents)

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Back navigation */}
          <button
            type="button"
            onClick={() => navigate(`/nachtrag/${request.changeOrderId}`)}
            className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
          >
            ← Zurück zum Nachtrag
          </button>

          {/* Header */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Nachzahlung
            </p>
            <h1 className="mt-0.5 text-[20px] font-bold text-slate-900">
              {amountLabel}
            </h1>
          </div>

          {/* Trust signal */}
          <div className="flex items-center gap-2 rounded-card bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200/60">
            <span className="text-[14px]">🔒</span>
            <p className="text-[13px] text-emerald-800">
              Sichere Zahlung über die SaFix-Plattform via Stripe.
            </p>
          </div>

          {/* ── Success state ── */}
          {(phase === 'success' || phase === 'already-funded') && (
            <div className="rounded-card bg-emerald-50 px-4 py-4 ring-1 ring-emerald-200/60 space-y-2">
              <p className="text-[15px] font-semibold text-emerald-900">
                ✅ Nachzahlung erfolgreich
              </p>
              <p className="text-[13px] text-emerald-800">
                Die Nachzahlung über {amountLabel} wurde erfolgreich verarbeitet.
              </p>
              <button
                type="button"
                onClick={() => navigate(`/nachtrag/${request.changeOrderId}`)}
                className="mt-2 w-full rounded-card bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              >
                Zurück zum Nachtrag
              </button>
            </div>
          )}

          {/* ── Server-confirming state ──
           *
           * Stripe payment succeeded but the server confirm call failed or
           * timed out.  Webhook reconciliation is running — the store
           * subscription transitions phase to 'success' once the DB row
           * reaches funded / released / paid.
           *
           * Two sub-states:
           *   normal   — payment secured at Stripe, confirmation in progress
           *   timed out (45 s) — explicit message: safe to leave, still processing
           *
           * Both sub-states show a full-width "Zurück zum Nachtrag" CTA so the
           * user always has a clear, prominent exit regardless of wait time.
           */}
          {phase === 'server-confirming' && (
            <div className="rounded-card bg-blue-50 px-4 py-4 ring-1 ring-blue-200/60 space-y-3">
              {serverConfirmTimedOut ? (
                <>
                  <p className="text-[15px] font-semibold text-blue-900">
                    ⚠️ Bestätigung dauert länger als erwartet
                  </p>
                  <p className="text-[13px] text-blue-800">
                    Die Zahlung über {amountLabel} ist bei Stripe bereits gesichert — dein Geld ist sicher.
                    Die Plattformbestätigung läuft noch im Hintergrund. Du kannst diese Seite jetzt verlassen.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[15px] font-semibold text-blue-900">
                    ⏳ Zahlung wird bestätigt
                  </p>
                  <p className="text-[13px] text-blue-800">
                    Die Zahlung über {amountLabel} ist bei Stripe bereits gesichert.
                    Die Plattformbestätigung läuft — das dauert meist nur wenige Sekunden.
                  </p>
                </>
              )}
              <button
                type="button"
                onClick={() => navigate(`/nachtrag/${request.changeOrderId}`)}
                className="w-full rounded-card bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.98]"
              >
                Zurück zum Nachtrag
              </button>
            </div>
          )}

          {/* ── Idle state: "Jetzt bezahlen" CTA ── */}
          {phase === 'idle' && canInitiateSupplementaryFunding(request.status) && (
            <div className="space-y-3">
              <div className="rounded-card bg-slate-50 px-4 py-3 ring-1 ring-edge">
                <p className="text-[13px] font-semibold text-slate-800">
                  Zusatzbetrag aus Nachtrag
                </p>
                <p className="mt-1 text-[12px] text-slate-500">
                  Die ursprüngliche Zahlung ist bereits gesichert.
                  Der Nachtragsbetrag von <strong>{amountLabel}</strong> muss separat
                  über die Plattform bezahlt werden.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleInitiate()}
                className="w-full rounded-card bg-emerald-600 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98]"
                data-testid="supplementary-pay-initiate"
              >
                {amountLabel} jetzt bezahlen
              </button>
            </div>
          )}

          {/* ── Preparing state ── */}
          {phase === 'preparing' && (
            <div className="rounded-card bg-slate-50 px-4 py-4 ring-1 ring-edge text-center">
              <p className="text-[13px] text-slate-600">Zahlung wird vorbereitet…</p>
            </div>
          )}

          {/* ── Stripe form ── */}
          {phase === 'form-ready' && clientSecret && stripePromise && (
            <Elements
              stripe={stripePromise}
              options={{ clientSecret, locale: 'de' }}
            >
              <SupplementaryPaymentForm
                request={request}
                paymentIntentId={paymentIntentId!}
                onSuccess={() => setPhase('success')}
                onPendingConfirm={() => setPhase('server-confirming')}
                onError={(msg) => {
                  setError(msg)
                  setPhase('error')
                }}
              />
            </Elements>
          )}

          {/* ── No Stripe key configured ── */}
          {phase === 'form-ready' && !stripePromise && (
            <div className="rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200/60">
              <p className="text-[13px] text-amber-800">
                Stripe-Zahlungen sind nicht konfiguriert. Bitte kontaktiere den Support.
              </p>
            </div>
          )}

          {/* ── Error state ── */}
          {phase === 'error' && (
            <div className="space-y-3">
              <InlineFeedback error={error} onDismiss={() => setError(null)} />
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setPhase('idle')
                }}
                className="w-full rounded-card border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          {/* ── Attribution-block state ──
           *   Dedicated UI for 402-Attribution responses. Copy + retry
           *   decision are driven by the shared attributionBlockUi mapper.
           *   Retry is offered ONLY when the block is retryable — dlq /
           *   invalid / job_not_found show a support/dismiss CTA instead.
           */}
          {phase === 'attribution-blocked' && attributionBlock && (
            <div
              className="rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200 space-y-2"
              data-testid="attribution-block-card"
            >
              <h3 className="text-[14px] font-semibold text-amber-900">
                {attributionBlock.title}
              </h3>
              <p className="text-[13px] leading-relaxed text-amber-900/90">
                {attributionBlock.message}
              </p>
              {attributionBlock.cta && attributionBlock.cta.action === 'retry' && (
                <button
                  type="button"
                  onClick={() => {
                    setAttributionBlock(null)
                    setPhase('idle')
                    void handleInitiate()
                  }}
                  className="w-full rounded-card bg-amber-600 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-amber-700"
                  data-testid="attribution-block-retry"
                >
                  {attributionBlock.cta.label}
                </button>
              )}
              {attributionBlock.cta && attributionBlock.cta.action === 'support' && (
                <a
                  href="mailto:team@safix.digital"
                  className="block text-center rounded-card border border-amber-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-amber-800 transition hover:bg-amber-50"
                  data-testid="attribution-block-support"
                >
                  {attributionBlock.cta.label}
                </a>
              )}
              {attributionBlock.cta && attributionBlock.cta.action === 'dismiss' && (
                <button
                  type="button"
                  onClick={goBack}
                  className="w-full rounded-card border border-amber-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-amber-800 transition hover:bg-amber-50"
                  data-testid="attribution-block-dismiss"
                >
                  {attributionBlock.cta.label}
                </button>
              )}
            </div>
          )}

          {/* ── Waived state ──
           * Rendered only when phase === 'waived' — set from initial request
           * status on mount, or via Realtime subscription when the craftsman
           * waives during an open session.  Never concurrent with other phases.
           */}
          {phase === 'waived' && (
            <div className="rounded-card bg-slate-50 px-4 py-3 ring-1 ring-edge">
              <p className="text-[13px] text-slate-600">
                ↩️ Diese Nachzahlung wurde vom Handwerker erlassen.
              </p>
            </div>
          )}

        </div>
      </section>
    </AppShell>
  )
}
