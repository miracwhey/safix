import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useBlocker } from 'react-router-dom'
import { CreditCard, Lock } from 'lucide-react'
import { Icon } from '../primitives'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { intentionalReload } from '../../lib/lifecycle/killDetection'
import { getPublicWebOrigin } from '../../lib/platform'
import { getActivePaymentProviderName } from '../../lib/payments'
import { formatEuro } from '../../lib/payments/selectors'
import { getFundingRequestByJobId, getFundingRequestRepository, isFundingRequestRepositoryHydrated } from '../../lib/payments/fundingRequest'
import { getEscrowPlanByJobId, getEscrowPlanRepository } from '../../lib/payments/escrow'
import { customerFundingEntryWorkflow, confirmFundingWorkflow } from '../../lib/workflow/jobWorkflow'
import { useStoreSync } from '../../lib/reactive'
import { useSession } from '../../hooks/useSession'
import { useHaptics } from '../../hooks/useHaptics'
import { useToast } from '../../hooks/useToast'
import DiagnosticDebugBlock from '../DiagnosticDebugBlock'
import PaymentProcessStepper from '../payments/PaymentProcessStepper'
import Spinner from '../system/Spinner'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../../lib/diagnostics'
import { logInfo, logWarning } from '../../lib/observability'
import { initiateFundingPayment, type InitiateFundingResult } from '../../lib/funding/initiateFundingApi'
import type { AttributionBlockInfo } from '../../lib/commercialAttribution/attributionBlockUi'
import { confirmFundingPayment } from '../../lib/funding/confirmFundingApi'
import { fetchFundingEntry } from '../../lib/funding/fundingEntryApi'
import type { FundingRequest } from '../../lib/payments/fundingRequest'
import type { EscrowPaymentPlan } from '../../lib/payments/escrow'

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

/**
 * Explicit payment-initiation state machine.
 *
 * Tracks the sub-flow after the user clicks "Jetzt einzahlen" so the UI
 * never gets stuck in an ambiguous processing state.
 *
 * - idle                      → ready to start (button visible)
 * - preparing-payment         → initiate-funding API call in flight
 * - payment-form-ready        → clientSecret received, Stripe form mounted
 * - payment-already-funded    → payment was already completed, show funded state
 * - payment-init-error        → initiation failed; persistent, retryable
 * - confirming-payment        → Stripe form submitted (charge may have fired) through server confirm
 * - reconciliation-pending    → server confirm done but funded truth not yet
 *                               observed; bounded poll in progress
 * - reconciliation-timeout    → poll window exhausted; manual action offered
 */
export type PaymentPhase =
  | 'idle'
  | 'preparing-payment'
  | 'payment-form-ready'
  | 'payment-already-funded'
  | 'payment-init-error'
  | 'confirming-payment'
  | 'reconciliation-pending'
  | 'reconciliation-timeout'

type Props = {
  jobId: string
  /** Server-authoritative funding request from FundingEntryScreen payload.
   *  When provided, used as primary truth instead of store lookups. */
  serverFundingRequest?: FundingRequest
  /** Server-authoritative escrow plan from FundingEntryScreen payload. */
  serverEscrowPlan?: EscrowPaymentPlan
}

// ---------------------------------------------------------------------------
// Reconciliation polling constants
// ---------------------------------------------------------------------------

const RECONCILIATION_POLL_INTERVAL_MS = 2_000
const RECONCILIATION_MAX_DURATION_MS = 30_000

// ---------------------------------------------------------------------------
// Canonical payload helpers — prefer server-returned timestamps over
// locally invented Date.now() values.
// ---------------------------------------------------------------------------

/** Parse an ISO-8601 string into a Unix-ms timestamp, or undefined. */
function parseTimestampMs(val: string | undefined): number | undefined {
  if (!val) return undefined
  const ms = new Date(val).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Apply a canonical FundingEntryPayload to the in-memory repos.
 * Uses server-authoritative values for status, fundedAt, updatedAt,
 * and externalFundingRef — no local Date.now() patching.
 */
function applyCanonicalPayloadToRepos(
  payload: import('../../lib/funding/fundingEntryApi').FundingEntryPayload,
): void {
  const frRepo = getFundingRequestRepository()
  const epRepo = getEscrowPlanRepository()

  frRepo.update(payload.fundingRequest.id, (current) => ({
    ...current,
    status: payload.fundingRequest.status,
    fundedAt: parseTimestampMs(payload.fundingRequest.fundedAt) ?? current.fundedAt,
    updatedAt: parseTimestampMs(payload.fundingRequest.updatedAt) ?? current.updatedAt,
    externalFundingRef: payload.fundingRequest.externalFundingRef ?? current.externalFundingRef,
  }))

  epRepo.updatePlan(payload.escrowPlan.id, (current) => ({
    ...current,
    status: payload.escrowPlan.status,
    fundedAt: parseTimestampMs(payload.escrowPlan.fundedAt) ?? current.fundedAt,
    updatedAt: parseTimestampMs(payload.escrowPlan.updatedAt) ?? current.updatedAt,
    externalFundingRef: payload.escrowPlan.externalFundingRef ?? current.externalFundingRef,
  }))
}

// ---------------------------------------------------------------------------
// Stripe payment sub-form (must live inside an <Elements> context)
// ---------------------------------------------------------------------------

function StripePaymentForm({
  returnUrl,
  onSuccess,
  onError,
  onSubmitStart,
}: {
  /**
   * Absolute public-web return URL for Stripe redirect-based payment methods.
   * MUST be a public origin — in the native Capacitor shell
   * `window.location.href` resolves to `capacitor://localhost`, which Stripe
   * cannot redirect back to (FINDINGS P1 #321). Built via getPublicWebOrigin.
   */
  returnUrl: string
  onSuccess: (paymentIntentId: string) => void
  onError: (msg: string) => void
  onSubmitStart?: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setIsSubmitting(true)
    onSubmitStart?.()
    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: returnUrl,
        },
        redirect: 'if_required',
      })

      if (error) {
        onError('Zahlung fehlgeschlagen. Bitte prüfe deine Kartendaten und versuche es erneut.')
        return
      }

      if (
        paymentIntent?.status === 'requires_capture' ||
        paymentIntent?.status === 'succeeded'
      ) {
        onSuccess(paymentIntent.id)
      } else {
        onError('Zahlung fehlgeschlagen. Bitte versuche es erneut.')
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unerwarteter Fehler bei der Zahlungsverarbeitung.')
    } finally {
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
        {isSubmitting ? (
          'Zahlung wird verarbeitet …'
        ) : (
          <span className="inline-flex items-center justify-center gap-2">
            <Icon icon={Lock} size="sm" />
            Jetzt bezahlen
          </span>
        )}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Shared payment-init error block
// ---------------------------------------------------------------------------

function PaymentInitErrorBlock({
  error,
  onRetryPayment,
  onDismiss,
  showReloadButton,
  showRetryButton = true,
  attributionBlock = null,
}: {
  error?: string | null
  onRetryPayment: () => void
  /**
   * Fired when the user dismisses an attribution-block (`job_not_found`)
   * state.  Must NOT re-trigger the payment — the whole point of dismiss is
   * to navigate away from a stale link, not loop on the same error.
   * Defaults to `window.history.back()` when the parent does not pass one.
   */
  onDismiss?: () => void
  showReloadButton?: boolean
  /** When false, suppresses the retry CTA (non-retryable provider-side block). */
  showRetryButton?: boolean
  /**
   * When present the block renders as an attribution-block state instead of a
   * generic payment-init error.  Title/body/retry-decision come from the
   * shared mapper in `src/lib/commercialAttribution/attributionBlockUi.ts`.
   */
  attributionBlock?: AttributionBlockInfo | null
}) {
  if (attributionBlock) {
    const canRetry = attributionBlock.retryable && (showRetryButton !== false)
    const handleDismiss = onDismiss ?? (() => {
      if (typeof window !== 'undefined' && window.history) {
        window.history.back()
      }
    })
    return (
      <div
        data-testid="payment-init-error"
        className="mt-4 rounded-[14px] bg-amber-50 px-3.5 py-3 ring-1 ring-amber-200"
      >
        <div className="flex items-center gap-2">
          <span className="text-[14px]">⏳</span>
          <span className="text-[13px] font-semibold text-amber-800">
            {attributionBlock.title}
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-amber-900/90">
          {attributionBlock.message}
        </p>
        <div className="mt-3 flex gap-3">
          {canRetry && (
            <button
              type="button"
              onClick={onRetryPayment}
              className="flex-1 rounded-2xl bg-amber-600 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-amber-700"
              data-testid="attribution-block-retry"
            >
              🔄 {attributionBlock.cta?.label ?? 'Erneut versuchen'}
            </button>
          )}
          {!canRetry && attributionBlock.cta?.action === 'support' && (
            <a
              href="mailto:team@safix.digital"
              className="flex-1 rounded-2xl border border-amber-300 bg-white px-4 py-2.5 text-center text-[14px] font-semibold text-amber-800 transition-colors hover:bg-amber-100"
              data-testid="attribution-block-support"
            >
              {attributionBlock.cta.label}
            </a>
          )}
          {!canRetry && attributionBlock.cta?.action === 'dismiss' && (
            <button
              type="button"
              onClick={handleDismiss}
              className="flex-1 rounded-2xl border border-amber-300 bg-white px-4 py-2.5 text-[14px] font-semibold text-amber-800 transition-colors hover:bg-amber-100"
              data-testid="attribution-block-dismiss"
            >
              {attributionBlock.cta.label}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="payment-init-error"
      className="mt-4 rounded-[14px] bg-red-50 px-3.5 py-3 ring-1 ring-red-100"
    >
      <div className="flex items-center gap-2">
        <span className="text-[14px]">⚠️</span>
        <span className="text-[13px] font-semibold text-red-700">
          Zahlung konnte nicht gestartet werden
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-red-600">
        {error ?? 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.'}
      </p>
      {(showRetryButton || showReloadButton) && (
        <div className="mt-3 flex gap-3">
          {showRetryButton && (
            <button
              type="button"
              onClick={onRetryPayment}
              className="flex-1 rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700"
            >
              🔄 Erneut versuchen
            </button>
          )}
          {showReloadButton && (
            <button
              type="button"
              onClick={() => intentionalReload()}
              className="rounded-2xl border border-slate-200 px-4 py-2.5 text-[14px] font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              Seite neu laden
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared already-funded callout — reused in both action-required and processing
// ---------------------------------------------------------------------------

function PaymentAlreadyFundedBlock() {
  return (
    <div
      data-testid="payment-already-funded"
      className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100"
    >
      <div className="flex items-center gap-2">
        <span className="text-[14px]">✅</span>
        <span className="text-[13px] font-semibold text-emerald-700">
          Zahlung bereits abgeschlossen
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-emerald-600">
        Die Einzahlung für diesen Auftrag wurde bereits durchgeführt. Es ist keine weitere Zahlung erforderlich.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pure view
// ---------------------------------------------------------------------------

function CustomerEscrowFundingCardView({
  fundingRequest,
  escrowPlan,
  providerName,
  clientSecret,
  paymentPhase,
  onStartPayment,
  onMockConfirm,
  onStripeSuccess,
  onStripeError,
  onStripeSubmitStart,
  onRetry,
  onRetryPayment,
  onRetryReconciliation,
  isPending,
  error,
  isPayoutBlock,
  attributionBlock,
  debugInfo,
}: {
  fundingRequest: FundingRequest
  escrowPlan: EscrowPaymentPlan | undefined
  providerName: 'mock' | 'stripe'
  clientSecret: string | null
  paymentPhase: PaymentPhase
  onStartPayment: () => void
  onMockConfirm: () => void
  onStripeSuccess: (paymentIntentId: string) => void
  onStripeError: (msg: string) => void
  onStripeSubmitStart?: () => void
  onRetry: () => void
  onRetryPayment: () => void
  onRetryReconciliation: () => void
  isPending: boolean
  error?: string | null
  /** When true, payment-init-error is a non-retryable provider payout block. */
  isPayoutBlock: boolean
  /** Structured attribution-block descriptor (routed to PaymentInitErrorBlock). */
  attributionBlock: AttributionBlockInfo | null
  debugInfo: RuntimeDiagnostic | null
}) {
  const haptics = useHaptics()
  const status = fundingRequest.status
  const totalAmount = escrowPlan?.totalAmount ?? fundingRequest.amount

  const isActionRequired = status === 'created' || status === 'sent'
  const isProcessing = status === 'funding_started' || status === 'funding_initiated'
  const isFunded = status === 'funded'
  const isFailed = status === 'funding_failed'
  const isCancelledOrExpired = status === 'cancelled' || status === 'expired'

  // Whether the Stripe payment form should be shown (phase-driven)
  const isStripeFormReady = paymentPhase === 'payment-form-ready' && clientSecret !== null

  // The Stripe <Elements> subtree must stay MOUNTED through
  // 'confirming-payment' so the live PaymentElement iframe — and a 3DS
  // challenge that relies on it — survives the React flush triggered by
  // onSubmitStart, instead of being torn down and rebuilt as a fresh empty
  // element which loops the user back (FINDINGS P1 #315). During confirming
  // the form is visually hidden (display:none, still mounted) so only the
  // confirming spinner shows.
  const isStripeFormMounted =
    isStripeFormReady || (paymentPhase === 'confirming-payment' && clientSecret !== null)

  // Public-web return URL for Stripe redirect-based payment methods. The
  // native shell resolves window.location.origin to capacitor://localhost,
  // which Stripe cannot redirect back to — always use the hosted PWA origin
  // (FINDINGS P1 #321).
  const stripeReturnUrl = `${getPublicWebOrigin()}/funding/${fundingRequest.id}`

  // Accent colours per phase
  const accentClass = isActionRequired || isProcessing
    ? 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
    : isFunded
    ? 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300'
    : isFailed
    ? 'bg-gradient-to-b from-red-500 via-red-400 to-red-300'
    : 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200'

  const ringClass = isActionRequired || isProcessing
    ? 'ring-1 ring-amber-200/80'
    : isFunded
    ? 'ring-1 ring-emerald-200/80'
    : isFailed
    ? 'ring-1 ring-red-200/80'
    : 'ring-1 ring-slate-200/70'

  // Phase label
  const phaseLabel = isActionRequired
    ? 'Zahlung angefordert'
    : isProcessing
    ? 'Einzahlung wird verarbeitet'
    : isFunded
    ? 'Zahlung bestätigt ✅'
    : isFailed
    ? 'Einzahlung fehlgeschlagen'
    : isCancelledOrExpired
    ? status === 'cancelled' ? 'Zahlungsanfrage storniert' : 'Zahlungsanfrage abgelaufen'
    : 'Zahlung'

  // Phase icon
  const phaseIcon = isActionRequired
    ? '💳'
    : isProcessing
    ? '⏳'
    : isFunded
    ? '✅'
    : isFailed
    ? '❌'
    : '🚫'

  return (
    <section
      data-testid="customer-escrow-funding-card"
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
            isActionRequired || isProcessing
              ? 'text-amber-600'
              : isFunded
              ? 'text-emerald-600'
              : isFailed
              ? 'text-red-600'
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
        {isProcessing && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
            IN BEARBEITUNG
          </span>
        )}
        {isFunded && (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-emerald-700 ring-1 ring-emerald-200">
            BESTÄTIGT
          </span>
        )}
        {isFailed && (
          <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-red-600 ring-1 ring-red-200">
            FEHLGESCHLAGEN
          </span>
        )}
      </div>

      {/* Icon + title */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={[
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
            isActionRequired || isProcessing
              ? 'bg-amber-500'
              : isFunded
              ? 'bg-emerald-600'
              : isFailed
              ? 'bg-red-500'
              : 'bg-slate-400',
          ].join(' ')}
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">{phaseIcon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {phaseLabel}
          </h2>
        </div>
      </div>

      {/* Escrow semantics description */}
      {(isActionRequired || isProcessing) && (
        <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
          Der vollständige Betrag wird vorab über Stripe abgesichert und nach
          Arbeitsfortschritt freigegeben.
        </p>
      )}

      {/* Amount breakdown — shown when amounts are known */}
      {totalAmount > 0 && !isCancelledOrExpired && (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            isActionRequired || isProcessing
              ? 'bg-amber-50 ring-amber-100'
              : isFunded
              ? 'bg-emerald-50 ring-emerald-100'
              : isFailed
              ? 'bg-red-50 ring-red-100'
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
                {formatEuro(totalAmount)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-slate-500">
                Zahlung (100&thinsp;%)
              </span>
              <span
                className={[
                  'text-[13px] font-semibold',
                  isActionRequired || isProcessing ? 'text-amber-700' : 'text-slate-700',
                ].join(' ')}
              >
                {formatEuro(totalAmount)}
              </span>
            </div>
          </div>

          {/* Escrow release info */}
          <div className="mt-2 border-t border-slate-100 pt-2">
            <div className="text-[12px] leading-relaxed text-slate-400">
              25&thinsp;% nach Arbeitsbeginn · 75&thinsp;% nach Fertigstellung
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Payment action area — status: created / sent                       */}
      {/* ------------------------------------------------------------------ */}

      {isActionRequired && (
        <>
          {paymentPhase === 'payment-init-error' ? (
            <PaymentInitErrorBlock
              error={error}
              onRetryPayment={onRetryPayment}
              showRetryButton={!isPayoutBlock}
              attributionBlock={attributionBlock}
            />
          ) : paymentPhase === 'payment-already-funded' ? (
            <PaymentAlreadyFundedBlock />
          ) : isStripeFormMounted ||
            paymentPhase === 'reconciliation-pending' ||
            paymentPhase === 'reconciliation-timeout' ? (
            // A payment is already in progress (live Stripe form mounted, or
            // reconciliation running). Suppress the "Jetzt einzahlen" CTA even
            // if the funding-request status reverted to created/sent — that
            // status flip is an optimistic, RLS-non-durable local write, and a
            // DB re-read (realtime fallbackRefresh / iOS-resume
            // restartRealtimeIfDead) can revert it and otherwise resurrect an
            // enabled dead button over the live form (FINDINGS P1 #309).
            null
          ) : (
            <>
              <button
                type="button"
                disabled={isPending || paymentPhase === 'preparing-payment'}
                onClick={() => { haptics.medium(); onStartPayment() }}
                className="mt-4 w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition hover:bg-amber-600 active:bg-amber-700 active:scale-[0.98] disabled:opacity-60"
              >
                {paymentPhase === 'preparing-payment' ? (
                  'Zahlungsdaten werden vorbereitet …'
                ) : (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Icon icon={CreditCard} size="sm" />
                    Jetzt einzahlen
                  </span>
                )}
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
                Leiste jetzt die Zahlung, um den Auftrag zu starten. Der
                vollständige Betrag ist bis zur erfolgreichen Abnahme über Stripe abgesichert.
              </p>
            </>
          )}

          {error && paymentPhase !== 'payment-init-error' && (
            <p className="mt-2 text-[12px] leading-relaxed text-red-500">
              {error}
            </p>
          )}
          <DiagnosticDebugBlock diagnostic={debugInfo} />
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Payment processing — status: funding_started / funding_initiated   */}
      {/* ------------------------------------------------------------------ */}

      {isProcessing && (
        <>
          {/* Mock provider → simple confirm button */}
          {providerName === 'mock' && paymentPhase !== 'payment-init-error' && (
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

          {/* Stripe provider: preparing payment — API call in flight.
              Unified Payment-Prozess-Stepper (Variante A): one calm phased
              loader across preparing → processing → confirming. */}
          {providerName === 'stripe' && paymentPhase === 'preparing-payment' && (
            <div className="mt-4" data-testid="payment-preparing">
              <PaymentProcessStepper phase={1} />
            </div>
          )}

          {/* Payment already funded — discovered during initiation */}
          {paymentPhase === 'payment-already-funded' && (
            <PaymentAlreadyFundedBlock />
          )}

          {/* NOTE: the Stripe <Elements> form + the missing-key config error
              are intentionally NOT rendered here. They render at card level,
              purely phase-driven, so no path can reach 'payment-form-ready'
              without a visible form regardless of funding status, and the
              form survives 'confirming-payment' (FINDINGS P1 #309, #315). */}

          {/* Persistent payment initiation error — retryable unless payout block */}
          {paymentPhase === 'payment-init-error' && (
            <PaymentInitErrorBlock
              error={error}
              onRetryPayment={onRetryPayment}
              showReloadButton
              showRetryButton={!isPayoutBlock}
              attributionBlock={attributionBlock}
            />
          )}

          {/* Confirming payment — server confirm call in flight (Stepper phase 2) */}
          {paymentPhase === 'confirming-payment' && (
            <div className="mt-4" data-testid="payment-confirming">
              <PaymentProcessStepper phase={2} />
            </div>
          )}

          {/* Reconciliation pending — bounded poll in progress (Stepper phase 3).
              Keep the reassurance line: the charge already landed. */}
          {paymentPhase === 'reconciliation-pending' && (
            <div className="mt-4" data-testid="reconciliation-pending">
              <PaymentProcessStepper phase={3} />
              <p className="mt-2 px-1 text-[12px] leading-relaxed text-slate-400">
                Deine Zahlung wurde empfangen. Die Zahlungs-Bestätigung wird geprüft.
              </p>
            </div>
          )}

          {/* Reconciliation timeout — manual action available */}
          {paymentPhase === 'reconciliation-timeout' && (
            <div
              data-testid="reconciliation-timeout"
              className="mt-4 rounded-[14px] bg-amber-50 px-3.5 py-3 ring-1 ring-amber-100"
            >
              <div className="flex items-center gap-2">
                <span className="text-[14px]">⏳</span>
                <span className="text-[13px] font-semibold text-amber-700">
                  Zahlung erhalten — Bestätigung noch in Bearbeitung
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-amber-600">
                Deine Zahlung wurde empfangen. Die endgültige Bestätigung dauert noch einen Moment.
                Du kannst den Status erneut prüfen lassen.
              </p>
              <button
                type="button"
                data-testid="reconciliation-retry"
                onClick={onRetryReconciliation}
                className="mt-2 w-full rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700"
              >
                🔄 Status erneut prüfen
              </button>
            </div>
          )}

          {/* Re-entry: user has funding_started but no active payment flow */}
          {providerName === 'stripe' && paymentPhase === 'idle' && (
            <>
              <button
                type="button"
                data-testid="resume-payment-button"
                disabled={isPending}
                onClick={onStartPayment}
                className="mt-4 w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
              >
                💳 Zahlung fortsetzen
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
                Die Zahlung wurde bereits eingeleitet. Bitte schließe die Zahlung ab.
              </p>
            </>
          )}

          {error && paymentPhase !== 'payment-init-error' && (
            <p className="mt-2 text-[12px] leading-relaxed text-red-500">
              {error}
            </p>
          )}
          <DiagnosticDebugBlock diagnostic={debugInfo} />
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Stripe payment form — PHASE-DRIVEN, rendered independently of the   */}
      {/* isActionRequired / isProcessing status split so no path reaches      */}
      {/* 'payment-form-ready' without a visible form (FINDINGS P1 #309). The  */}
      {/* <Elements> subtree stays MOUNTED (only CSS-hidden) through           */}
      {/* 'confirming-payment' so a 3DS challenge iframe survives the          */}
      {/* post-submit flush instead of remounting empty (FINDINGS P1 #315).    */}
      {/* ------------------------------------------------------------------ */}

      {providerName === 'stripe' && isStripeFormMounted && stripePromise && (
        <div
          data-testid="stripe-payment-form-mount"
          className={paymentPhase === 'confirming-payment' ? 'hidden' : undefined}
        >
          <Elements
            stripe={stripePromise}
            options={{ clientSecret: clientSecret as string, locale: 'de' }}
          >
            <StripePaymentForm
              returnUrl={stripeReturnUrl}
              onSuccess={onStripeSuccess}
              onError={onStripeError}
              onSubmitStart={onStripeSubmitStart}
            />
          </Elements>
        </div>
      )}

      {/* Stripe form ready but stripePromise missing (no publishable key) */}
      {providerName === 'stripe' && isStripeFormReady && !stripePromise && (
        <div
          data-testid="stripe-config-error"
          className="mt-4 rounded-[14px] bg-red-50 px-3.5 py-3 ring-1 ring-red-100"
        >
          <div className="flex items-center gap-2">
            <span className="text-[14px]">⚠️</span>
            <span className="text-[13px] font-semibold text-red-700">
              Zahlungskonfiguration nicht verfügbar
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-red-600">
            Online-Zahlung ist momentan nicht verfügbar. Bitte versuche es später erneut
            oder kontaktiere den Support.
          </p>
          <button
            type="button"
            onClick={onRetryPayment}
            className="mt-2 w-full rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700"
          >
            🔄 Erneut versuchen
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Status callout — funded                                            */}
      {/* ------------------------------------------------------------------ */}

      {isFunded && (
        <div className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">✅</span>
            <span className="text-[13px] font-semibold text-emerald-700">
              Zahlung bestätigt
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-emerald-600">
            Deine Einzahlung ist bestätigt. Der Betrag wird über Stripe abgesichert
            und nach Arbeitsfortschritt freigegeben.
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Status callout — failed                                            */}
      {/* ------------------------------------------------------------------ */}

      {isFailed && (
        <>
          <div className="mt-4 rounded-[14px] bg-red-50 px-3.5 py-3 ring-1 ring-red-100">
            <div className="flex items-center gap-2">
              <span className="text-[14px]">❌</span>
              <span className="text-[13px] font-semibold text-red-700">
                Einzahlung fehlgeschlagen
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-red-600">
              {fundingRequest.failureReason ?? 'Die Zahlung konnte nicht verarbeitet werden. Bitte versuche es erneut.'}
            </p>
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={onRetry}
            className="mt-3 w-full rounded-2xl bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
          >
            {isPending ? 'Wird vorbereitet …' : '🔄 Erneut versuchen'}
          </button>

          {error && (
            <p className="mt-2 text-[12px] leading-relaxed text-red-500">
              {error}
            </p>
          )}
          <DiagnosticDebugBlock diagnostic={debugInfo} />
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Status callout — cancelled / expired                               */}
      {/* ------------------------------------------------------------------ */}

      {isCancelledOrExpired && (
        <div className="mt-4 rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">🚫</span>
            <span className="text-[13px] font-semibold text-slate-700">
              {status === 'cancelled' ? 'Zahlungsanfrage storniert' : 'Zahlungsanfrage abgelaufen'}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            {status === 'cancelled'
              ? 'Diese Zahlungsanfrage wurde storniert.'
              : 'Diese Zahlungsanfrage ist abgelaufen. Bitte kontaktiere den Dienstleister für eine neue Anfrage.'}
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Phases where startPayment() must not fire — call is already in flight or
// the Stripe form is mounted and must not be destroyed by a second trigger.
// ---------------------------------------------------------------------------

const PAYMENT_IN_PROGRESS_PHASES = new Set<PaymentPhase>([
  'preparing-payment',
  'payment-form-ready',
  'confirming-payment',
  'reconciliation-pending',
])

// Phases where back-navigation must be intercepted.  The payment has already
// been charged on Stripe; navigating away silently breaks the funded UX and
// risks the user retrying, leading to a double-charge support case.
const PAYMENT_BLOCKING_PHASES = new Set<PaymentPhase>([
  'confirming-payment',
  'reconciliation-pending',
])

// ---------------------------------------------------------------------------
// Imperative handle — allows parent to trigger payment without prop drilling
// ---------------------------------------------------------------------------

export type CustomerEscrowFundingCardHandle = {
  /** Starts the payment-initiation flow, equivalent to tapping the in-card CTA. */
  startPayment: () => void
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * Customer-facing escrow funding card shown when a provider has issued a
 * funding request.
 *
 * Payload-driven: accepts optional server-authoritative funding request and
 * escrow plan props from FundingEntryScreen. These are used as primary truth,
 * with store lookups as a secondary fallback.
 *
 * Uses an explicit PaymentPhase state machine for the payment-initiation
 * sub-flow so the UI never gets stuck in an ambiguous processing state.
 *
 * - created / sent        → "Jetzt einzahlen" CTA; calls
 *   `customerFundingEntryWorkflow` to mark funding_started, then either
 *   renders Stripe Payment Element or a mock confirm button.
 * - funding_started / funding_initiated → payment in progress; Stripe Element
 *   or mock confirm.
 * - funded                → read-only "Bestätigt" callout.
 * - funding_failed        → error message + retry button.
 * - cancelled / expired   → informational callout.
 *
 * Returns null when no funding request exists for the given job.
 */
const CustomerEscrowFundingCard = forwardRef<CustomerEscrowFundingCardHandle, Props>(
function CustomerEscrowFundingCard({ jobId, serverFundingRequest, serverEscrowPlan }, ref) {
  const { user } = useSession()
  const haptics = useHaptics()
  const toast = useToast()

  // ── State: payload-driven with store fallback ─────────────────────────
  const [fundingRequest, setFundingRequest] = useState<FundingRequest | undefined>(
    () => serverFundingRequest ?? getFundingRequestByJobId(jobId),
  )
  const [escrowPlan, setEscrowPlan] = useState<EscrowPaymentPlan | undefined>(
    () => serverEscrowPlan ?? getEscrowPlanByJobId(jobId),
  )
  const [frRepoHydrated, setFrRepoHydrated] = useState(isFundingRequestRepositoryHydrated)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // True when the payment-init-error is due to provider payout readiness.
  // These errors are NOT customer-retryable — suppresses the retry CTA.
  const [isPayoutBlock, setIsPayoutBlock] = useState(false)
  // Structured attribution-block state.  When set the payment-init-error
  // block renders fachliche copy + retry decision from the shared mapper
  // instead of the generic error text.
  const [attributionBlock, setAttributionBlock] = useState<AttributionBlockInfo | null>(null)
  const [debugInfo, setDebugInfo] = useState<RuntimeDiagnostic | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [paymentPhase, setPaymentPhase] = useState<PaymentPhase>('idle')

  // Ref that mirrors paymentPhase without requiring it in handleStartPayment's
  // dependency array — avoids re-creating the imperative handle on each phase change.
  const paymentPhaseRef = useRef<PaymentPhase>('idle')
  useEffect(() => { paymentPhaseRef.current = paymentPhase }, [paymentPhase])

  useEffect(() => {
    if (fundingRequest) {
      logInfo('[CustomerEscrowFundingCard] mounted with funding request', { id: fundingRequest.id, jobId, status: fundingRequest.status })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (fundingRequest) {
      logInfo('[CustomerEscrowFundingCard] render branch', { status: fundingRequest.status, paymentPhase })
    }
  }, [fundingRequest, paymentPhase])

  // Subscribe to jobs, funding request, and escrow plan stores for reactive updates.
  const subscribeFundingRequests = useCallback(
    (listener: () => void) => getFundingRequestRepository().subscribe(listener),
    [],
  )
  const subscribeEscrowPlans = useCallback(
    (listener: () => void) => getEscrowPlanRepository().subscribe(listener),
    [],
  )

  useStoreSync([subscribeJobs, subscribeFundingRequests, subscribeEscrowPlans], () => {
    setFundingRequest(getFundingRequestByJobId(jobId))
    setEscrowPlan(getEscrowPlanByJobId(jobId))
    setFrRepoHydrated(isFundingRequestRepositoryHydrated())
  })

  const providerName = getActivePaymentProviderName()

  // One-shot success feedback on the live funded-truth TRANSITION. Fires the
  // success haptic + toast exactly once when the funding request moves into
  // 'funded' during this session — NOT when the card mounts on an
  // already-funded request (revisiting a paid escrow must stay silent).
  // Guarded by (a) a prev-status ref so only a real non-funded → funded edge
  // counts, and (b) a fired ref so re-renders / store re-reads never re-fire
  // (the card returns null once funded — the effect still runs because hooks
  // execute before the early return).
  const fundedFeedbackFiredRef = useRef(false)
  const prevFundingStatusRef = useRef(fundingRequest?.status)
  useEffect(() => {
    const prev = prevFundingStatusRef.current
    const curr = fundingRequest?.status
    if (
      curr === 'funded' &&
      prev !== undefined &&
      prev !== 'funded' &&
      !fundedFeedbackFiredRef.current
    ) {
      fundedFeedbackFiredRef.current = true
      haptics.success()
      toast.success('Zahlung im Treuhandkonto gesichert')
    }
    prevFundingStatusRef.current = curr
  }, [fundingRequest?.status, haptics, toast])

  // Block React Router navigation when the payment has already been charged
  // and we're waiting for server confirmation or funded truth.  Leaving silently
  // would orphan the funded state and risk the user retrying the payment.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      PAYMENT_BLOCKING_PHASES.has(paymentPhase) &&
      currentLocation.pathname !== nextLocation.pathname,
  )

  // Prevent hard page exits (refresh, URL bar, browser close) during the
  // charged window — useBlocker only covers React Router transitions.
  useEffect(() => {
    if (!PAYMENT_BLOCKING_PHASES.has(paymentPhase)) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [paymentPhase])

  /** Reset payment phase to idle (for retry flows). */
  const handleRetryPayment = useCallback(() => {
    logInfo('payment.retry_clicked', { jobId })
    setPaymentPhase('idle')
    paymentPhaseRef.current = 'idle'
    setError(null)
    setIsPayoutBlock(false)
    setAttributionBlock(null)
    setClientSecret(null)
    setDebugInfo(null)
    setIsPending(false)
  }, [jobId])

  /**
   * Advance the LOCAL funding-request + escrow-plan status to the
   * payment-initiated state after a server-confirmed initiate response.
   *
   * customerFundingEntryWorkflow cannot be relied on for this: it is
   * fire-and-forget and bails silently on cold-start/resume
   * (`jobWorkflow: if (!job) return undefined`), and the customer
   * funding_requests UPDATE RLS is a dropped no-op. The LOCAL repo status is
   * the only thing that drives the UI render branch, so advance it explicitly
   * from the server payload (FINDINGS P1 #309). Guarded so a later state
   * (funded / failed) is never regressed; the repo update notifies
   * subscribers synchronously, mirroring applyCanonicalPayloadToRepos.
   */
  const advanceLocalStatusToInitiated = useCallback((frId: string, planId: string) => {
    const now = Date.now()
    getFundingRequestRepository().update(frId, (current) =>
      current.status === 'created' || current.status === 'sent'
        ? { ...current, status: 'funding_initiated', updatedAt: now }
        : current,
    )
    getEscrowPlanRepository().updatePlan(planId, (current) =>
      current.status === 'awaiting_customer_funding'
        ? { ...current, status: 'funding_initiated', updatedAt: now }
        : current,
    )
  }, [])

  /** CTA: customer starts the funding flow. */
  const handleStartPayment = useCallback(async () => {
    // Guard: do not re-enter if a payment call is already in flight or the
    // Stripe form is mounted.  Uses a ref so no stale-closure risk.
    if (PAYMENT_IN_PROGRESS_PHASES.has(paymentPhaseRef.current)) {
      logInfo('payment.start_blocked_in_progress', {
        jobId,
        phase: paymentPhaseRef.current,
      })
      return
    }

    // Synchronously claim the 'preparing-payment' slot before any async work.
    // The useEffect mirror fires too late (post-render) — updating the ref here
    // prevents a second tap from passing the guard within the same render cycle.
    paymentPhaseRef.current = 'preparing-payment'

    // Use component state (payload-driven) first, fall back to store
    const fr = fundingRequest ?? getFundingRequestByJobId(jobId)
    const plan = escrowPlan ?? getEscrowPlanByJobId(jobId)
    if (!fr || !plan) {
      logWarning('payment.start_missing_data', { jobId, hasFr: !!fr, hasPlan: !!plan })
      setError('Zahlungsdaten nicht verfügbar. Bitte Seite neu laden.')
      setPaymentPhase('payment-init-error')
      paymentPhaseRef.current = 'payment-init-error'
      return
    }
    if (!user?.id) {
      setError('Kein authentifizierter Nutzer gefunden.')
      setPaymentPhase('payment-init-error')
      paymentPhaseRef.current = 'payment-init-error'
      return
    }

    // Guard: Stripe mode requires publishable key
    if (providerName === 'stripe' && !stripePublishableKey) {
      logWarning('payment.missing_stripe_key', { jobId })
      setError('Zahlungskonfiguration nicht verfügbar. Bitte versuche es später erneut.')
      setPaymentPhase('payment-init-error')
      paymentPhaseRef.current = 'payment-init-error'
      return
    }

    logInfo('payment.start_clicked', { jobId, provider: providerName, fundingRequestId: fr.id })

    setClientSecret(null)
    setIsPending(true)
    setError(null)
    setDebugInfo(null)
    setPaymentPhase('preparing-payment')

    try {
      // Best-effort server-side workflow (timeline events etc.). This is
      // fire-and-forget by design and bails silently on cold-start/resume
      // (`jobWorkflow: if (!job) return undefined`), so the LOCAL repo status
      // is advanced explicitly from the server initiate payload below rather
      // than depending on this call (FINDINGS P1 #309). Guard the rejection
      // so it never surfaces as an unhandled promise.
      logInfo('payment.workflow_start', { jobId, provider: providerName })
      void customerFundingEntryWorkflow(jobId).catch((workflowError) => {
        logWarning('payment.workflow_start_failed', {
          jobId,
          error: workflowError instanceof Error ? workflowError.message : String(workflowError),
        })
      })

      if (providerName === 'mock') {
        // Mock mode: confirm immediately without a real payment provider.
        confirmFundingWorkflow(jobId)
        setFundingRequest(getFundingRequestByJobId(jobId))
        setEscrowPlan(getEscrowPlanByJobId(jobId))
        setPaymentPhase('idle')
      } else {
        // Stripe mode: call the initiate-funding API to create a PaymentIntent.
        logInfo('payment.initiate_funding_started', { jobId, fundingRequestId: fr.id })
        const result: InitiateFundingResult = await initiateFundingPayment({
          fundingRequestId: fr.id,
          escrowPlanId: plan.id,
          jobId,
        })

        logInfo('payment.initiate_funding_response', {
          jobId,
          ok: result.ok,
          outcome: result.outcome,
          clientBranch: result.outcome,
        })

        // ── Explicit failure ─────────────────────────────────────────
        if (!result.ok) {
          const isProviderPayoutBlock = (
            result.blockingReason === 'no_stripe_account' ||
            result.blockingReason === 'charges_disabled' ||
            result.blockingReason === 'payouts_disabled'
          )
          logWarning('payment.initiate_funding_failed_outcome', {
            jobId,
            outcome: result.outcome,
            errorCode: result.errorCode,
            blockingReason: result.blockingReason,
            isProviderPayoutBlock,
            attributionBlockKind: result.attributionBlock?.kind,
          })
          setError(result.message)
          setIsPayoutBlock(isProviderPayoutBlock)
          // Structured attribution-block state drives title + retry CTA in
          // PaymentInitErrorBlock — see attributionBlockUi mapper.
          setAttributionBlock(result.attributionBlock ?? null)
          setPaymentPhase('payment-init-error')
          setIsPending(false)
          return
        }

        // ── Already funded — confirm + reconcile (FINDINGS P1 #333) ──────
        // No NEW payment is needed, but the DB may still read
        // funding_initiated until the webhook fires. Confirm server-side
        // (idempotent + Stripe-verified) using the PaymentIntent the initiate
        // response exposes, then enter the bounded reconciliation poll so the
        // funded truth is observed without waiting on the webhook. On confirm
        // failure we still enter reconciliation (webhook fallback), mirroring
        // handleStripeConfirmed's error handling.
        if (result.outcome === 'PAYMENT_ALREADY_FUNDED') {
          logInfo('payment.already_funded', {
            jobId,
            outcome: result.outcome,
            hasPaymentIntent: !!result.paymentIntentId,
          })
          // Advance LOCAL status so the reconciliation UI (processing branch)
          // renders while the poll runs.
          advanceLocalStatusToInitiated(fr.id, plan.id)
          setIsPending(false)
          // Only attempt the server confirm when we actually have the Stripe
          // PaymentIntent id to verify against. Sending an empty string is a
          // wasted no-op/error; without it the reconciliation poll + webhook
          // still heal the state (the FR row carries the canonical truth).
          if (result.paymentIntentId) {
            try {
              const confirmResult = await confirmFundingPayment({
                paymentIntentId: result.paymentIntentId,
                fundingRequestId: fr.id,
                escrowPlanId: plan.id,
                jobId,
              })
              if (!confirmResult.ok) {
                logWarning('payment.already_funded_confirm_failed_entering_reconciliation', {
                  jobId,
                  message: confirmResult.message,
                })
              }
            } catch (confirmError) {
              logWarning('payment.already_funded_confirm_error_entering_reconciliation', {
                jobId,
                error: confirmError instanceof Error ? confirmError.message : String(confirmError),
              })
            }
          } else {
            logWarning('payment.already_funded_no_payment_intent_entering_reconciliation', { jobId })
          }
          // Refresh stores, then poll canonical truth → funded (idle) / timeout.
          setFundingRequest(getFundingRequestByJobId(jobId))
          setEscrowPlan(getEscrowPlanByJobId(jobId))
          setPaymentPhase('reconciliation-pending')
          paymentPhaseRef.current = 'reconciliation-pending'
          return
        }

        // ── Payment form ready or retry ready — mount Stripe ─────────
        const receivedSecret = result.data.clientSecret
        logInfo('payment.initiate_funding_form_ready', {
          jobId,
          outcome: result.outcome,
          hasClientSecret: !!receivedSecret,
          status: result.data.status,
        })
        setClientSecret(receivedSecret)
        setPaymentPhase('payment-form-ready')
        paymentPhaseRef.current = 'payment-form-ready'
        // ROOT FIX (P1 #309): advance the LOCAL repo status from the
        // server-confirmed initiate payload. Without this the funding request
        // stays created/sent (isActionRequired) and the enabled
        // "Jetzt einzahlen" button is rendered again over the live form — a
        // dead button (further taps are swallowed by the in-progress guard).
        advanceLocalStatusToInitiated(fr.id, plan.id)
        logInfo('payment.stripe_form_ready', { jobId, outcome: result.outcome })
      }

      setFundingRequest(getFundingRequestByJobId(jobId))
      setEscrowPlan(getEscrowPlanByJobId(jobId))
    } catch (e) {
      const diagnostic = buildDiagnostic({
        source: 'PAYMENT_INIT',
        step: 'funding_entry',
        name: 'CustomerEscrowFundingCard.handleStartPayment',
        error: e,
        details: { jobId, provider: providerName },
        hint: 'Check funding request / escrow plan state and payment provider configuration.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      const errorMsg = e instanceof Error ? e.message : 'Einzahlung konnte nicht gestartet werden.'
      setError(errorMsg)
      setPaymentPhase('payment-init-error')
      logWarning('payment.initiate_funding_failed', { jobId, error: errorMsg })
    } finally {
      setIsPending(false)
    }
  }, [jobId, providerName, user, fundingRequest, escrowPlan, advanceLocalStatusToInitiated])

  /**
   * Mock-mode confirm: advance SaFix state to funded locally.
   * Only used for mock/test payment provider — not for production Stripe.
   */
  const handleMockConfirm = useCallback(async () => {
    setIsPending(true)
    setError(null)
    setDebugInfo(null)
    try {
      confirmFundingWorkflow(jobId)
      setFundingRequest(getFundingRequestByJobId(jobId))
      setEscrowPlan(getEscrowPlanByJobId(jobId))
    } catch (e) {
      const diagnostic = buildDiagnostic({
        source: 'PAYMENT_INIT',
        step: 'confirm_funding',
        name: 'CustomerEscrowFundingCard.handleMockConfirm',
        error: e,
        details: { jobId, provider: providerName },
        hint: 'Confirm funding workflow failed.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setError(e instanceof Error ? e.message : 'Zahlungsbestätigung fehlgeschlagen')
    } finally {
      setIsPending(false)
    }
  }, [jobId, providerName])

  /**
   * Stripe success handler: funded truth is established server-side.
   *
   * After Stripe.js confirms the payment on the client, we call the
   * server-side /api/confirm-funding endpoint. The server updates the
   * funding request and escrow plan to 'funded' status in the database.
   * This ensures funded truth comes from the server, not from client state.
   *
   * Post-payment reconciliation state machine:
   * 1. If the server confirms funded_in_escrow immediately → update repos
   *    directly from the API response and show funded UI.
   * 2. If the server confirms but status is not yet funded → enter
   *    reconciliation-pending and poll canonical truth.
   * 3. If the server call fails → enter reconciliation-pending (webhook
   *    will eventually reconcile) and poll for funded truth.
   */
  const handleStripeConfirmed = useCallback(async (paymentIntentId: string) => {
    setIsPending(true)
    setError(null)
    setDebugInfo(null)
    setPaymentPhase('confirming-payment')
    try {
      const fr = getFundingRequestByJobId(jobId)
      const plan = getEscrowPlanByJobId(jobId)

      if (!fr?.id) {
        logWarning('payment.confirm_funding_no_fr', { jobId })
      }

      // Server-side truth: call the confirm-funding API endpoint via
      // the authenticated client helper. Sends the Supabase JWT as
      // Authorization: Bearer <token> so the server can validate the
      // caller without requiring a server secret.
      // Note: empty fundingRequestId/escrowPlanId are acceptable — the
      // server resolves them via paymentIntentId (external_funding_ref).
      const result = await confirmFundingPayment({
        paymentIntentId,
        fundingRequestId: fr?.id ?? '',
        escrowPlanId: plan?.id ?? '',
        jobId,
      })

      if (!result.ok) {
        // Server confirm failed — the payment succeeded on Stripe but the
        // server could not transition the state. Enter reconciliation: the
        // webhook or a subsequent poll will pick up the funded truth.
        logWarning('payment.confirm_funding_failed_entering_reconciliation', {
          jobId,
          message: result.message,
        })
        setPaymentPhase('reconciliation-pending')
        setIsPending(false)
        return
      }

      // Server responded OK — check if funded truth is already confirmed
      if (result.data.status === 'funded_in_escrow') {
        logInfo('payment.confirm_funding_immediate_funded', {
          jobId,
          status: result.data.status,
        })

        // Prefer canonical server payload over local synthetic values.
        // The confirm-funding response only has minimal fields (no fundedAt),
        // so we read the full canonical payload from funding-entry.
        const frId = result.data.fundingRequestId || fr?.id
        if (frId) {
          const entryResult = await fetchFundingEntry(frId)
          if (entryResult.ok) {
            logInfo('payment.confirm_funding_canonical_payload_adopted', {
              jobId,
              fundingRequestId: frId,
              fundedAt: entryResult.data.fundingRequest.fundedAt,
            })
            applyCanonicalPayloadToRepos(entryResult.data)
          } else {
            // Fallback: use confirm response + Date.now() for fundedAt
            // (funding-entry read failed, but funded truth is confirmed)
            logWarning('payment.confirm_funding_canonical_read_failed', {
              jobId,
              fundingRequestId: frId,
              message: entryResult.message,
            })
            const frRepo = getFundingRequestRepository()
            const epRepo = getEscrowPlanRepository()
            const now = Date.now()
            frRepo.update(frId, (current) => ({
              ...current,
              status: 'funded',
              fundedAt: now,
              updatedAt: now,
            }))
            const epId = result.data.escrowPlanId || plan?.id
            if (epId) {
              epRepo.updatePlan(epId, (current) => ({
                ...current,
                status: 'funded_in_escrow',
                fundedAt: now,
                updatedAt: now,
              }))
            }
          }
        }

        setPaymentPhase('idle')
        setIsPending(false)
        return
      }

      // Server confirmed but not yet funded_in_escrow — enter reconciliation
      logInfo('payment.confirm_funding_accepted_pending_reconciliation', {
        jobId,
        status: result.data.status,
      })
      setPaymentPhase('reconciliation-pending')
      setIsPending(false)
    } catch (e) {
      // Network / unexpected error — still enter reconciliation rather than
      // showing a dead-end error. The payment already succeeded on Stripe.
      logWarning('payment.confirm_funding_error_entering_reconciliation', {
        jobId,
        error: e instanceof Error ? e.message : String(e),
      })
      const diagnostic = buildDiagnostic({
        source: 'PAYMENT_INIT',
        step: 'confirm_funding_server',
        name: 'CustomerEscrowFundingCard.handleStripeConfirmed',
        error: e,
        details: { jobId, provider: providerName },
        hint: 'Server-side confirm funding failed. Entering reconciliation polling.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setPaymentPhase('reconciliation-pending')
      setIsPending(false)
    }
  }, [jobId, providerName])

  const handleStripeError = useCallback((msg: string) => {
    // stripe.confirmPayment returned an error — charge did not happen.
    // Revert to payment-form-ready so the PaymentElement remounts and the
    // user can correct their card details without having to restart the flow.
    setPaymentPhase('payment-form-ready')
    paymentPhaseRef.current = 'payment-form-ready'
    setError(msg)
    const diagnostic = buildDiagnostic({
      source: 'PAYMENT_INIT',
      step: 'stripe_payment',
      name: 'CustomerEscrowFundingCard.handleStripeError',
      error: msg,
      hint: 'Stripe PaymentElement surfaced an error message.',
    })
    emitDiagnostic(diagnostic)
    setDebugInfo(diagnostic)
  }, [])

  // Stripe form submitted — charge may already be in flight before confirmPayment
  // resolves. Promote to confirming-payment immediately so navigation is blocked.
  const handleStripeSubmitStart = useCallback(() => {
    setPaymentPhase('confirming-payment')
    paymentPhaseRef.current = 'confirming-payment'
  }, [])

  /** Re-enter reconciliation polling from the timeout state. */
  const handleRetryReconciliation = useCallback(() => {
    logInfo('payment.reconciliation_retry', { jobId })
    setPaymentPhase('reconciliation-pending')
  }, [jobId])

  // Expose startPayment so a parent CTA (e.g. CustomerProjectStateBlock) can
  // trigger the payment flow directly without duplicating any payment logic.
  useImperativeHandle(ref, () => ({ startPayment: handleStartPayment }), [handleStartPayment])

  // ---------------------------------------------------------------------------
  // Reconciliation polling — bounded poll against canonical funding truth
  // ---------------------------------------------------------------------------

  const reconciliationStartRef = useRef<number>(0)

  useEffect(() => {
    if (paymentPhase !== 'reconciliation-pending') return

    const frId = fundingRequest?.id
    if (!frId) {
      logWarning('payment.reconciliation_no_fr_id', { jobId })
      setPaymentPhase('reconciliation-timeout')
      return
    }

    reconciliationStartRef.current = Date.now()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = () => {
      if (cancelled) return

      // Check bounded window
      if (Date.now() - reconciliationStartRef.current > RECONCILIATION_MAX_DURATION_MS) {
        logWarning('payment.reconciliation_timeout', { jobId, fundingRequestId: frId })
        setPaymentPhase('reconciliation-timeout')
        return
      }

      fetchFundingEntry(frId)
        .then((result) => {
          if (cancelled) return

          if (result.ok && result.data.fundingRequest.status === 'funded') {
            logInfo('payment.reconciliation_funded_observed', {
              jobId,
              fundingRequestId: frId,
            })
            // Apply canonical server payload — no local Date.now() patching
            applyCanonicalPayloadToRepos(result.data)
            setPaymentPhase('idle')
            return
          }

          // Not yet funded — schedule next poll
          timer = setTimeout(poll, RECONCILIATION_POLL_INTERVAL_MS)
        })
        .catch(() => {
          if (cancelled) return
          // Network error during poll — retry on next interval
          timer = setTimeout(poll, RECONCILIATION_POLL_INTERVAL_MS)
        })
    }

    // Start first poll after a short delay to let the server settle
    timer = setTimeout(poll, RECONCILIATION_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [paymentPhase, fundingRequest?.id, jobId])

  // Funded state: CustomerPaymentSummaryCard is the leading view for this state.
  // The detail card would only repeat "Zahlung bestätigt" and the
  // amount already shown in the summary — suppress it here.
  if (fundingRequest?.status === 'funded') return null

  // Post-funding payment states have no funding request and never will —
  // suppress the card entirely rather than showing a misleading loading state.
  // CustomerPaymentSummaryCard covers these states.
  const jobPaymentState = getJobById(jobId)?.paymentState
  if (!fundingRequest && jobPaymentState && [
    'in_escrow', 'work_in_progress', 'release_pending', 'released', 'refunded', 'disputed',
  ].includes(jobPaymentState)) {
    return null
  }

  // No funding request: only show a loading skeleton while the repository is
  // still hydrating (brief transitional window).  Once hydrated with no result
  // the card is simply not applicable for this job — return null so
  // CustomerPaymentSummaryCard remains the sole payment surface without a
  // contradictory "loading" indicator appearing alongside its CTA.
  if (!fundingRequest) {
    if (!frRepoHydrated) {
      return (
        <section
          data-testid="customer-escrow-funding-card-loading"
          className="relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-slate-200/70"
        >
          <div className="flex flex-col items-center py-6 text-center">
            <Spinner size="md" tone="brand" label="Zahlungsdaten werden geladen…" />
          </div>
        </section>
      )
    }
    return null
  }

  return (
    <>
      {blocker.state === 'blocked' && (
        <div className="mb-3 rounded-card bg-red-50 px-3 py-3 ring-1 ring-red-200/60">
          <p className="mb-1 text-[13px] font-semibold text-red-800">
            Zahlung läuft – bitte nicht verlassen
          </p>
          <p className="mb-2 text-[12px] leading-relaxed text-red-700">
            Deine Zahlung wird gerade verarbeitet. Wenn du jetzt die Seite verlässt, könnte der Status nicht korrekt angezeigt werden.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => blocker.reset()}
              className="flex-1 rounded-card bg-red-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-red-700"
            >
              Hier bleiben
            </button>
            <button
              type="button"
              onClick={() => blocker.proceed()}
              className="flex-1 rounded-card bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Trotzdem verlassen
            </button>
          </div>
        </div>
      )}
      <CustomerEscrowFundingCardView
        fundingRequest={fundingRequest}
        escrowPlan={escrowPlan}
        providerName={providerName}
        clientSecret={clientSecret}
        paymentPhase={paymentPhase}
        onStartPayment={handleStartPayment}
        onMockConfirm={handleMockConfirm}
        onStripeSuccess={handleStripeConfirmed}
        onStripeError={handleStripeError}
        onStripeSubmitStart={handleStripeSubmitStart}
        onRetry={handleStartPayment}
        onRetryPayment={handleRetryPayment}
        onRetryReconciliation={handleRetryReconciliation}
        isPending={isPending}
        error={error}
        isPayoutBlock={isPayoutBlock}
        attributionBlock={attributionBlock}
        debugInfo={debugInfo}
      />
    </>
  )
})

export default CustomerEscrowFundingCard
