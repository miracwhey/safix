import type { AppContext } from '../access'

const CUSTOMER_TAB_PATHS = ['/', '/explore', '/messages', '/profile']
const OWNER_TAB_PATHS = ['/craftsman/dashboard', '/explore', '/craftsman/backoffice', '/craftsman/messages', '/profile']
// Employees (workers) use regular Routes — no persistent tab shell, so no tab
// paths are registered here.  isTabRoute always returns false for employees.

/**
 * Returns true when the given pathname is a persistent tab route for the
 * resolved app context.
 *
 * Employees and unknown contexts always return false by contract: workers
 * navigate via regular Routes so each screen mounts on demand.  The worker
 * BottomNav renders inside each screen's AppShell and is driven by the
 * active prop, not by this function.
 */
export function isTabRoute(pathname: string, context: AppContext): boolean {
  if (context === 'customer') return CUSTOMER_TAB_PATHS.includes(pathname)
  if (context === 'owner') return OWNER_TAB_PATHS.includes(pathname)
  return false
}

/**
 * Union of every tab path across both contexts, EXCLUDING '/' (which keeps
 * its explicit HomeGate route in App.tsx).
 *
 * App.tsx registers one cold-start hold <Route> per path directly above the
 * '*' catch-all: after a reload / WebView content-process kill Capacitor
 * restores the CURRENT URL, but on the first renders the session is not yet
 * validated (`onTab` still false — and for owners the profile-readiness
 * module cache is empty after every reload). Without these explicit routes
 * the catch-all would replace the tab URL with '/' BEFORE validation
 * settles, destroying the user's location (e.g. /craftsman/messages →
 * dashboard).
 */
export const TAB_COLD_START_HOLD_PATHS: readonly string[] = Array.from(
  new Set([...CUSTOMER_TAB_PATHS, ...OWNER_TAB_PATHS]),
).filter((path) => path !== '/')
