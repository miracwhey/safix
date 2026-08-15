/**
 * API Base URL resolution.
 *
 * All client-side calls to Vercel serverless functions in /api MUST go through
 * apiUrl(). Relative fetch('/api/...') resolves against the current origin —
 * which on web (Vercel) is same-origin and works, but inside a Capacitor
 * native shell the origin is `capacitor://localhost` and there is no /api
 * backend there. Native builds therefore MUST prefix every /api call with
 * the deployed API origin.
 *
 * Env resolution order:
 *   1. VITE_API_BASE_URL — canonical name.
 *   2. VITE_STRIPE_BACKEND_URL — legacy fallback (pre-dates the rename).
 *
 * On web, base may be empty → resolves to a same-origin relative URL.
 * On native, base MUST be set. Missing base throws so the misconfiguration
 * surfaces in the AppBootstrap error boundary instead of silent fetch failures
 * deep inside payment / funding / auth call paths.
 */
import { isNative } from '../platform'

function resolveApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL as string | undefined
  const legacy = import.meta.env.VITE_STRIPE_BACKEND_URL as string | undefined
  const raw = ((explicit?.trim() ?? '') || (legacy?.trim() ?? '')).replace(/\/$/, '')

  // Legacy compat: older deployments configured VITE_STRIPE_BACKEND_URL='/api'
  // as the base, because the old StripeProvider prepended it to paths like
  // '/create-escrow'. After migrating to apiUrl('/api/...'), that literal
  // would produce '/api/api/...'. Treat it as the same-origin default.
  if (raw === '/api') return ''

  // apiUrl() receives paths that already begin with `/api/`. Accept the
  // historically common absolute `https://host/api` configuration as well,
  // but normalize it to the origin so native calls cannot silently become
  // `https://host/api/api/...`.
  return raw.endsWith('/api') ? raw.slice(0, -4) : raw
}

/**
 * Build the full URL for a server API path.
 *
 * @param path — absolute path starting with '/', e.g. '/api/request-funding'.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(
      `[SaFix] apiUrl() requires an absolute path starting with '/', got: ${path}`,
    )
  }
  const base = resolveApiBaseUrl()

  if (isNative() && !base) {
    throw new Error(
      '[SaFix] Native build requires VITE_API_BASE_URL to point at the ' +
        'deployed API origin (e.g. https://app.safix.digital). ' +
        'Relative /api/* URLs do not resolve inside Capacitor ' +
        '(capacitor://localhost).',
    )
  }

  return `${base}${path}`
}

/**
 * Returns the resolved API base URL without any path.
 * Empty string on web when no override is set (same-origin deployment).
 */
export function apiBaseUrl(): string {
  return resolveApiBaseUrl()
}

/**
 * Native boot-time guard. Call during bootstrap so a native Capacitor build
 * with no API origin configured fails immediately with a clear message,
 * instead of booting normally and then exploding later on the first /api/*
 * call (payouts, funding, release, account deletion, …).
 *
 * Web builds are unaffected — same-origin Vercel deployments boot without
 * VITE_API_BASE_URL and resolve /api/* relatively.
 */
export function assertApiBaseUrlForNative(): void {
  if (!isNative()) return
  if (resolveApiBaseUrl() !== '') return
  throw new Error(
    '[SaFix] Native build requires VITE_API_BASE_URL to point at the ' +
      'deployed API origin (e.g. https://app.safix.digital). ' +
      'Relative /api/* URLs do not resolve inside Capacitor ' +
      '(capacitor://localhost). Set the env var in the Vercel project ' +
      'settings and re-run `npm run cap:build`.',
  )
}
