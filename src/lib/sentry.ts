/**
 * Sentry client-side initialization.
 *
 * Must be imported before any other application code (see src/main.tsx).
 * When VITE_SENTRY_DSN is not set, Sentry operates in no-op mode — no events
 * are sent, no network requests are made.  Safe for local development.
 *
 * Production behavior:
 *   - Unhandled exceptions & promise rejections auto-captured (default integrations)
 *   - Browser performance traces at 10% sample rate
 *   - User context set/cleared by session.ts on auth state changes
 *   - PII (cookies, IP, request body) never sent
 *   - Release + environment tags for deployment correlation
 */

import * as Sentry from '@sentry/react'
import * as SentryCapacitor from '@sentry/capacitor'
import { Capacitor } from '@capacitor/core'

// Build-time constants injected by vite.config.ts from Vercel system env vars.
// When not set (local dev), both default to safe fallbacks.
declare const __SENTRY_RELEASE__: string
declare const __SENTRY_ENVIRONMENT__: string

// Shared options for both the web (@sentry/react) and native (@sentry/capacitor)
// init paths. The native SDK forwards these to the JS layer AND to the
// embedded sentry-cocoa runtime, so Swift/ObjC crashes, OOM terminations and
// hard WKWebView crashes (all invisible to @sentry/react) land in the same
// project/release as the JS errors.
const sentryOptions: Parameters<typeof Sentry.init>[0] = {
  dsn: import.meta.env.VITE_SENTRY_DSN ?? '',

  // Vercel injects VERCEL_ENV (production | preview | development) at build time.
  // Injected via vite.config.ts define → __SENTRY_ENVIRONMENT__.
  environment: __SENTRY_ENVIRONMENT__,

  // Vercel injects VERCEL_GIT_COMMIT_SHA at build time.
  // Ties Sentry errors to specific deployments. Empty string → omit.
  // NOTE: the native sourcemap/dSYM association uses this same release string,
  // so the @sentry/vite-plugin release in vite.config.ts MUST match it.
  release: __SENTRY_RELEASE__ || undefined,

  // Default integrations (globalHandlers, breadcrumbs, dedup, etc.) are kept,
  // EXCEPT console breadcrumbs: the explicit breadcrumbsIntegration({ console:
  // false }) overrides the default console:true (Sentry dedups integrations by
  // name). Otherwise every console.* becomes a breadcrumb, and @sentry/capacitor
  // scopeSync mirrors each one across the JS→Native bridge — one serialized hop
  // per breadcrumb, hundreds in the latency-sensitive boot. beforeBreadcrumb
  // (below) additionally drops every non-warning/error/fatal breadcrumb
  // pre-native-sync (the http/navigation flood).
  // browserTracingIntegration adds minimal performance monitoring.
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.breadcrumbsIntegration({ console: false }),
  ],

  // Keep ONLY warning/error/fatal breadcrumbs; drop everything else BEFORE
  // @sentry/capacitor scopeSync serializes it across the JS→Native bridge (one
  // hop per breadcrumb — hundreds during the latency-sensitive boot).
  //
  // Why a level allow-list instead of `level === 'info' ? null`: the high-volume
  // boot breadcrumbs are auto-instrumented http (fetch/xhr) + navigation crumbs
  // that carry NO explicit level — `breadcrumb.level` is `undefined` at this
  // point (scopeSync only defaults it to 'info' AFTER, at sync time). So an
  // `=== 'info'` test let every undefined-level crumb through and the bridge
  // flooded anyway. Allow-listing warn/error/fatal drops the undefined/info/
  // debug/log flood while still retaining the crumbs that matter for crash
  // context (a failed request gets level 'warning'/'error', logWarning/logError).
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.level === 'warning' ||
    breadcrumb.level === 'error' ||
    breadcrumb.level === 'fatal'
      ? breadcrumb
      : null,

  // 10% of transactions — enough for baseline visibility without quota pressure.
  tracesSampleRate: 0.1,

  // Never send cookies, IP addresses, or request bodies.
  sendDefaultPii: false,
}

if (sentryOptions.dsn && Capacitor.isNativePlatform()) {
  // Native shell (iOS): initialise the Capacitor SDK and let it bootstrap the
  // JS layer via the @sentry/react init passed as the second arg. This is the
  // documented native-init contract — it wires the cocoa crash handler AND the
  // browser/react JS handlers from a single call.
  SentryCapacitor.init(sentryOptions, Sentry.init)
} else if (sentryOptions.dsn) {
  // Web (Vercel PWA): plain JS SDK, unchanged behaviour.
  Sentry.init(sentryOptions)
}

// ---------------------------------------------------------------------------
// User context helpers — called by session.ts on auth state changes
// ---------------------------------------------------------------------------

/**
 * Sets the authenticated user on all subsequent Sentry events.
 * Only the user ID is sent — no email, no username, no IP.
 */
export function setSentryUser(userId: string): void {
  Sentry.setUser({ id: userId })
}

/**
 * Clears user context after sign-out.
 */
export function clearSentryUser(): void {
  Sentry.setUser(null)
}
