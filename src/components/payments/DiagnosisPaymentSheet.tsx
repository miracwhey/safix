/**
 * DiagnosisPaymentSheet — In-app Stripe payment form for diagnosis instant-payments.
 *
 * Renders inline within the QuoteDetailView when a diagnosis offer is accepted
 * and the customer still needs to complete the payment.
 *
 * State machine:
 *   idle           → "Jetzt bezahlen" button visible
 *   initiating     → loading clientSecret from /api/initiate-diagnosis-payment
 *   form-ready     → Stripe PaymentElement mounted
 *   submitting     → stripe.confirmPayment() in progress
 *   confirming     → Stripe confirmed, waiting for server/webhook reconciliation
 *   success        → payment confirmed by server
 *   error          → retryable error shown
 */

import { useState, useCallback } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import { initiateDiagnosisPayment } from '../../lib/payments/diagnosisPaymentClient'
import { DIAGNOSIS_FEE_PERCENT } from '../../lib/payments'
import { getActivePaymentProviderName } from '../../lib/payments'
import { formatEuro } from '../../lib/shared/formatters'
import { getPublicWebOrigin } from '../../lib/platform'

// ---------------------------------------------------------------------------
// Stripe singleton
// ---------------------------------------------------------------------------

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined

const stripePromise =
  stripePublishableKey ? loadStripe(stripePublishableKey) : null

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | 'idle'
  | 'initiating'
  | 'form-ready'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'error'

type Props = {
  /** The diagnosis Job ID (from offer.createdJobId). */
  jobId: string
  /** Total diagnosis fee displayed to the customer. */
  totalAmount: number
}

// ---------------------------------------------------------------------------
// Stripe inner form (must live inside <Elements>)
// ---------------------------------------------------------------------------

function StripePaymentForm({
  onConfirming,
  onError,
  onCancel,
}: {
  onConfirming: () => void
  onError: (msg: string) => void
  onCancel: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(async () => {
    if (!stripe || !elements) return
    setSubmitting(true)
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          // FIX (P1 #321): never use window.location.href — inside the Capacitor
          // native shell that resolves to capacitor://localhost, which Stripe
          // cannot redirect back to. Use the public hosted PWA origin instead.
          // (With redirect: 'if_required' + card-only this is only hit if Stripe
          // forces a redirect, but it must still be a reachable public URL.)
          return_url: getPublicWebOrigin(),
        },
        redirect: 'if_required',
      })
      if (error) {
        onError(error.message ?? 'Zahlung fehlgeschlagen. Bitte erneut versuchen.')
      } else {
        // Stripe confirmed — enter intermediate state while waiting for
        // server/webhook reconciliation to update the payment record.
        onConfirming()
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Unbekannter Fehler.')
    } finally {
      setSubmitting(false)
    }
  }, [stripe, elements, onConfirming, onError])

  return (
    <div>
      <PaymentElement />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={submitting || !stripe}
          onClick={handleSubmit}
          className="flex-1 rounded-2xl bg-purple-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? 'Wird verarbeitet …' : 'Jetzt bezahlen'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="rounded-2xl bg-surface px-4 py-2.5 text-[13px] font-medium text-ink-sub ring-1 ring-edge disabled:opacity-50"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mock confirm button (mock payment provider)
// ---------------------------------------------------------------------------

function MockPaymentForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl bg-amber-50 px-3 py-3 ring-1 ring-amber-200/80">
      <p className="text-[12px] text-amber-700">
        Demo-Modus — kein echter Stripe-Charge.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onSuccess}
          className="flex-1 rounded-2xl bg-purple-600 px-4 py-2.5 text-[13px] font-semibold text-white"
        >
          Zahlung simulieren
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-2xl bg-surface px-4 py-2.5 text-[13px] font-medium text-ink-sub ring-1 ring-edge"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DiagnosisPaymentSheet({ jobId, totalAmount }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providerName = getActivePaymentProviderName()
  const isMock = providerName === 'mock'

  const feeAmount = Math.round(totalAmount * DIAGNOSIS_FEE_PERCENT) / 100
  const netAmount = totalAmount - feeAmount

  const handleStartPayment = useCallback(async () => {
    setPhase('initiating')
    setError(null)

    if (isMock) {
      // Mock provider: skip API call, go straight to form
      setClientSecret('mock')
      setPhase('form-ready')
      return
    }

    const result = await initiateDiagnosisPayment(jobId)
    if (!result.ok) {
      setError(result.message)
      setPhase('error')
      return
    }
    if (result.outcome === 'ALREADY_COMPLETED') {
      setPhase('success')
      return
    }
    if (!result.clientSecret) {
      setError('Fehler: kein clientSecret vom Server erhalten.')
      setPhase('error')
      return
    }
    setClientSecret(result.clientSecret)
    setPhase('form-ready')
  }, [jobId, isMock])

  const handleConfirming = useCallback(() => {
    setPhase('confirming')
  }, [])

  const handleError = useCallback((msg: string) => {
    setError(msg)
    setPhase('error')
  }, [])

  const handleCancel = useCallback(() => {
    setPhase('idle')
    setClientSecret(null)
    setError(null)
  }, [])

  if (phase === 'confirming') {
    return (
      <div
        className="mt-3 rounded-2xl bg-purple-50 px-4 py-3 ring-1 ring-purple-200/80"
        data-testid="diagnosis-payment-confirming"
      >
        <p className="text-[13px] font-semibold text-purple-800">
          Zahlung wird bestätigt …
        </p>
        <p className="mt-0.5 text-[11px] text-purple-600">
          Die Zahlung wurde von Stripe angenommen und wird vom Server bestätigt.
          Falls die Bestätigung länger dauert, kannst du die Seite neu laden —
          der Zahlungsstatus wird automatisch aktualisiert.
        </p>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div
        className="mt-3 rounded-2xl bg-purple-50 px-4 py-3 ring-1 ring-purple-200/80"
        data-testid="diagnosis-payment-success"
      >
        <p className="text-[13px] font-semibold text-purple-800">
          ✓ Diagnose-Zahlung abgeschlossen
        </p>
        <p className="mt-0.5 text-[11px] text-purple-600">
          Der Handwerker erhält die Bestätigung zur Durchführung des Diagnose-Einsatzes.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-3" data-testid="diagnosis-payment-sheet">
      {/* Fee breakdown */}
      <div className="mb-3 rounded-[14px] bg-purple-50 px-3 py-2.5 ring-1 ring-purple-200/60">
        <p className="text-[12px] font-semibold text-purple-800">
          💳 Diagnose-Sofortzahlung
        </p>
        <div className="mt-1.5 space-y-0.5 text-[11px] text-purple-700">
          <div className="flex justify-between">
            <span>Diagnose-Fee</span>
            <span className="font-medium">{formatEuro(totalAmount)}</span>
          </div>
          <div className="flex justify-between text-purple-500">
            <span>Plattformgebühr ({DIAGNOSIS_FEE_PERCENT} %)</span>
            <span>− {formatEuro(feeAmount)}</span>
          </div>
          <div className="flex justify-between border-t border-purple-200/80 pt-0.5 font-semibold text-purple-800">
            <span>Handwerker erhält</span>
            <span>{formatEuro(netAmount)}</span>
          </div>
        </div>
      </div>

      {/* Idle: CTA button */}
      {phase === 'idle' && (
        <button
          type="button"
          onClick={handleStartPayment}
          className="w-full rounded-2xl bg-purple-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-subtle transition active:scale-[0.98]"
          data-testid="diagnosis-payment-start"
        >
          Diagnose-Einsatz jetzt bezahlen
        </button>
      )}

      {/* Initiating: loading */}
      {phase === 'initiating' && (
        <button
          type="button"
          disabled
          className="w-full rounded-2xl bg-purple-600 px-4 py-2.5 text-[13px] font-semibold text-white opacity-60"
        >
          Zahlungsformular wird geladen …
        </button>
      )}

      {/* Form ready: show Stripe PaymentElement or mock */}
      {phase === 'form-ready' && (
        <>
          {isMock || !stripePromise ? (
            <MockPaymentForm onSuccess={handleConfirming} onCancel={handleCancel} />
          ) : (
            clientSecret && (
              <Elements
                stripe={stripePromise}
                options={{ clientSecret, locale: 'de' }}
              >
                <StripePaymentForm
                  onConfirming={handleConfirming}
                  onError={handleError}
                  onCancel={handleCancel}
                />
              </Elements>
            )
          )}
        </>
      )}

      {/* Error */}
      {(phase === 'error') && error && (
        <div className="mt-2">
          <p className="text-[12px] text-red-600">{error}</p>
          <button
            type="button"
            onClick={handleCancel}
            className="mt-1 text-[12px] font-medium text-purple-700"
          >
            Zurück
          </button>
        </div>
      )}
    </div>
  )
}
