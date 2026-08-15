import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { ContentSection } from '../components/primitives'
import DiagnosticDebugBlock from '../components/DiagnosticDebugBlock'
import PayoutReadinessCard from '../components/payout/PayoutReadinessCard'
import type { PayoutReadinessStatus } from '../lib/payout/types'
import { fetchPayoutStatus, startStripeOnboarding, resolvePayoutErrorMessage } from '../lib/payout/client'
import { supabase } from '../lib/supabase'
import { recordAnalyticsEventOnce } from '../lib/analytics'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../lib/diagnostics'
import { openExternal } from '../lib/platform'

type ScreenState = 'loading' | 'idle' | 'error' | 'no_session'

export default function PayoutReturnScreen() {
  const navigate = useNavigate()
  const [readinessStatus, setReadinessStatus] = useState<PayoutReadinessStatus>('onboarding_in_progress')
  const [screenState, setScreenState] = useState<ScreenState>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<RuntimeDiagnostic | null>(null)
  const actionInFlight = useRef(false)

  useEffect(() => {
    void syncStatus()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function getAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  async function syncStatus() {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setScreenState('loading')
    setErrorMessage(null)
    setDebugInfo(null)
    try {
      const token = await getAccessToken()
      // No session in this browser context (SFSafariViewController after Stripe redirect).
      // Show a clear instruction instead of an auth error.
      if (!token) {
        setScreenState('no_session')
        return
      }
      const { readiness, account } = await fetchPayoutStatus(token)
      setReadinessStatus(readiness)
      setStripeAccountId(account?.stripeConnectAccountId ?? null)

      if (readiness === 'payout_ready') {
        recordAnalyticsEventOnce({
          eventType: 'payout_ready',
          entityType: 'provider',
          entityId: account?.stripeConnectAccountId ?? '',
        })
      }

      setScreenState('idle')
    } catch (err: unknown) {
      const diagnostic = buildDiagnostic({
        source: 'CONNECT_STATUS',
        step: 'fetch_status',
        name: 'PayoutReturnScreen.syncStatus',
        error: err,
        hint: 'Check payout status endpoint and onboarding return params.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setErrorMessage(resolvePayoutErrorMessage(err))
      setScreenState('error')
    } finally {
      actionInFlight.current = false
    }
  }

  async function resumeOnboarding() {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setScreenState('loading')
    setErrorMessage(null)
    setDebugInfo(null)
    try {
      const token = await getAccessToken()
      const { onboardingUrl } = await startStripeOnboarding(token)
      setReadinessStatus('onboarding_in_progress')
      await openExternal(onboardingUrl)
      setScreenState('idle')
    } catch (err: unknown) {
      const diagnostic = buildDiagnostic({
        source: 'STRIPE_CONNECT',
        step: 'resume_onboarding',
        name: 'PayoutReturnScreen.resumeOnboarding',
        error: err,
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      setErrorMessage(resolvePayoutErrorMessage(err))
      setScreenState('error')
    } finally {
      actionInFlight.current = false
    }
  }

  const helperText = (() => {
    switch (readinessStatus) {
      case 'payout_ready':
        return 'Dein Konto ist bereit für Auszahlungen.'
      case 'payout_blocked':
        return 'Stripe benötigt weitere Angaben. Öffne das Stripe-Formular, um die Anforderungen zu erledigen.'
      case 'pending_verification':
        return 'Deine Angaben wurden eingereicht. Stripe prüft dein Konto — dies dauert in der Regel 1–2 Werktage.'
      case 'onboarding_in_progress':
        return 'Setze das Stripe-Onboarding fort oder prüfe den aktuellen Status.'
      case 'onboarding_required':
      case 'no_account':
        return 'Starte das Stripe-Onboarding, um Auszahlungen zu ermöglichen.'
    }
  })()

  // For pending_verification the card's "Status prüfen" button should sync status,
  // not create a new onboarding link — user already submitted, there is nothing to resume.
  const cardAction = readinessStatus === 'pending_verification'
    ? () => { void syncStatus() }
    : () => { void resumeOnboarding() }

  const isLoading = screenState === 'loading'

  if (screenState === 'no_session') {
    return (
      <AppShell active="home">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px]">
            <ContentSection eyebrow="Auszahlungen" title="Stripe-Setup abgeschlossen">
              <p className="text-[13px] text-ink-muted">
                Schließe diesen Browser mit &ldquo;Fertig&rdquo; — die App prüft dann deinen Status automatisch.
              </p>
            </ContentSection>
          </div>
        </section>
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <ContentSection eyebrow="Auszahlungen" title="Stripe-Setup fortsetzen">
            <p className="mb-3 text-[13px] text-ink-muted">{helperText}</p>

            <PayoutReadinessCard
              status={readinessStatus}
              onSetup={cardAction}
              disabled={isLoading}
            />

            {stripeAccountId && (
              <div className="mt-3 text-[12px] text-ink-muted">
                Verbundenes Konto: {stripeAccountId}
              </div>
            )}

            {isLoading && (
              <div className="mt-3 text-center text-[13px] text-ink-muted">
                Bitte warten, Status wird synchronisiert…
              </div>
            )}

            {screenState === 'error' && errorMessage && (
              <div className="mt-3 rounded-card bg-danger/5 p-3 ring-1 ring-danger/20 text-[13px] text-danger">
                {errorMessage}
              </div>
            )}
            <DiagnosticDebugBlock diagnostic={debugInfo} />

            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => { void syncStatus() }}
                disabled={isLoading}
                className="w-full rounded-container bg-surface px-4 py-3 text-[13px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Status aktualisieren
              </button>
              <button
                type="button"
                onClick={() => navigate('/craftsman/finance')}
                className="w-full rounded-container bg-canvas px-4 py-3 text-[13px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.98]"
              >
                Zur Finanzübersicht
              </button>
            </div>
          </ContentSection>
        </div>
      </section>
    </AppShell>
  )
}
