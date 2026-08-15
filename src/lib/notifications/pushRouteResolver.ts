/**
 * Push-Route Resolver · Block 7.2 / B1
 *
 * Pure Funktion: nimmt einen `data`-Block aus einem APNs-Payload, validiert
 * Schema-Version, Expiry, Route-Whitelist und (optional) Focus-Anker, und
 * liefert ein discriminated-union-Outcome zurück.
 *
 * Keine Side-Effects, kein React-Router-Import, kein Storage-Touch — der
 * Resolver lässt sich isoliert unit-testen. Verbraucher
 * (`pushNotificationBridge` in B2) übersetzen `PushRouteResolution` in
 * `historyAdapter.push()` (warm), `pendingPushRoute.set()` (cold) oder
 * Local-Notification (drop).
 *
 * Validation-Reihenfolge fest:
 *   1. Payload existiert + ist Objekt
 *   2. `actionVersion` matcht `PUSH_ROUTE_SCHEMA_VERSION`
 *   3. `expiresAt` (wenn gesetzt) liegt in der Zukunft
 *   4. `route` ist non-empty string
 *   5. Pfad-Anteil von `route` matcht Whitelist — sonst Fallback-Versuch
 *   6. `focus` (optional) ist gültiger AttentionFocus — sonst Fallback
 *
 * Jeder Fail liefert einen sprechenden `reason`-Code, damit die Bridge
 * eine differenzierte Local-Notification erzeugen kann.
 */

import {
  PUSH_ROUTE_SCHEMA_VERSION,
  isAttentionFocus,
  isWhitelistedRoute,
  type PushRouteData,
  type PushRouteResolution,
} from './pushRoutes'

export interface PushRouteResolverOptions {
  /**
   * Injizierbarer Zeitstempel für Test-Isolation. Default: `Date.now()`.
   */
  now?: number
}

/**
 * Validiert einen Push-Payload und liefert die nächste Aktion zurück.
 *
 * Pure: gleiche Eingabe + gleiche `now` → gleiches Output. Keine Exceptions
 * für valide Eingaben — malformed Payloads enden in `{ kind: 'drop' }`,
 * niemals in einem Throw.
 */
export function pushRouteResolver(
  data: PushRouteData | null | undefined,
  options: PushRouteResolverOptions = {},
): PushRouteResolution {
  const now = options.now ?? Date.now()

  if (data === null || data === undefined || typeof data !== 'object') {
    return { kind: 'drop', reason: 'malformed' }
  }

  // 1. Schema-Version
  if (
    typeof data.actionVersion === 'number' &&
    data.actionVersion !== PUSH_ROUTE_SCHEMA_VERSION
  ) {
    return { kind: 'drop', reason: 'unknown_version' }
  }

  // 2. Expiry
  if (typeof data.expiresAt === 'number' && data.expiresAt <= now) {
    return { kind: 'drop', reason: 'expired' }
  }

  // 3. Route-Existenz
  if (typeof data.route !== 'string' || data.route.length === 0) {
    return { kind: 'drop', reason: 'no_route' }
  }

  const parsedRoute = splitPathAndSearch(data.route)
  const focusOk =
    data.focus === undefined ||
    data.focus === null ||
    isAttentionFocus(data.focus)

  // 4a. Happy-Path — Route whitelisted + Focus valid
  if (isWhitelistedRoute(parsedRoute.path) && focusOk) {
    return {
      kind: 'ok',
      path: parsedRoute.path,
      search: appendFocus(parsedRoute.search, data.focus),
    }
  }

  // 4b. Fallback-Versuch — Route nicht whitelisted ODER Focus invalid
  const fallbackReason: 'route_not_whitelisted' | 'invalid_focus' =
    !isWhitelistedRoute(parsedRoute.path) ? 'route_not_whitelisted' : 'invalid_focus'

  if (typeof data.fallbackRoute === 'string' && data.fallbackRoute.length > 0) {
    const parsedFallback = splitPathAndSearch(data.fallbackRoute)
    if (isWhitelistedRoute(parsedFallback.path)) {
      return {
        kind: 'fallback',
        reason: fallbackReason,
        path: parsedFallback.path,
        search: parsedFallback.search,
      }
    }
  }

  // 4c. Weder Route noch Fallback brauchbar → drop, kein silent navigate
  return { kind: 'drop', reason: 'no_route' }
}

/**
 * Trennt einen Pfad in (path, search). Beispiel:
 *   `/craftsman/jobs/abc?ref=push` → `{ path: '/craftsman/jobs/abc', search: '?ref=push' }`
 *   `/craftsman/jobs/abc#x` → `{ path: '/craftsman/jobs/abc', search: '' }` (Fragment ignoriert)
 *
 * Whitelist-Match läuft gegen `path` ohne Query, damit beliebige Tracking-
 * Params nicht zu Drop führen.
 */
function splitPathAndSearch(route: string): { path: string; search: string } {
  const hashIdx = route.indexOf('#')
  const trimmed = hashIdx >= 0 ? route.slice(0, hashIdx) : route
  const queryIdx = trimmed.indexOf('?')
  if (queryIdx < 0) return { path: trimmed, search: '' }
  return {
    path: trimmed.slice(0, queryIdx),
    search: trimmed.slice(queryIdx),
  }
}

/**
 * Hängt `focus=...` an einen bestehenden Search-String an. Wenn der Push
 * keinen Focus mitliefert, bleibt search unverändert.
 */
function appendFocus(search: string, focus: string | null | undefined): string {
  if (typeof focus !== 'string' || focus.length === 0) return search
  if (search.length === 0) return `?focus=${focus}`
  return `${search}&focus=${focus}`
}
