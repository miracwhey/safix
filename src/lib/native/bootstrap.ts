/**
 * Native platform bootstrap.
 *
 * Initialises Capacitor plugins when running inside a native iOS/Android shell.
 * Safe to call on web — all plugin calls are guarded by isNativePlatform().
 */
import { Capacitor } from '@capacitor/core';
import { logWarning } from '../observability';
import {
  detectWebViewKillOnBoot,
  startKillDetection,
  recordBackgroundMarker,
  clearBackgroundMarkerOnForeground,
  markIntentionalNavigation,
} from '../lifecycle/killDetection';

// Explicit allow-list for inbound deep link paths.
// Only these paths may be navigated to via routeDeepLink().
// Any path not matching is discarded and logged — not silently routed.
// Paths are matched as exact strings; prefixes are matched via
// DEEP_LINK_ALLOWED_PREFIXES below.
const DEEP_LINK_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/auth/callback',
  '/auth/reset-password',
  '/payout-return',
  '/payout-refresh',
])

/**
 * Phase 1: prefix-allow-list for paths that carry a dynamic segment.
 * `spatial-convert-done-push` Edge Function emits `fixup://spatial/scan/<uuid>`
 * which previously hit the exact-path check, was rejected, and the push tap
 * silently no-op'd. Each entry MUST end with `/` so we don't accidentally
 * match a path that just happens to start with the prefix string.
 */
const DEEP_LINK_ALLOWED_PREFIXES: readonly string[] = [
  '/spatial/scan/',
  '/projects/',
  '/craftsman/jobs/',
]

/**
 * Parses a deep link URL and navigates to the corresponding SPA route.
 * Used for both cold-start (getLaunchUrl) and warm-start (appUrlOpen) links.
 *
 * Only paths in DEEP_LINK_ALLOWED_PATHS are accepted; all others are
 * discarded with a warning to prevent open redirect via crafted URLs.
 */
const CUSTOM_SCHEME_PREFIX = 'app.fixup.main:';

/**
 * Normalises a custom-scheme deep link into a leading-slash SPA path.
 *
 * iOS / Supabase may deliver the SaFix auth redirect in ANY of these forms,
 * and they MUST all route identically (otherwise password-reset / magic-link
 * break depending on URL canonicalisation):
 *   app.fixup.main://auth/reset-password#token=…   (double slash)
 *   app.fixup.main:/auth/reset-password#token=…    (single slash)
 *   app.fixup.main:auth/reset-password#token=…     (no slash, opaque)
 *
 * We deliberately do NOT use `new URL()` here: for the double-slash form it
 * parses the first path segment (`auth`) as the URL *host* and drops it from
 * `pathname` — that would silently mis-route `/auth/...` links. String
 * normalisation keeps the full path intact for every form.
 *
 * Returns the SPA path WITH a single leading slash, query + hash preserved.
 */
function customSchemePathFromUrl(url: string): string {
  // Everything after `app.fixup.main:` — could start with `//`, `/`, or a bare segment.
  let rest = url.slice(CUSTOM_SCHEME_PREFIX.length);
  // Collapse the optional authority slashes: `//auth/x` → `auth/x`, `/auth/x` → `auth/x`.
  rest = rest.replace(/^\/+/, '');
  // Re-attach exactly one leading slash so the SPA route is absolute.
  return '/' + rest;
}

function routeDeepLink(url: string): void {
  try {
    let spaPath: string;

    if (url.startsWith(CUSTOM_SCHEME_PREFIX)) {
      // Custom-scheme URLs — handle `://`, `:/`, and `:` forms uniformly.
      spaPath = customSchemePathFromUrl(url);
    } else {
      // Universal links (https://app.safix.digital/auth/callback?...)
      const parsed = new URL(url);
      spaPath = parsed.pathname + parsed.search + parsed.hash;
    }

    if (!spaPath || spaPath === '/') return;

    // Path allow-list: strip query/hash to check only the pathname segment.
    const hashIndex = spaPath.indexOf('#');
    const fragment = hashIndex >= 0 ? spaPath.slice(hashIndex) : '';
    const pathnameOnly = (hashIndex >= 0 ? spaPath.slice(0, hashIndex) : spaPath).split('?')[0];
    const exactAllowed = DEEP_LINK_ALLOWED_PATHS.has(pathnameOnly)
    const prefixAllowed = DEEP_LINK_ALLOWED_PREFIXES.some((p) => pathnameOnly.startsWith(p))
    if (!exactAllowed && !prefixAllowed) {
      logWarning('native.deeplink.rejected_path', { url, pathnameOnly });
      return;
    }

    // Persist the recovery signal BEFORE the WebView reload. Two independent
    // failure modes are covered:
    //   1. Cold start: session.ts module body runs against the bundle root
    //      URL (`capacitor://localhost/`) which has no hash — it cannot see
    //      `type=recovery` from window.location at that point. The persisted
    //      flag is what session.ts reads on the post-reload re-init.
    //   2. WKWebView fragment survival is unreliable across same-origin
    //      scheme-handler navigations on iOS — stashing the original hash
    //      lets session.ts re-establish the recovery session via setSession
    //      without depending on detectSessionInUrl picking it up.
    if (fragment && /[?#&]type=recovery(?:&|$)/.test(fragment)) {
      try {
        sessionStorage.setItem('fixup.auth.password_recovery', '1');
        sessionStorage.setItem('fixup.auth.recovery_hash', fragment);
      } catch { /* private mode / quota — best effort */ }
    }

    // Intentional full-document navigation — the pagehide it triggers must
    // not write a background marker, otherwise the post-navigation boot
    // would misreport this deep link as a WebView memory reload.
    markIntentionalNavigation();
    window.location.assign(spaPath);
  } catch {
    // Malformed deep link — log for support debugging, do not crash.
    logWarning('native.deeplink.malformed', { url })
  }
}

export async function bootstrapNativePlatform(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  // --- WebView kill detection (telemetry only, native shell only) ----------
  // Consume the background marker BEFORE the deep-link handling further down
  // can navigate away via location.assign(), and attach the pagehide writer.
  // Detection + Sentry telemetry only — route restore is a separate,
  // deliberately deferred roadmap item.
  detectWebViewKillOnBoot();
  startKillDetection();

  // --- Boot diagnostics (one-shot, visible in Xcode console) --------------
  // Block 1.4: prove which build is actually running on the device, which
  // origin the WebView loaded from, and what the StatusBar plugin reports
  // back. This is intentionally left in place — it costs ~1 line of console
  // output per cold start and is the only reliable way to tell remote-load
  // from local-load when debugging shell layout on a real iPhone.
  const buildMarker = '[fixup-boot 1.4]';
  console.info(buildMarker, {
    platform: Capacitor.getPlatform(),
    isNative: Capacitor.isNativePlatform(),
    href: window.location.href,
    // eslint-disable-next-line no-restricted-syntax -- intentional one-shot native boot diagnostic: logging the raw origin (capacitor://localhost on device) is exactly what we want to observe here
    origin: window.location.origin,
    devicePixelRatio: window.devicePixelRatio,
    visualViewport: window.visualViewport
      ? { w: window.visualViewport.width, h: window.visualViewport.height }
      : null,
  });

  // --- StatusBar -----------------------------------------------------------
  // Mirrors capacitor.config.ts plugins.StatusBar so the policy also lands
  // on devices/iOS versions where the JSON pre-config doesn't apply before
  // the WebView mounts. Fullscreen app: overlay the WebView under the status
  // bar app-wide. Per-route text style is owned by StatusBarController (single
  // source of truth) — do NOT set overlay:false anywhere else.
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
    const info = await StatusBar.getInfo();
    console.info(buildMarker, 'StatusBar.getInfo', info);
  } catch (err) {
    // Block 1.4: surface the failure in console so we can tell whether the
    // plugin is actually wired up. Diagnose-mode — do not silently swallow.
    console.warn(buildMarker, 'StatusBar setup failed', err);
  }

  // --- Deep Linking --------------------------------------------------------
  const { App: CapApp } = await import('@capacitor/app');

  // Cold-start: if the app was launched via a deep link (terminated state),
  // getLaunchUrl() returns the URL that triggered the launch.  Without this,
  // magic-link and Stripe-return deep links are lost on cold start.
  const launchUrl = await CapApp.getLaunchUrl();
  if (launchUrl?.url) {
    routeDeepLink(launchUrl.url);
  }

  // Warm-start: handle deep links when the app is already in memory.
  // Close any in-app browser first (e.g. Stripe onboarding that just redirected
  // back via custom scheme — SFSafariViewController won't close on its own).
  CapApp.addListener('appUrlOpen', async ({ url }) => {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Promise.race([
        Browser.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch { /* no browser open — ignore */ }
    routeDeepLink(url);
  });

  // --- App State (session refresh on resume + kill-detection marker) -------
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      // Warm resume — the JS world survived, so the background marker is
      // consumed (no kill happened). Gated internally until the boot check
      // has run, so an early foreground event cannot erase its evidence.
      clearBackgroundMarkerOnForeground();
      // Dispatch a custom event that session.ts can listen to.
      window.dispatchEvent(new CustomEvent('fixup:app-resume'));
    } else {
      // Going to background — persist {path, ts} so a memory kill between
      // now and the next boot becomes visible in Sentry.
      recordBackgroundMarker();
    }
  });

  // --- RoomPlan telemetry forwarding (Phase 1 hotfix, post-review H3) -------
  // Attached ONCE at native boot so every scan flow (useStartRoomScan +
  // ProjectBuilderScreen inline) shares a single listener. Previous code
  // added one in each consumer, which double-logged events to the console
  // + (worse) doubled the Sentry breadcrumbs once that wiring lands.
  // Web platforms skip — RoomPlan is an iOS plugin only.
  if (Capacitor.getPlatform() === 'ios') {
    try {
      const { RoomPlan } = await import('@fixup/capacitor-roomplan');
      void RoomPlan.addListener('roomScanTelemetry', (event) => {
        try {
          console.info('[roomScan]', event.event, event);
        } catch { /* observer crashes must not break the scan flow */ }
      });
    } catch (err) {
      logWarning('native.roomscan.listener_attach_failed', { err: String(err) });
    }
  }
}

/**
 * Test-only export. `routeDeepLink` is an internal helper; exporting it lets
 * the deep-link routing unit tests exercise URL normalisation in isolation
 * without booting the full native platform (which pulls in Capacitor plugins).
 * Not referenced by production code.
 */
export const __test__ = { routeDeepLink, customSchemePathFromUrl };
