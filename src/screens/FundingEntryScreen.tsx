import { useParams, Navigate, Link, useLocation } from 'react-router-dom'
import { useState, useCallback, useEffect, useRef } from 'react'
import { logInfo, logWarning } from '../lib/observability'
import { getFundingRequestById, getFundingRequestRepository, initializeFundingRequestRepository } from '../lib/payments/fundingRequest'
import { getEscrowPlanById, getEscrowPlanRepository, initializeEscrowPlanRepository } from '../lib/payments/escrow'
import { initializeJobRepository } from '../lib/jobs'
import { getProjectByJobId } from '../lib/projects'
import { useStoreSync } from '../lib/reactive'
import { fetchFundingEntry } from '../lib/funding/fundingEntryApi'
import type { FundingEntryPayload, FundingEntryErrorCode } from '../lib/funding/fundingEntryApi'
import CustomerEscrowFundingCard from '../components/projects/CustomerEscrowFundingCard'
import PaymentErrorBoundary from '../components/system/PaymentErrorBoundary'
import { Icon } from '../components/primitives'
import { CreditCard, AlertTriangle, Lock, Clock, XCircle, Shield, CheckCircle, FileText } from 'lucide-react'
import type { FundingRequest, FundingRequestType } from '../lib/payments/fundingRequest'
import type { EscrowPaymentPlan, EscrowFundingMode, EscrowReleaseModel } from '../lib/payments/escrow'
import type { CurrencyCode } from '../lib/shared/coreTypes'
import { getMyCustomerBillingProfile } from '../lib/customer/customerBillingProfileService'
import {
  deriveFundingBillingGate,
  isCustomerBillingProfileComplete,
} from '../lib/customer/customerBillingProfileSelectors'
import { useSmartBack } from '../hooks/useSmartBack'

// ---------------------------------------------------------------------------
// Load phase — distinct states so the screen never collapses a secondary
// context failure into a false "not found" message.
// ---------------------------------------------------------------------------

type LoadPhase =
  | 'loading'             // Initial load / hydration in progress
  | 'ready'               // All context loaded, ready to render payment UI
  | 'not-found'           // Funding request truly not found after hydration
  | 'not-accessible'      // Funding request exists but user has no access
  | 'context-incomplete'  // Funding request found but escrow plan / payment context missing
  | 'error'               // Hydration failed with an error

// ---------------------------------------------------------------------------
// German user-facing messages per error code
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<FundingEntryErrorCode, { title: string; detail: string }> = {
  FUNDING_REQUEST_NOT_FOUND: {
    title: 'Zahlungsanfrage nicht gefunden',
    detail: 'Die angeforderte Zahlung existiert nicht. Bitte versuchen Sie es über die Nachricht erneut.',
  },
  FUNDING_REQUEST_NOT_ACCESSIBLE: {
    title: 'Kein Zugriff',
    detail: 'Sie haben keinen Zugriff auf diese Zahlungsanfrage.',
  },
  ESCROW_PLAN_NOT_FOUND: {
    title: 'Zahlungsplan nicht gefunden',
    detail: 'Die Zahlungsanfrage wurde gefunden, aber der Zahlungsplan konnte nicht geladen werden. Bitte versuchen Sie es später erneut.',
  },
  JOB_CONTEXT_NOT_FOUND: {
    title: 'Zahlungskontext nicht verfügbar',
    detail: 'Die Zahlungsanfrage wurde gefunden, aber der Zahlungskontext konnte nicht geladen werden. Bitte versuchen Sie es später erneut.',
  },
}

// ---------------------------------------------------------------------------
// Payload → domain-type converters
// ---------------------------------------------------------------------------

function parseTimestampMs(val: string | undefined): number | undefined {
  if (!val) return undefined
  const ms = new Date(val).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

function payloadToFundingRequest(p: FundingEntryPayload['fundingRequest']): FundingRequest {
  return {
    id: p.id,
    sourceOfferId: p.sourceOfferId,
    jobId: p.jobId,
    escrowPlanId: p.escrowPlanId,
    customerUserId: p.customerUserId,
    providerId: p.providerId,
    providerUserId: p.providerUserId,
    type: p.type as FundingRequestType,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    createdBy: p.createdBy as 'provider' | 'system',
    conversationId: p.conversationId,
    messageId: p.messageId,
    createdAt: parseTimestampMs(p.createdAt) ?? Date.now(),
    updatedAt: parseTimestampMs(p.updatedAt) ?? Date.now(),
    sentAt: parseTimestampMs(p.sentAt),
    fundedAt: parseTimestampMs(p.fundedAt),
    externalFundingRef: p.externalFundingRef,
    fundingIdempotencyKey: p.fundingIdempotencyKey,
    failureReason: p.failureReason,
  }
}

function payloadToEscrowPlan(p: FundingEntryPayload['escrowPlan']): EscrowPaymentPlan {
  return {
    id: p.id,
    sourceOfferId: p.sourceOfferId,
    jobId: p.jobId,
    customerUserId: p.customerUserId,
    providerId: p.providerId,
    currency: p.currency as CurrencyCode,
    totalAmount: p.totalAmount,
    fundingMode: p.fundingMode as EscrowFundingMode,
    releaseModel: p.releaseModel as EscrowReleaseModel,
    status: p.status,
    createdAt: parseTimestampMs(p.createdAt) ?? Date.now(),
    updatedAt: parseTimestampMs(p.updatedAt) ?? Date.now(),
    fundingInitiatedAt: parseTimestampMs(p.fundingInitiatedAt),
    fundedAt: parseTimestampMs(p.fundedAt),
    externalFundingRef: p.externalFundingRef,
    fundingIdempotencyKey: p.fundingIdempotencyKey,
  }
}

/**
 * Seeds the in-memory funding request and escrow plan repositories from the
 * server-authoritative payload. This ensures that downstream components
 * (CustomerEscrowFundingCard) can find the data via store lookups immediately,
 * without waiting for async repo initialization (which is a no-op for InMemory).
 */
function seedReposFromPayload(payload: FundingEntryPayload): void {
  const fr = payloadToFundingRequest(payload.fundingRequest)
  const plan = payloadToEscrowPlan(payload.escrowPlan)

  const frRepo = getFundingRequestRepository()
  if (!frRepo.getById(fr.id)) {
    frRepo.add(fr)
    logInfo('[FundingEntry] seeded funding request into repo', { id: fr.id })
  } else {
    frRepo.update(fr.id, () => fr)
  }

  const epRepo = getEscrowPlanRepository()
  if (!epRepo.getPlanById(plan.id)) {
    epRepo.addPlan(plan)
    logInfo('[FundingEntry] seeded escrow plan into repo', { id: plan.id })
  } else {
    epRepo.updatePlan(plan.id, () => plan)
  }
}

/**
 * Dedicated Funding Entry Screen
 *
 * Canonical entry point for all customer funding / payment flows.
 * Route: /funding/:fundingRequestId
 *
 * This screen is keyed by funding truth (fundingRequestId), NOT by
 * project-store hydration. It loads the funding request directly and
 * renders the real Stripe-backed payment UI (CustomerEscrowFundingCard).
 *
 * Read strategy (server-authoritative):
 * 1. Read fundingRequestId from route
 * 2. Call GET /api/funding-entry?fundingRequestId=… (server-authoritative read)
 * 3. Receive full canonical payment context in one payload
 * 4. Render the real payment UI from that context
 * 5. Sync local repos afterward for consistency (non-blocking)
 *
 * Fallback strategy (local stores):
 * If the server read is unavailable (e.g. no auth token, network error),
 * the screen falls back to local store hydration as a secondary path.
 *
 * Survives:
 * - Cold start / delayed hydration
 * - Hard reload / app reopen
 * - Push notification / thread deep-link
 * - Empty job/project stores on first mount
 *
 * Behaviour by funding status:
 * - created/sent      → "Pay now" path (CustomerEscrowFundingCard renders CTA)
 * - funding_started   → "Continue payment" path (Stripe element or mock confirm)
 * - funded            → Funded state (no pay CTA)
 * - funding_failed    → Retry path
 * - cancelled/expired → Inactive state
 */
export default function FundingEntryScreen() {
  const { fundingRequestId } = useParams<{ fundingRequestId: string }>()
  const location = useLocation()
  const goBack = useSmartBack('/projects')

  // ── Core state ──────────────────────────────────────────────────────────

  const [fundingRequest, setFundingRequest] = useState<FundingRequest | undefined>(
    () => (fundingRequestId ? getFundingRequestById(fundingRequestId) : undefined),
  )

  const [escrowPlan, setEscrowPlan] = useState<EscrowPaymentPlan | undefined>(() => {
    if (!fundingRequest) return undefined
    return getEscrowPlanById(fundingRequest.escrowPlanId)
  })

  const [loadPhase, setLoadPhase] = useState<LoadPhase>(() => {
    if (fundingRequest && escrowPlan) return 'ready'
    if (fundingRequest && !escrowPlan) return 'context-incomplete'
    return 'loading'
  })

  const [errorCode, setErrorCode] = useState<FundingEntryErrorCode | undefined>()

  // ── Server read payload — kept for jobId to pass to CustomerEscrowFundingCard
  const [serverPayload, setServerPayload] = useState<FundingEntryPayload | undefined>()

  // ── Customer Billing Profile gate (Block 7.1B2) ─────────────────────────
  // Pre-funding wird geprüft, ob der Customer Rechnungsdaten hinterlegt hat.
  // Bei unvollständigem Profil zeigt der Screen eine CTA-Card statt direkt
  // die Stripe-Form zu mounten. Nach Save aus dem Edit-Screen führt der
  // `?return=`-Param zurück hierher; der Effekt revalidiert den Status, weil
  // er bei jedem Pathname-Wechsel + bei Funding-Status-Änderung re-läuft.
  const [billingGate, setBillingGate] =
    useState<'loading' | 'complete' | 'incomplete'>('loading')
  const [billingGateError, setBillingGateError] = useState<string | null>(null)

  const hydrationAttempted = useRef(false)

  // ── Store subscriptions — react to async data arrival ───────────────────

  const subscribeFundingRequests = useCallback(
    (listener: () => void) => getFundingRequestRepository().subscribe(listener),
    [],
  )
  const subscribeEscrowPlans = useCallback(
    (listener: () => void) => getEscrowPlanRepository().subscribe(listener),
    [],
  )

  useStoreSync([subscribeFundingRequests, subscribeEscrowPlans], () => {
    if (!fundingRequestId) return
    const fr = getFundingRequestById(fundingRequestId)
    setFundingRequest(fr)
    if (fr) {
      const plan = getEscrowPlanById(fr.escrowPlanId)
      setEscrowPlan(plan)
      if (plan && loadPhase !== 'ready') {
        setLoadPhase('ready')
      }
    }
  })

  // ── Fallback: local store hydration ─────────────────────────────────────

  const fallbackToLocalHydration = useCallback(
    (frId: string, serverErrorCode?: FundingEntryErrorCode) => {
      Promise.all([
        initializeFundingRequestRepository(),
        initializeEscrowPlanRepository(),
        initializeJobRepository(),
      ]).then(() => {
        const fr = getFundingRequestById(frId)
        if (fr) {
          setFundingRequest(fr)
          const plan = getEscrowPlanById(fr.escrowPlanId)
          setEscrowPlan(plan)
          if (plan) {
            setLoadPhase('ready')
          } else {
            setErrorCode('ESCROW_PLAN_NOT_FOUND')
            setLoadPhase('context-incomplete')
          }
        } else {
          if (serverErrorCode) {
            setErrorCode(serverErrorCode)
          }
          setLoadPhase('not-found')
        }
      }).catch(() => {
        if (serverErrorCode) {
          setErrorCode(serverErrorCode)
          setLoadPhase('not-found')
        } else {
          setLoadPhase('error')
        }
      })
    },
    [],
  )

  // ── Background local repo sync (after successful server read) ───────────

  const syncLocalRepos = useCallback(
    (frId: string) => {
      Promise.all([
        initializeFundingRequestRepository(),
        initializeEscrowPlanRepository(),
        initializeJobRepository(),
      ]).then(() => {
        const fr = getFundingRequestById(frId)
        if (fr) {
          setFundingRequest(fr)
          const plan = getEscrowPlanById(fr.escrowPlanId)
          if (plan) setEscrowPlan(plan)
        }
      }).catch(() => {
        // Background sync failure is non-critical — server payload is already applied.
      })
    },
    [],
  )

  // ── Primary: Server-authoritative read on mount ─────────────────────────

  useEffect(() => {
    if (hydrationAttempted.current || !fundingRequestId) return

    // Already resolved from local stores on initial render
    if (fundingRequest && escrowPlan) {
      hydrationAttempted.current = true
      return
    }

    hydrationAttempted.current = true
    logInfo('[FundingEntry] starting server-authoritative read', { fundingRequestId })

    fetchFundingEntry(fundingRequestId)
      .then((result) => {
        if (result.ok) {
          const payload = result.data

          // Seed in-memory repos from server payload BEFORE setting ready.
          // This ensures CustomerEscrowFundingCard can find the data via
          // store lookups immediately, preventing blank screen.
          seedReposFromPayload(payload)

          setServerPayload(payload)
          setLoadPhase('ready')

          // Sync local repos in background (non-blocking, best-effort)
          syncLocalRepos(fundingRequestId)
        } else {
          // If server endpoint is unavailable (5xx, network), fall back to local stores
          if (result.statusCode && result.statusCode >= 500) {
            fallbackToLocalHydration(fundingRequestId)
            return
          }

          // Map server error codes to precise load phases
          if (result.errorCode === 'FUNDING_REQUEST_NOT_FOUND') {
            // Double-check: try local stores in case server is temporarily stale
            fallbackToLocalHydration(fundingRequestId, 'FUNDING_REQUEST_NOT_FOUND')
          } else if (result.errorCode === 'FUNDING_REQUEST_NOT_ACCESSIBLE') {
            setErrorCode('FUNDING_REQUEST_NOT_ACCESSIBLE')
            setLoadPhase('not-accessible')
          } else if (
            result.errorCode === 'ESCROW_PLAN_NOT_FOUND' ||
            result.errorCode === 'JOB_CONTEXT_NOT_FOUND'
          ) {
            setErrorCode(result.errorCode)
            setLoadPhase('context-incomplete')
          } else {
            // No auth token / other client error — fall back to local stores
            fallbackToLocalHydration(fundingRequestId)
          }
        }
      })
      .catch((err: unknown) => {
        logWarning('funding_entry.server_read_failed', { fundingRequestId, error: String(err) })
        fallbackToLocalHydration(fundingRequestId)
      })
  }, [fundingRequest, fundingRequestId, escrowPlan, fallbackToLocalHydration, syncLocalRepos])

  // ── Customer Billing Profile gate (Block 7.1B2) ─────────────────────────
  //
  // Re-evaluiert sich bei jedem Routing-Wechsel: nach Save im Edit-Screen
  // (navigate(returnTo, {replace}) erzeugt eine neue location.key) liest der
  // Effekt den frisch gespeicherten Status, ohne dass der Funding-Screen
  // unmounten muss.
  useEffect(() => {
    let cancelled = false

    getMyCustomerBillingProfile()
      .then((profile) => {
        if (cancelled) return
        setBillingGate(
          isCustomerBillingProfileComplete(profile) ? 'complete' : 'incomplete',
        )
        setBillingGateError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        logWarning('funding_entry.billing_profile_load_failed', {
          fundingRequestId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Bei Lade-Fehler bewusst nicht silently als „complete" durchwinken —
        // sonst überspringen wir das Gate und lassen den Customer in eine
        // Issuance ohne Rechnungsdaten laufen. Stattdessen: Error sichtbar
        // machen, Gate bleibt geschlossen.
        setBillingGate('incomplete')
        setBillingGateError(
          err instanceof Error ? err.message : 'Rechnungsdaten konnten nicht geladen werden.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [location.key, fundingRequestId])

  // ── Resolve the jobId for CustomerEscrowFundingCard ─────────────────────

  const resolvedJobId = serverPayload?.fundingRequest.jobId ?? fundingRequest?.jobId

  // ── Render ──────────────────────────────────────────────────────────────

  // No fundingRequestId in URL
  if (!fundingRequestId) {
    logWarning('funding_entry.no_funding_request_id_param', { route: window.location.href })
    return <Navigate to="/" replace />
  }

  // Loading — hydration in progress
  if (loadPhase === 'loading') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={CreditCard} size="lg" className="mx-auto text-brand" />
          <h1 className="text-[18px] font-semibold text-ink">
            Zahlung wird geladen…
          </h1>
          <p className="text-[14px] text-ink-muted">
            Deine Zahlungsinformationen werden vorbereitet.
          </p>
        </div>
      </div>
    )
  }

  // Funding request truly not found after server + local hydration
  if (loadPhase === 'not-found') {
    const msgs = errorCode ? ERROR_MESSAGES[errorCode] : undefined
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={AlertTriangle} size="lg" className="mx-auto text-warn" />
          <h1 className="text-[18px] font-semibold text-ink">
            {msgs?.title ?? 'Zahlungsanfrage nicht gefunden'}
          </h1>
          <p className="text-[14px] text-ink-muted">
            {msgs?.detail ?? 'Die angeforderte Zahlung existiert nicht. Bitte versuchen Sie es über die Nachricht erneut.'}
          </p>
        </div>
      </div>
    )
  }

  // Access denied — funding request exists but user has no access
  if (loadPhase === 'not-accessible') {
    const msgs = ERROR_MESSAGES.FUNDING_REQUEST_NOT_ACCESSIBLE
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={Lock} size="lg" className="mx-auto text-ink-muted" />
          <h1 className="text-[18px] font-semibold text-ink">
            {msgs.title}
          </h1>
          <p className="text-[14px] text-ink-muted">
            {msgs.detail}
          </p>
        </div>
      </div>
    )
  }

  // Funding request found but payment context (escrow plan / job) is missing
  if (loadPhase === 'context-incomplete') {
    const msgs = errorCode ? ERROR_MESSAGES[errorCode] : undefined
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={Clock} size="lg" className="mx-auto text-ink-muted" />
          <h1 className="text-[18px] font-semibold text-ink">
            {msgs?.title ?? 'Zahlungskontext wird geladen'}
          </h1>
          <p className="text-[14px] text-ink-muted">
            {msgs?.detail ?? 'Die Zahlungsanfrage wurde gefunden, aber der Zahlungskontext konnte nicht vollständig geladen werden. Bitte versuchen Sie es später erneut.'}
          </p>
        </div>
      </div>
    )
  }

  // Hydration error
  if (loadPhase === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={XCircle} size="lg" className="mx-auto text-danger" />
          <h1 className="text-[18px] font-semibold text-ink">
            Zahlungsdaten konnten nicht geladen werden
          </h1>
          <p className="text-[14px] text-ink-muted">
            Beim Laden der Zahlungsinformationen ist ein Fehler aufgetreten.
            Bitte versuchen Sie es später erneut.
          </p>
        </div>
      </div>
    )
  }

  // Ready — render the real Stripe-backed payment UI
  if (!resolvedJobId) {
    logWarning('funding_entry.ready_but_no_job_id', { fundingRequestId, hasServerPayload: !!serverPayload })
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <Icon icon={XCircle} size="lg" className="mx-auto text-danger" />
          <h1 className="text-[18px] font-semibold text-ink">
            Zahlungsdaten konnten nicht geladen werden
          </h1>
          <p className="text-[14px] text-ink-muted">
            Beim Laden der Zahlungsinformationen ist ein Fehler aufgetreten.
            Bitte versuchen Sie es später erneut.
          </p>
        </div>
      </div>
    )
  }

  // ── Derive server-authoritative domain objects for payload-driven card ───
  const serverFundingRequest = serverPayload
    ? payloadToFundingRequest(serverPayload.fundingRequest)
    : undefined
  const serverEscrowPlan = serverPayload
    ? payloadToEscrowPlan(serverPayload.escrowPlan)
    : undefined

  const backProject = resolvedJobId ? getProjectByJobId(resolvedJobId) : undefined
  const backTarget = backProject ? `/projects/${backProject.id}` : '/projects'
  const isFunded = serverFundingRequest?.status === 'funded' || fundingRequest?.status === 'funded'

  // Billing-Gate-Decision via reinen Selector — der Selector kapselt die
  // Pre-Funding-Phase-Check + den Laden-/Unvollständig-Fallback und ist
  // separat unit-getestet (siehe customerBillingProfileSelectors.test.ts).
  const fundingStatus = serverFundingRequest?.status ?? fundingRequest?.status
  const gateDecision = deriveFundingBillingGate({
    fundingStatus,
    billingPhase: billingGate,
  })
  const showBillingGate = gateDecision === 'show-gate'
  const billingReturnPath = `${location.pathname}${location.search}`
  const billingProfileHref = `/account/billing-profile?return=${encodeURIComponent(billingReturnPath)}`

  logInfo('[FundingEntry] rendering payment UI for job', { jobId: resolvedJobId, fundingRequestId, hasServerPayload: !!serverPayload, isFunded, billingGate, gateDecision })

  // ── Funded success state — card hides itself; screen must show completion ──
  if (isFunded) {
    return (
      <div className="min-h-screen bg-canvas px-4 py-8">
        <div className="mx-auto w-full max-w-md space-y-4">
          <div className="rounded-card bg-ok/5 px-5 py-6 ring-1 ring-ok/20 space-y-3 text-center">
            <Icon icon={CheckCircle} size="lg" className="mx-auto text-ok" />
            <h1 className="text-[18px] font-semibold text-ink">
              Einzahlung gesichert
            </h1>
            <p className="text-[14px] text-ink-muted">
              Dein Betrag ist über Stripe abgesichert und wird nach Abschluss der Arbeit freigegeben.
            </p>
          </div>
          <Link
            to={backTarget}
            className="flex w-full items-center justify-center rounded-card bg-brand px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition active:scale-[0.98]"
          >
            Zum Projekt
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas px-4 py-8">
      <div className="mx-auto w-full max-w-md space-y-3">
        {/* ── Back navigation ── */}
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-1 text-[13px] text-ink-sub active:opacity-70"
        >
          ← Zurück
        </button>

        {/* ── Trust signal ── */}
        <div className="flex items-center gap-2 rounded-card bg-ok/5 px-4 py-3 ring-1 ring-ok/20">
          <Icon icon={Shield} size="sm" className="shrink-0 text-ok" />
          <p className="text-[13px] text-ok">
            Dein Betrag wird nach der Einzahlung über Stripe abgesichert bis zur Freigabe.
          </p>
        </div>

        {showBillingGate ? (
          <section
            data-testid="funding-billing-gate"
            className="space-y-3 rounded-card bg-amber-50 px-5 py-5 ring-1 ring-amber-200"
          >
            <div className="flex items-center gap-2">
              <Icon icon={FileText} size="sm" className="shrink-0 text-amber-700" />
              <h2 className="text-[15px] font-semibold text-amber-900">
                Rechnungsdaten ergänzen
              </h2>
            </div>
            <p className="text-[13px] leading-relaxed text-amber-900/90">
              Bevor du diesen Auftrag in das Stripe-Absicherung einzahlst, ergänze
              bitte deine Rechnungsdaten. Diese Daten werden später für deinen
              Rechnungsbeleg verwendet.
            </p>
            {billingGate === 'loading' ? (
              <p className="text-[12px] text-amber-800/80">Status wird geprüft …</p>
            ) : null}
            {billingGateError ? (
              <p className="text-[12px] text-amber-900/80">{billingGateError}</p>
            ) : null}
            <Link
              to={billingProfileHref}
              data-testid="funding-billing-gate-cta"
              className="inline-flex w-full items-center justify-center rounded-card bg-amber-600 px-4 py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
            >
              Rechnungsdaten ergänzen
            </Link>
          </section>
        ) : (
          <PaymentErrorBoundary>
            <CustomerEscrowFundingCard
              jobId={resolvedJobId}
              serverFundingRequest={serverFundingRequest}
              serverEscrowPlan={serverEscrowPlan}
            />
          </PaymentErrorBoundary>
        )}
      </div>
    </div>
  )
}
