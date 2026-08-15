import type { SessionState } from '../session'
import { getSession } from '../session'
import { resolveAppContext } from '../access'
import { evaluateFlag, getFlag } from './evaluateFlag'

// Session-DEPENDENT flag API. Imports ../session, so only session-aware
// consumers (useFlag, future direct callers running inside the app) should
// import from here. Module-load-sensitive consumers (chat-cutover adapter) use
// the session-free ./evaluateFlag instead.

/**
 * Resolve a feature flag against the live cache + current session.
 *
 * Fail-closed by contract: an absent flag, an unhydrated repository, or any
 * read error all resolve to `false`. Synchronous (the Supabase repo caches the
 * rows after bootstrap hydration).
 */
export function isFlagEnabled(key: string, sessionOverride?: SessionState): boolean {
  try {
    const flag = getFlag(key)
    const session = sessionOverride ?? getSession()
    return evaluateFlag(flag, {
      userId: session.user?.id,
      role: resolveAppContext(session),
    })
  } catch {
    return false
  }
}
