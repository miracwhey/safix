/**
 * WebView kill detection — telemetry only.
 *
 * iOS kills the WKWebView content process (or the whole app process) under
 * memory pressure. Both paths restart the JS world in a way that is
 * indistinguishable from a normal cold start — which made memory-kill
 * reloads completely invisible in Sentry (FINDINGS 2026-06-11,
 * cold-start-deep-route P1).
 *
 * Mechanism:
 *   - Writers persist a `{ path, ts }` marker to localStorage whenever the
 *     app goes to background (`appStateChange(isActive=false)` via the
 *     native bootstrap) or the document unloads (`pagehide`). localStorage
 *     is deliberate — sessionStorage does not survive a process kill.
 *   - On boot, `detectWebViewKillOnBoot()` consumes the marker. A fresh
 *     marker (< 5 min) means the app was alive moments ago and the JS world
 *     restarted anyway → `logWarning('app.webview_memory_reload', …)` with
 *     the navigation type to distinguish the two kill flavours:
 *       'reload'   → content-process kill (Capacitor `bridge.reset()` +
 *                    `webView.reload()`) — high confidence.
 *       'navigate' → full process relaunch within the window (Jetsam kill
 *                    or a quick user force-quit — ambiguous, but segmentable
 *                    in Sentry via the context field).
 *
 * Wiring lives exclusively in `src/lib/native/bootstrap.ts` (native shell
 * only). Web builds never attach the writers, so ordinary browser reloads
 * cannot produce false `app.webview_memory_reload` events. This module
 * itself stays platform-agnostic (pure web APIs) so it is trivially
 * testable.
 *
 * INTENTIONAL navigations must not pollute the metric: WebKit fires
 * `pagehide` on EVERY document teardown — including programmatic
 * `window.location.reload()` (error-retry buttons, reconnect-during-boot)
 * and deep-link `location.assign()`. Without suppression, every such
 * navigation in the native shell writes a fresh marker and the next boot
 * misreports it as a memory kill — corrupting exactly the high-confidence
 * `navigationType === 'reload'` segment. Programmatic reloads therefore go
 * through `intentionalReload()`; full-document navigations call
 * `markIntentionalNavigation()` before navigating.
 *
 * SCOPE: detection + telemetry only. Route restore from the persisted path
 * is a separate roadmap item and deliberately NOT implemented here.
 *
 * Every storage access is try/catch-guarded — quota errors or private-mode
 * restrictions must never block the boot path.
 */
import { logWarning } from '../observability'

const MARKER_KEY = 'fixup.lifecycle.background_marker'

/** Markers older than this are treated as a regular cold start, not a kill. */
const FRESH_WINDOW_MS = 5 * 60_000

export interface BackgroundMarker {
  /** Pathname only — query/hash may carry tokens and stay out of storage. */
  path: string
  ts: number
}

// Module-level guards. The page-load lifetime of this module matches the
// detection semantics exactly: one boot check per JS world, one pagehide
// listener regardless of how often callers re-init (HMR, StrictMode).
let bootCheckDone = false
let pagehideAttached = false
let suppressNextPagehide = false

function readMarker(): BackgroundMarker | null {
  try {
    const raw = window.localStorage.getItem(MARKER_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { path, ts } = parsed as { path?: unknown; ts?: unknown }
    if (typeof path !== 'string' || typeof ts !== 'number' || !Number.isFinite(ts)) {
      return null
    }
    return { path, ts }
  } catch {
    // Corrupt JSON / storage access denied — treat as "no marker".
    return null
  }
}

function removeMarker(): void {
  try {
    window.localStorage.removeItem(MARKER_KEY)
  } catch {
    /* best effort — a stale marker is filtered by the freshness window */
  }
}

/**
 * Persist the background marker. Called when the app loses foreground
 * (`appStateChange(isActive=false)`) and on `pagehide`.
 */
export function recordBackgroundMarker(): void {
  try {
    const marker: BackgroundMarker = {
      path: window.location.pathname,
      ts: Date.now(),
    }
    window.localStorage.setItem(MARKER_KEY, JSON.stringify(marker))
  } catch {
    /* quota / private mode — detection is best-effort, never block */
  }
}

/**
 * Consume the marker on a warm foreground (`appStateChange(isActive=true)`
 * without any reload in between). Without this, a marker written on
 * background would survive the resume and a later intentional full
 * navigation (deep link `location.assign`) would be misread as a memory
 * reload by the next boot check.
 *
 * Gated on the boot check having run: an early foreground event must never
 * erase the very evidence `detectWebViewKillOnBoot()` is about to read.
 */
export function clearBackgroundMarkerOnForeground(): void {
  if (!bootCheckDone) return
  removeMarker()
}

/**
 * Suppress the marker write for the next `pagehide`. Called right before an
 * intentional full-document navigation (deep-link `window.location.assign`)
 * so the post-navigation boot does not report a false kill.
 */
export function markIntentionalNavigation(): void {
  suppressNextPagehide = true
}

/**
 * Programmatic full reload that does NOT count as a kill. WebKit fires
 * `pagehide` on the document teardown a `window.location.reload()` causes —
 * without suppression the next boot would log `app.webview_memory_reload`
 * with `navigationType: 'reload'`, the exact signature this module treats as
 * high-confidence kill evidence. Every deliberate in-app reload (error-screen
 * retry, reconnect-during-boot, error boundaries) must use this helper
 * instead of calling `window.location.reload()` directly.
 */
export function intentionalReload(): void {
  markIntentionalNavigation()
  window.location.reload()
}

function handlePagehide(): void {
  if (suppressNextPagehide) {
    suppressNextPagehide = false
    return
  }
  recordBackgroundMarker()
}

/**
 * Attach the `pagehide` marker writer. Idempotent — repeated calls (HMR,
 * re-init) never attach a second listener. Returns a detach function for
 * tests; production never calls it.
 */
export function startKillDetection(): () => void {
  if (pagehideAttached) return () => {}
  pagehideAttached = true
  window.addEventListener('pagehide', handlePagehide)
  return () => {
    pagehideAttached = false
    window.removeEventListener('pagehide', handlePagehide)
  }
}

function navigationType(): string {
  try {
    const entries = performance.getEntriesByType('navigation')
    const entry = entries[0] as PerformanceNavigationTiming | undefined
    return entry?.type ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Boot check: consume the marker and report a fresh one to Sentry.
 *
 * Must run as early as possible in the boot path — in particular BEFORE
 * deep-link routing can `location.assign()` away (which would re-run the
 * boot in a new document). One-shot per JS world.
 */
export function detectWebViewKillOnBoot(): void {
  if (bootCheckDone) return
  bootCheckDone = true

  const marker = readMarker()
  if (marker === null) return

  // Always consume — a stale marker must not linger into future boots.
  removeMarker()

  const ageMs = Date.now() - marker.ts
  // Negative age = clock skew / corrupt timestamp — not trustworthy.
  if (ageMs < 0 || ageMs > FRESH_WINDOW_MS) return

  logWarning('app.webview_memory_reload', {
    navigationType: navigationType(),
    markerPath: marker.path,
    markerAgeMs: ageMs,
  })
}

/**
 * Test-only hooks. `reset()` restores the module-level one-shot guards and
 * detaches a leftover pagehide listener between test cases.
 */
export const __test__ = {
  MARKER_KEY,
  FRESH_WINDOW_MS,
  reset(): void {
    bootCheckDone = false
    suppressNextPagehide = false
    if (pagehideAttached) {
      window.removeEventListener('pagehide', handlePagehide)
      pagehideAttached = false
    }
  },
}
