import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { ContentSection } from '../components/primitives'
import DiagnosticDebugBlock from '../components/DiagnosticDebugBlock'
import PayoutReadinessCard from '../components/payout/PayoutReadinessCard'
import type { PayoutReadinessStatus } from '../lib/payout/types'
import { supabase } from '../lib/supabase'
import { recordAnalyticsEventOnce } from '../lib/analytics'
import { fetchPayoutStatus, startStripeOnboarding, resolvePayoutErrorMessage } from '../lib/payout/client'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../lib/diagnostics'
import { openExternal, isNative } from '../lib/platform'
import { useSession } from '../hooks/useSession'
import { useSmartBack } from '../hooks/useSmartBack'

type SetupState = 'idle' | 'loading' | 'error'


export default function PayoutSetupScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/finance')
  const { user, sessionValidated } = useSession()
  const [readinessStatus, setReadinessStatus] = useState<PayoutReadinessStatus>('no_account')
  const [setupState, setSetupState] = useState<SetupState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<RuntimeDiagnostic | null>(null)
  const actionInFlight = useRef(false)
  // Always points to the latest handleStatusCheck — avoids stale closure in the listener.
  const statusCheckRef = useRef<() => void>(() => {})

  async function getAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  // Keep ref current on every render so the browserFinished listener always
  // calls the latest version (which closes over current sessionValidated/user).
  statusCheckRef.current = () => { void handleStatusCheck() }

  useEffect(() => {
    if (!sessionValidated) return
    void handleStatusCheck()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionValidated])

  useEffect(() => {
    if (!isNative()) return
    let handle: { remove: () => Promise<void> } | null = null
    let mounted = true
    void (async () => {
      const { Browser } = await import('@capacitor/browser')
      const h = await Browser.addListener('browserFinished', () => {
        statusCheckRef.current()
      })
      if (!mounted) { void h.remove() } else { handle = h }
    })()
    return () => {
      mounted = false
      if (handle) void handle.remove()
    }
  }, [])

  async function handleSetup() {
    if (actionInFlight.current) return
    if (!sessionValidated || !user) {
      setErrorMessage('Session noch nicht bereit. Bitte einen Moment warten.')
      setSetupState('error')
      return
    }
    actionInFlight.current = true
    setSetupState('loading')
    setErrorMessage(null)
    setDebugInfo(null)

    try {
      const token = await getAccessToken()
      if (!token) {
        setErrorMessage('Kein gültiges Zugriffstoken. Bitte neu anmelden.')
        setSetupState('error')
        return
      }
      const { onboardingUrl } = await startStripeOnboarding(token)
      setReadinessStatus('onboarding_in_progress')
      await openExternal(onboardingUrl)
      setSetupState('idle')
    } catch (err: unknown) {
      const diagnostic = buildDiagnostic({
        source: 'STRIPE_CONNECT',
        step: 'start_onboarding',
        name: 'PayoutSetupScreen.handleSetup',
        error: err,
        hint: 'Check Stripe account creation endpoint response.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      const message = resolvePayoutErrorMessage(err)
      setErrorMessage(message)
      setSetupState('error')
    } finally {
      actionInFlight.current = false
    }
  }

  async function handleStatusCheck() {
    if (actionInFlight.current) return
    if (!sessionValidated || !user) return
    actionInFlight.current = true
    setSetupState('loading')
    setErrorMessage(null)
    setDebugInfo(null)

    try {
      const token = await getAccessToken()
      if (!token) {
        setErrorMessage('Kein gültiges Zugriffstoken. Bitte neu anmelden.')
        setSetupState('error')
        return
      }

      const { readiness, account } = await fetchPayoutStatus(token)
      setReadinessStatus(readiness)

      if (readiness === 'payout_ready') {
        recordAnalyticsEventOnce({
          eventType: 'payout_ready',
          entityType: 'provider',
          entityId: account?.stripeConnectAccountId ?? '',
        })
        navigate('/craftsman/finance')
        return
      }

      setSetupState('idle')
    } catch (err: unknown) {
      const diagnostic = buildDiagnostic({
        source: 'CONNECT_STATUS',
        step: 'fetch_status',
        name: 'PayoutSetupScreen.handleStatusCheck',
        error: err,
        hint: 'Verify auth token and payout-account-status API.',
      })
      emitDiagnostic(diagnostic)
      setDebugInfo(diagnostic)
      const message = resolvePayoutErrorMessage(err)
      setErrorMessage(message)
      setSetupState('error')
    } finally {
      actionInFlight.current = false
    }
  }

  const isLoading = setupState === 'loading'
  const isDisabled = isLoading || !sessionValidated || !user

  // Initial session validation and in-flight status/setup checks show a
  // structure-retaining skeleton instead of bare "Bitte warten…" text.
  if (!sessionValidated || !user || isLoading) {
    return (
      <AppShell active="home">
        <ScreenSkeleton variant="detail" eyebrow="Auszahlung" />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <ContentSection eyebrow="Backoffice" title="Auszahlungen einrichten">
            <p className="mb-3 text-[13px] text-ink-muted">
              Verbinde dein Stripe-Konto für Auszahlungen aus abgeschlossenen Jobs.
            </p>

            <PayoutReadinessCard
              status={readinessStatus}
              onSetup={() => { void handleSetup() }}
              disabled={isDisabled}
            />

            {setupState === 'error' && errorMessage && (
              <div className="mt-3 rounded-card bg-danger/5 p-3 ring-1 ring-danger/20 text-[13px] text-danger">
                {errorMessage}
              </div>
            )}
            <DiagnosticDebugBlock diagnostic={debugInfo} />

            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => { void handleStatusCheck() }}
                disabled={isDisabled}
                className="text-[12px] text-ink-muted underline underline-offset-4 transition hover:text-ink-sub disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Status aktualisieren
              </button>
            </div>
          </ContentSection>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={goBack}
              className="text-[13px] text-ink-muted underline underline-offset-2 transition hover:text-ink-sub"
            >
              Zurück
            </button>
          </div>
        </div>
      </section>
    </AppShell>
  )
}
