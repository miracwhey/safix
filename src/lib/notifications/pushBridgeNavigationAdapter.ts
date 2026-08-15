/**
 * Push-Bridge Navigation-Adapter · Block 7.2 / B2
 *
 * Thin Adapter über React-Router's `history.push`. Existiert aus zwei
 * Gründen:
 *
 *  1. **Test-Isolation**: Bridge-Listener-Tests können den Adapter mocken
 *     statt React-Router komplett zu setupen.
 *
 *  2. **Cold-Start-Sicherheit**: zum Zeitpunkt eines Push-Empfangs ist
 *     React-Router u.U. noch nicht gemountet (App.tsx ist noch in
 *     `<AppBootstrap>` Loading-State). Der Adapter detektiert das und
 *     liefert `false` zurück → Bridge fällt auf `pendingPushRoute.set`
 *     zurück.
 *
 * Wiring: `App.tsx` ruft beim Mount `attachNavigationAdapter(navigate)`
 * auf, beim Unmount `detachNavigationAdapter()`. Solange Adapter
 * detached ist, gilt App als "cold" und alle Push-Tap-Routen werden
 * gequeued.
 */

export type NavigateFn = (to: string, options?: { replace?: boolean }) => void

let attachedNavigate: NavigateFn | null = null

/**
 * Wird von App.tsx beim Mount aufgerufen — übergibt die React-Router
 * `navigate`-Funktion an die Bridge.
 */
export function attachNavigationAdapter(navigate: NavigateFn): void {
  attachedNavigate = navigate
}

/**
 * Wird von App.tsx beim Unmount aufgerufen. Bridge fällt auf
 * Pending-Route-Queue zurück.
 */
export function detachNavigationAdapter(): void {
  attachedNavigate = null
}

/**
 * Versucht direkt zu navigieren. Liefert `true` wenn React-Router gemountet
 * ist (warm) und Navigate triggered wurde, `false` wenn App noch im
 * Cold-Start ist. In letzterem Fall MUSS der Caller `pendingPushRoute.set`
 * verwenden.
 */
export function tryNavigate(
  path: string,
  search: string,
  options: { replace?: boolean } = {},
): boolean {
  if (attachedNavigate === null) return false
  attachedNavigate(`${path}${search}`, options)
  return true
}

/**
 * Test-only Helper, um den Adapter-State zwischen Tests zu resetten.
 */
export function __testOnly_resetAdapter(): void {
  attachedNavigate = null
}

/**
 * Test-only Helper, um den Adapter-Mount-Status zu prüfen ohne tryNavigate
 * zu rufen.
 */
export function __testOnly_isAttached(): boolean {
  return attachedNavigate !== null
}
