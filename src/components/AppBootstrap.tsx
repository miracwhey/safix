import { useEffect, useRef, useState } from 'react'
import * as Sentry from '@sentry/react'
import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { bootstrapRepositories } from '../lib/bootstrap'
import { formatBootstrapError } from '../lib/bootstrap/formatBootstrapError'
import { startNotificationBridge } from '../lib/notifications'
import { registerForPushNotifications } from '../lib/notifications/pushNotificationBridge'
import { initializeInAppNotificationRepository } from '../lib/inAppNotifications'
import { syncAllProjectsFromJobs, startProjectJobSyncBridge } from '../lib/projects/projectJobSyncBridge'
import { startOutboxRunner } from '../lib/media/outboxRunner'
import { getAuthSession } from '../lib/auth/authSingleFlight'
import { intentionalReload } from '../lib/lifecycle/killDetection'
import { logWarning } from '../lib/observability'

/**
 * Active-time budget per bootstrap attempt. Counted via a 1s ticker that
 * skips hidden/offline/suspended time — NOT a wall-clock setTimeout. A
 * wall-clock timer survives iOS suspension and fires immediately on the
 * next foreground, which showed users the fatal error screen for a boot
 * that never had 15s of actual runtime (FINDINGS 2026-06-11, P1).
 */
const BOOTSTRAP_TIMEOUT_MS = 15_000

/** Initial attempt + exactly one silent retry before the error screen. */
const MAX_BOOTSTRAP_ATTEMPTS = 2

/** Granularity of the active-time deadline ticker. */
const DEADLINE_TICK_MS = 1_000

/**
 * A tick arriving far later than scheduled means the WebView was suspended
 * mid-countdown (iOS background without a timely visibilitychange). That
 * gap is wall-clock time, not boot runtime — charge at most one tick.
 */
const SUSPENSION_DELTA_MS = DEADLINE_TICK_MS * 3

type BootstrapState = 'loading' | 'ready' | 'error' | 'offline'

/**
 * Emit the app_open funnel event at most once per JS context (page load).
 * Guards against StrictMode's double effect-run and the silent bootstrap retry,
 * both of which reach the post-bootstrap success path more than once.
 */
let appOpenTracked = false
function trackAppOpenOnce(): void {
  if (appOpenTracked) return
  appOpenTracked = true
  // Dynamic import so this module's load (and offline tests that import
  // AppBootstrap) never pull analytics/track -> ../session -> onAuthStateChange.
  // Fire-and-forget; analytics never throws and a load failure is non-critical.
  void import('../lib/analytics/track').then((m) => m.track('app_open')).catch(() => {})
}

interface AppBootstrapProps {
  children: React.ReactNode
}

/**
 * Application bootstrap boundary.
 *
 * Owns repository selection, registration, and initialization at app start.
 * Shows a loading indicator while bootstrap is in progress and an error
 * message if it fails. Children are only rendered once all repositories are
 * ready and the notification bridge has started.
 *
 * Robustness contract (resume-robustness Block 2):
 *   - The boot deadline only consumes ACTIVE time (visible + online). iOS
 *     suspension/backgrounding pauses the budget instead of expiring it.
 *   - A timed-out attempt gets exactly one silent in-process retry before
 *     the error screen (which keeps its manual retry button).
 *   - `online` events only hard-reload after a REAL offline→online
 *     transition. iOS fires `online` routinely on foreground — a cold
 *     `online` without prior offline must never restart the boot
 *     (double-reload cascade after a WebView memory kill).
 */
export default function AppBootstrap({ children }: AppBootstrapProps) {
  const [state, setState] = useState<BootstrapState>(
    navigator.onLine ? 'loading' : 'offline'
  )
  const [error, setError] = useState<string | null>(null)
  // Tracks whether bootstrap completed. Offline/online handlers must not fire
  // page-level side-effects (full reload, offline screen) after the app is
  // already running — those events are handled by the session layer instead.
  const bootstrapDoneRef = useRef(false)
  // True only after a genuine offline signal (offline at mount or an
  // 'offline' event). Refs instead of state: the listeners are attached once
  // and must read the live value, not a stale closure.
  const sawOfflineRef = useRef(!navigator.onLine)

  useEffect(() => {
    let disposed = false

    // ── Bootstrap attempt state ────────────────────────────────────────────
    // `attempt` identifies the live attempt; a superseded attempt (timed out,
    // retry already running) aborts at its next await checkpoint so it can
    // never double-start bridges or flip state after the fact.
    let attempt = 0
    // Terminal flag: ready or error reached — deadline and late attempt
    // completions are inert from here on.
    let settled = false

    // ── Active-time deadline (Posten 3) ────────────────────────────────────
    let consumedMs = 0
    let lastTickAt = Date.now()
    let tickerHandle: ReturnType<typeof setInterval> | undefined

    const stopDeadline = () => {
      if (tickerHandle !== undefined) {
        clearInterval(tickerHandle)
        tickerHandle = undefined
      }
    }

    const onDeadlineExpired = () => {
      if (attempt < MAX_BOOTSTRAP_ATTEMPTS) {
        // Silent retry: same Sentry event (tracked as FIXUP-WEB-6J), but the
        // user keeps the loading screen instead of the fatal one.
        logWarning('app.bootstrap.timeout', {
          timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          attempt,
          retrying: true,
        })
        startAttempt()
        return
      }
      logWarning('app.bootstrap.timeout', {
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
        attempt,
        retrying: false,
      })
      settled = true
      stopDeadline()
      setError('Bootstrap timed out after ' + BOOTSTRAP_TIMEOUT_MS / 1000 + 's')
      setState('error')
    }

    const onTick = () => {
      const now = Date.now()
      const delta = now - lastTickAt
      lastTickAt = now
      if (disposed || settled) {
        stopDeadline()
        return
      }
      // Hidden or offline time is free: the boot cannot make progress and
      // the user is not waiting in front of a spinner.
      if (document.visibilityState === 'hidden' || !navigator.onLine) return
      // An extremely late tick = the JS world was frozen (suspension that
      // raced the visibilitychange event). Charge a single tick, not the
      // whole wall-clock gap — otherwise this re-creates the original bug.
      consumedMs += delta > SUSPENSION_DELTA_MS ? DEADLINE_TICK_MS : delta
      if (consumedMs >= BOOTSTRAP_TIMEOUT_MS) onDeadlineExpired()
    }

    const startDeadline = () => {
      consumedMs = 0
      lastTickAt = Date.now()
      if (tickerHandle === undefined) {
        tickerHandle = setInterval(onTick, DEADLINE_TICK_MS)
      }
    }

    // ── Boot sequence ──────────────────────────────────────────────────────
    const isStale = (myAttempt: number) =>
      disposed || settled || myAttempt !== attempt

    const runBootSequence = async (myAttempt: number) => {
      try {
        await bootstrapRepositories()
        if (isStale(myAttempt)) return

        // Start project-job sync bridge BEFORE the full-scan so any Realtime
        // events that arrive during syncAllProjectsFromJobs() are queued and
        // applied by the bridge — preventing a snapshot-before-subscribe race
        // where a job mutation in the gap would leave the project permanently
        // behind the job's canonical state.
        startProjectJobSyncBridge()

        // Full-scan: repairs any project whose status/paymentState diverged
        // from its source job before this bootstrap. Runs after the bridge is
        // subscribed so every incoming change is captured.
        await syncAllProjectsFromJobs()
        if (isStale(myAttempt)) return

        // Start in-app notification bridge (timeline → notification signals)
        startNotificationBridge()
        // Register for native push notifications — APNs on iOS, FCM on
        // Android (non-blocking; no-op on web).
        void registerForPushNotifications()

        // Drain any media uploads that were queued in IndexedDB while the
        // device was offline. The runner stays alive for the session,
        // listening for `online` events so a craftsman who reconnects from
        // a job site sees their photos sync without manual action.
        startOutboxRunner()

        // Initialize the user-centric in-app notifications with the current
        // authenticated user's ID. This is non-critical — a failure here must
        // never block app startup or show a fatal error screen. When the auth
        // callback is still processing (e.g. the user just clicked a
        // confirmation link), getSession() may throw or return stale data;
        // the notification repository will be initialized later via
        // onAuthStateChange when the session becomes available.
        try {
          // Single-flight seam: a raw supabase.auth.getSession() here would
          // contend for the navigator.locks auth lock against the parallel
          // session refresh + repository inits (Sentry P0 FIXUP-WEB-56).
          const {
            data: { session },
          } = await getAuthSession()
          const userId = session?.user?.id ?? ''
          if (userId && !isStale(myAttempt)) {
            await initializeInAppNotificationRepository(userId)
          }
        } catch (notifError: unknown) {
          // Non-critical: log and continue. Notifications will initialize
          // when the session becomes available via auth state changes.
          console.warn('[SaFix] Non-critical: in-app notification init skipped:', notifError)
        }
        if (isStale(myAttempt)) return

        settled = true
        stopDeadline()
        bootstrapDoneRef.current = true
        setState((prev) => (prev === 'loading' ? 'ready' : prev))
        // App-open funnel signal, once per launch. Fired here (post-bootstrap)
        // so the analytics repository is initialized; the module guard makes it
        // idempotent across StrictMode double-mount + silent bootstrap retries.
        trackAppOpenOnce()
      } catch (e: unknown) {
        // A superseded attempt's failure is moot — the live attempt decides.
        if (isStale(myAttempt)) return

        // Log the full error — including stack trace — so the exact cause is
        // visible in the browser console and captured by production log drains.
        console.error('[SaFix] Application bootstrap failed:', e)

        // Report to Sentry so production failures are tracked even when the
        // app never reaches a fully rendered state.
        Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
          extra: { context: 'AppBootstrap', attempt: myAttempt },
        })

        settled = true
        stopDeadline()
        const msg = formatBootstrapError(e)
        console.error('[SaFix] Bootstrap error detail:', msg)
        setError(msg || 'Application bootstrap failed')
        setState('error')
      }
    }

    const startAttempt = () => {
      attempt += 1
      startDeadline()
      void runBootSequence(attempt)
    }

    // ── Network listeners (Posten 2) ───────────────────────────────────────
    // Track connectivity only during bootstrap. Once ready, the session layer
    // owns reconnect behaviour so these handlers no-op.
    const handleOffline = () => {
      sawOfflineRef.current = true
      if (!bootstrapDoneRef.current) setState('offline')
    }
    const handleOnline = () => {
      // Guard: only a real offline→online transition acts. iOS fires
      // 'online' on foreground/radio handover without any preceding offline.
      if (!sawOfflineRef.current) return
      sawOfflineRef.current = false
      if (!bootstrapDoneRef.current) {
        // The offline screen promises an automatic start on reconnect — a
        // full reload restarts the boot from a clean slate. Intentional:
        // must not be misreported as a WebView memory kill on the next boot.
        intentionalReload()
        return
      }
      // Boot finished while the offline screen was up: the app is already
      // running underneath, so unblock it instead of reloading.
      setState((prev) => (prev === 'offline' ? 'ready' : prev))
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    if (navigator.onLine) startAttempt()

    return () => {
      disposed = true
      stopDeadline()
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  // Adaptive native splash: dismiss it the moment the app settles to a state
  // that renders real, styled UI (ready / error / offline) instead of waiting
  // the old fixed 1.5 s launchShowDuration — fast boots stop staring at a frozen
  // splash. This is the happy-path dismissal; the native launchShowDuration
  // backstop (capacitor.config.ts, JS-independent) still force-hides if this
  // never runs (hung or never-mounted React tree). hide() is idempotent and a
  // no-op off-native.
  useEffect(() => {
    if (state !== 'loading' && Capacitor.isNativePlatform()) {
      void SplashScreen.hide().catch(() => {})
    }
  }, [state])

  if (state === 'offline') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
        <div className="max-w-sm">
          <div className="mb-4 flex justify-center">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M8.288 8.318A7.5 7.5 0 0 0 4.5 15m15 0a7.5 7.5 0 0 0-1.753-4.8M12 18.75h.008v.008H12v-.008Zm0-4.5a3 3 0 0 1 2.597-2.97M12 7.5a7.473 7.473 0 0 1 5.19 2.09" />
            </svg>
          </div>
          <h1 className="mb-2 text-xl font-semibold text-slate-800">Keine Internetverbindung</h1>
          <p className="text-sm text-slate-500">
            SaFix benötigt eine Internetverbindung. Bitte prüfe dein Netzwerk — die App startet
            automatisch, sobald die Verbindung wiederhergestellt ist.
          </p>
        </div>
      </div>
    )
  }

  if (state === 'loading') {
    // Cold-Start · Variante C — "Marke baut sich auf". No spinner tile: a light
    // brand stage where the mark assembles itself (silhouette pops in with the
    // liquid curve, inner details fade in a beat later) and breathes. Transform/
    // opacity only. Splash colour stays continuous into this screen → no double
    // splash. reduced-motion drops all of it to a static mark (index.css).
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#F4F6FB] px-6 text-center">
        <div className="flex flex-col items-center gap-6">
          <div className="animate-fx-breathe">
            <div className="animate-fx-pop-calm">
              <svg
                width="96"
                height="96"
                viewBox="0 0 64 64"
                className="block"
                style={{ filter: 'drop-shadow(0 8px 22px rgba(37,99,235,0.22))' }}
                aria-label="SaFix"
                role="img"
              >
                <path d="M10 28 L32 8 L54 28 L54 56 L10 56 Z" fill="#2563EB" />
                <g style={{ animation: 'fadeIn 500ms ease 420ms both' }}>
                  <rect x="18" y="30" width="10" height="26" fill="#fff" />
                  <circle cx="25.5" cy="44" r="1.1" fill="#2563EB" />
                  <rect x="30" y="30" width="18" height="9" fill="#fff" />
                  <rect x="38.5" y="30" width="1.2" height="9" fill="#2563EB" />
                  <rect x="30" y="33.9" width="18" height="1.2" fill="#2563EB" />
                  <rect x="30" y="42" width="13" height="8" fill="#fff" />
                  <rect x="35.9" y="42" width="1.2" height="8" fill="#2563EB" />
                  <rect x="30" y="45.4" width="13" height="1.2" fill="#2563EB" />
                </g>
              </svg>
            </div>
          </div>
          <div
            className="text-[15px] font-semibold tracking-[-0.01em] text-slate-600"
            style={{ animation: 'fadeIn 400ms ease 300ms both' }}
          >
            Sitzung wird geprüft …
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-[52px] text-[12px] font-semibold tracking-[0.02em] text-slate-400">
          Ein Zuhause. Ein Betrieb für alles.
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
        <div className="max-w-sm">
          <div className="mb-4 flex justify-center">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <h1 className="mb-2 text-xl font-semibold text-slate-800">
            App konnte nicht gestartet werden
          </h1>
          <p className="mb-4 text-sm text-slate-500">
            Ein Problem beim Laden der App ist aufgetreten. Bitte prüfe deine
            Internetverbindung und versuche es erneut.
          </p>
          {error && (
            <details className="mb-4 rounded-lg bg-slate-50 px-4 py-3 text-left">
              <summary className="cursor-pointer text-xs font-medium text-slate-400">
                Technische Details
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-500">
                {error}
              </pre>
            </details>
          )}
          <button
            onClick={() => intentionalReload()}
            className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Erneut versuchen
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
