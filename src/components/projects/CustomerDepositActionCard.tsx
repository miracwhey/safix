import { useState, useCallback } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import {
  getPaymentForJob,
  subscribePayments,
  getActivePaymentProviderName,
} from '../../lib/payments'
import {
  createEscrowWorkflow,
  confirmDepositWorkflow,
  lockEscrowWorkflow,
} from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'
import { useSession } from '../../hooks/useSession'
import { deriveCustomerDepositAction } from '../../lib/jobs/customerDepositSelectors'
import type { CustomerDepositViewModel } from '../../lib/jobs/customerDepositSelectors'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'
import DiagnosticDebugBlock from '../DiagnosticDebugBlock'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../../lib/diagnostics'

// ---------------------------------------------------------------------------
// Stripe singleton — loaded lazily and only when the publishable key is set.
// Never initialise Stripe with an empty / undefined key.
// ---------------------------------------------------------------------------

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined

const stripePromise =
  stripePublishableKey ? loadStripe(stripePublishableKey) : null

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  jobId: string
}

// ---------------------------------------------------------------------------
// Stripe payment sub-form (must live inside an <Elements> context)
// ---------------------------------------------------------------------------

function StripePaymentForm({
  onSuccess,
  onError,
}: {
  onSuccess: () => void
  onError: (msg: string) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setIsSubmitting(true)
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // Used only for redirect-based payment methods (e.g. 3D Secure redirect).
        return_url: window.location.href,
      },
      redirect: 'if_required',
    })

    if (error) {
      // Stripe card errors (e.g. "Your card number is incomplete") are returned
      // in English. We show a fixed German fallback instead of the raw Stripe message.
      onError('Zahlung fehlgeschlagen. Bitte prüfe deine Kartendaten und versuche es erneut.')
      setIsSubmitting(false)
      return
    }

    // PaymentIntent with capture_method:'manual' ends in 'requires_capture' after
    // the customer authorises.  Any terminal success status is acceptable here.
    if (
      paymentIntent?.status === 'requires_capture' ||
      paymentIntent?.status === 'succeeded'
    ) {
      onSuccess()
    } else {
      onError('Zahlung fehlgeschlagen. Bitte versuche es erneut.')
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <PaymentElement />
      <button
        type="submit"
        disabled={!stripe || !elements || isSubmitting}
        className="w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
      >
        {isSubmitting ? 'Zahlung wird verarbeitet …' : '🔒 Jetzt bezahlen'}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Pure view
// ---------------------------------------------------------------------------

function CustomerDepositActionCardView({
  vm,
  providerName,
  clientSecret,
  onStartPayment,
  onMockConfirm,
  onStripeSuccess,
  onStripeError,
  isPending,
  error,
  debugInfo,
}: {
  vm: CustomerDepositViewModel
  providerName: 'mock' | 'stripe'
  clientSecret: string | null
  onStartPayment: () => void
  onMockConfirm: () => void
  onStripeSuccess: () => void
  onStripeError: (msg: string) => void
  isPending: boolean
  error?: string | null
  debugInfo: RuntimeDiagnostic | null
}) {
  const isActionRequired = vm.customerActionRequired
  const isDepositPaid = vm.phase === 'deposit_paid'
  const isBeyond = vm.phase === 'beyond_deposit'
  const isNotPrepared = vm.phase === 'not_prepared'

  // Whether the escrow has been created but the customer hasn't paid yet
  const isAwaitingPayment = isActionRequired && clientSecret !== null

  // Accent colours per phase
  const accentClass = isActionRequired
    ? 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
    : isDepositPaid
    ? 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300'
    : 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200'

  const ringClass = isActionRequired
    ? 'ring-1 ring-amber-200/80'
    : isDepositPaid
    ? 'ring-1 ring-emerald-200/80'
    : 'ring-1 ring-slate-200/70'

  return (
    <section
      className={[
        'relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]',
        ringClass,
      ].join(' ')}
    >
      {/* Left accent bar */}
      <div
        className={[
          'pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px]',
          accentClass,
        ].join(' ')}
      />

      {/* Eyebrow + badge */}
      <div className="flex items-center gap-2">
        <div
          className={[
            'text-[12px] font-semibold uppercase tracking-[0.18em]',
            isActionRequired
              ? 'text-amber-600'
              : isDepositPaid
              ? 'text-emerald-600'
              : 'text-slate-400',
          ].join(' ')}
        >
          Zahlung
        </div>
        {isActionRequired && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
            HANDLUNG ERFORDERLICH
          </span>
        )}
        {isDepositPaid && (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-emerald-700 ring-1 ring-emerald-200">
            BESTÄTIGT
          </span>
        )}
        {isBeyond && (
          <span className="inline-flex items-center rounded-full bg-slate-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-slate-500 ring-1 ring-slate-200">
            GESICHERT
          </span>
        )}
      </div>

      {/* Icon + title */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={[
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
            isActionRequired
              ? 'bg-amber-500'
              : isDepositPaid
              ? 'bg-emerald-600'
              : 'bg-slate-400',
          ].join(' ')}
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">
            {isActionRequired ? '💳' : isDepositPaid ? '✅' : isBeyond ? '🔒' : '⏳'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {vm.phaseLabel}
          </h2>
        </div>
      </div>

      {/* Phase description */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        {vm.phaseDescription}
      </p>

      {/* Amount breakdown — shown when amounts are known */}
      {vm.agreedAmount !== null && !isNotPrepared && (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            isActionRequired
              ? 'bg-amber-50 ring-amber-100'
              : isDepositPaid
              ? 'bg-emerald-50 ring-emerald-100'
              : 'bg-slate-50 ring-slate-100',
          ].join(' ')}
        >
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Zahlungsübersicht
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-slate-500">Gesamtbetrag</span>
              <span className="text-[13px] font-semibold text-slate-700">
                {vm.agreedAmountFormatted}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-slate-500">
                Zahlung (100&thinsp;%)
              </span>
              <span
                className={[
                  'text-[13px] font-semibold',
                  isActionRequired ? 'text-amber-700' : 'text-slate-700',
                ].join(' ')}
              >
                {vm.depositAmountFormatted}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 pt-1.5">
              <span className="text-[13px] text-slate-500">Restbetrag</span>
              <span className="text-[13px] font-semibold text-slate-700">
                {vm.remainingAmountFormatted}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Payment action area — only shown when customer action is required   */}
      {/* ------------------------------------------------------------------ */}

      {isActionRequired && (
        <>
          {/* Step 1: no escrow created yet → "Start payment" button */}
          {!isAwaitingPayment && (
            <>
              <button
                type="button"
                disabled={isPending}
                onClick={onStartPayment}
                className="mt-4 w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
              >
                {isPending ? 'Wird vorbereitet …' : '💳 Jetzt bezahlen'}
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
                Leiste jetzt die Zahlung, um den Auftrag zu starten. Der
                vollständige Betrag ist bis zur erfolgreichen Abnahme über Stripe abgesichert.
              </p>
            </>
          )}

          {/* Step 2a: escrow created, mock provider → simple confirm button */}
          {isAwaitingPayment && providerName === 'mock' && (
            <>
              <button
                type="button"
                disabled={isPending}
                onClick={onMockConfirm}
                className="mt-4 w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
              >
                {isPending ? 'Wird bestätigt …' : '✓ Zahlung bestätigen (Demo)'}
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
                Demo-Modus: Zahlung wird ohne echte Transaktion bestätigt.
              </p>
            </>
          )}

          {/* Step 2b: escrow created, Stripe provider → Payment Element */}
          {isAwaitingPayment && providerName === 'stripe' && stripePromise && (
            <Elements
              stripe={stripePromise}
              options={{ clientSecret: clientSecret as string, locale: 'de' }}
            >
              <StripePaymentForm
                onSuccess={onStripeSuccess}
                onError={onStripeError}
              />
            </Elements>
          )}

          {/* Stripe configured but no stripePromise (missing publishable key) */}
          {isAwaitingPayment && providerName === 'stripe' && !stripePromise && (
            <p className="mt-4 text-[13px] text-red-500">
              Online-Zahlung ist momentan nicht verfügbar. Bitte versuche es später erneut.
            </p>
          )}

          {error && (
            <p className="mt-2 text-[12px] leading-relaxed text-red-500">
              {error}
            </p>
          )}
          <DiagnosticDebugBlock diagnostic={debugInfo} />
        </>
      )}

      {/* Status callout once deposit is paid */}
      {isDepositPaid && (
        <div className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">✅</span>
            <span className="text-[13px] font-semibold text-emerald-700">
              Zahlung bestätigt
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-emerald-600">
            Deine Einzahlung ist bestätigt. Der Betrag wird über Stripe abgesichert.
          </p>
        </div>
      )}

      {/* Status callout for beyond_deposit */}
      {isBeyond && (
        <div className="mt-4 rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">🔒</span>
            <span className="text-[13px] font-semibold text-slate-700">
              Zahlung gesichert
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            Deine Zahlung ist über Stripe abgesichert und wird nach
            erfolgreicher Abnahme freigegeben.
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * Customer-facing deposit action card shown after proposal acceptance.
 *
 * Derives a `CustomerDepositViewModel` from the job and its associated
 * payment, then renders a phase-aware payment surface:
 *
 * - not_prepared   → waiting for craftsman to initialise the payment card
 * - deposit_required (no clientSecret) → "Jetzt bezahlen" CTA that creates
 *   a provider escrow (Stripe PaymentIntent) and advances to the payment UI
 * - deposit_required (with clientSecret, mock provider) → demo confirm button
 * - deposit_required (with clientSecret, stripe provider) → Stripe Payment
 *   Element; after the customer authorises, SaFix transitions the payment
 *   state via `confirmDepositWorkflow` + `lockEscrowWorkflow`
 * - deposit_paid / beyond_deposit → read-only status callouts
 *
 * Returns null when the job has no accepted proposal.
 */
export default function CustomerDepositActionCard({ jobId }: Props) {
  function buildVm(): CustomerDepositViewModel | null {
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    const fundingStatus = getFundingRequestByJobId(jobId)?.status
    return deriveCustomerDepositAction(job, payment, fundingStatus)
  }

  const { user } = useSession()
  const [vm, setVm] = useState<CustomerDepositViewModel | null>(buildVm)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<RuntimeDiagnostic | null>(null)

  // clientSecret is initialised from any previously-created escrow stored on
  // the payment, so returning customers see the payment UI immediately.
  const [clientSecret, setClientSecret] = useState<string | null>(() => {
    return getPaymentForJob(jobId)?.clientSecret ?? null
  })

  useStoreSync([subscribeJobs, subscribePayments], () => {
    setVm(buildVm())
    // Sync clientSecret in case the payment was updated externally.
    const stored = getPaymentForJob(jobId)?.clientSecret
    if (stored && !clientSecret) {
      setClientSecret(stored)
    }
  })

  const providerName = getActivePaymentProviderName()

  /** Step 1: create the provider escrow (PaymentIntent) and surface the payment UI. */
  const handleStartPayment = useCallback(async () => {
    const job = getJobById(jobId)
    if (!job) return
    const payment = getPaymentForJob(jobId)
    const localVm = deriveCustomerDepositAction(job, payment, getFundingRequestByJobId(jobId)?.status)
    if (!localVm) return
    if (!user?.id) {
      setError('Kein authentifizierter Nutzer gefunden.')
      return
    }
    if (!localVm.agreedAmount) {
      setError('Betrag konnte nicht ermittelt werden.')
      return
    }
    // Clear any stale clientSecret from a previous (possibly expired) escrow so
    // the Stripe payment form is not shown with an invalid PaymentIntent.
    setClientSecret(null)
    setIsPending(true)
    setError(null)
    setDebugInfo(null)
    try {
      // DEFERRED-DEAD: this card drives the retired destination-charge escrow path
      // (api/create-escrow was DELETED in the 2026-07-06 hardening — the endpoint
      // now 404s). It has ZERO live importers. Do not wire it back without migrating
      // to the funding/tranche deposit flow; a re-mount would fail on the missing
      // endpoint. Kept per "defer don't delete".
      const updatedPayment = await createEscrowWorkflow(jobId, user.id, localVm.agreedAmount)
      setClientSecret(updatedPayment.clientSecret ?? null)
      setVm(deriveCustomerDepositAction(getJobById(jobId)!, getPaymentForJob(jobId), getFundingRequestByJobId(jobId)?.status))
    } catch (e) {
      const diagnostic = buildDiagnostic({
        source: 'PAYMENT_INIT',
        step: 'create_escrow',
        name: 'CustomerDepositActionCard.handleStartPayment',
        error: e,
        details: { jobId, provider: providerName },
        hint: 'Check payment provider configuration and clientSecret creation.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setError(e instanceof Error ? e.message : 'Escrow-Erstellung fehlgeschlagen')
    } finally {
      setIsPending(false)
    }
  }, [jobId, providerName, user])

  /**
   * Step 2 (shared): after the provider has confirmed the payment (either via
   * Stripe.js or the mock confirm), advance SaFix state to deposit_paid → in_escrow.
   */
  const handlePaymentConfirmed = useCallback(async () => {
    setIsPending(true)
    setError(null)
    setDebugInfo(null)
    try {
      await confirmDepositWorkflow(jobId)
      await lockEscrowWorkflow(jobId)
      const job = getJobById(jobId)
      if (job) setVm(deriveCustomerDepositAction(job, getPaymentForJob(jobId), getFundingRequestByJobId(jobId)?.status))
    } catch (e) {
      const diagnostic = buildDiagnostic({
        source: 'PAYMENT_INIT',
        step: 'confirm_deposit',
        name: 'CustomerDepositActionCard.handlePaymentConfirmed',
        error: e,
        details: { jobId, provider: providerName },
        hint: 'Confirm deposit payment and escrow lock transition.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setError(e instanceof Error ? e.message : 'Zahlungsbestätigung fehlgeschlagen')
    } finally {
      setIsPending(false)
    }
  }, [jobId, providerName])

  const handleStripeError = useCallback((msg: string) => {
    setError(msg)
    const diagnostic = buildDiagnostic({
      source: 'PAYMENT_INIT',
      step: 'stripe_payment',
      name: 'CustomerDepositActionCard.handleStripeError',
      error: msg,
      hint: 'Stripe PaymentElement surfaced an error message.',
    })
    emitDiagnostic(diagnostic)
    setDebugInfo(diagnostic)
  }, [])

  if (!vm) return null

  return (
    <CustomerDepositActionCardView
      vm={vm}
      providerName={providerName}
      clientSecret={clientSecret}
      onStartPayment={handleStartPayment}
      onMockConfirm={handlePaymentConfirmed}
      onStripeSuccess={handlePaymentConfirmed}
      onStripeError={handleStripeError}
      isPending={isPending}
      error={error}
      debugInfo={debugInfo}
    />
  )
}
