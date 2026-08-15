import { getSession } from '../session'
import { resolveAppContext } from '../access'
import { recordAnalyticsEvent } from './analyticsService'
import { isoWeek } from './cohortWeek'
import type { AnalyticsEventType } from './analyticsTypes'

// Imports ../session, so this module is NOT re-exported from the analytics
// barrel (that would pull session.ts's onAuthStateChange into every barrel
// consumer's module load, crashing offline tests). Session-aware consumers
// import `track` from this file directly.

/**
 * Funnel / lifecycle event wrapper over `recordAnalyticsEvent`.
 *
 * Auto-stamps the current actor (user id, app-context role, signup cohort week)
 * from the live session so per-user funnel selectors work without every call
 * site threading session state. Use for product-funnel signals (app_open,
 * inquiry_created, …) where the acting user — not a domain entity — is the key.
 *
 * Fire-and-forget: `recordAnalyticsEvent` never throws, so a `track()` call can
 * sit on any success path without a try/catch. Events fired before login are
 * keyed `anonymous`.
 *
 * Anon writes are NOT persisted while logged out — but the gate is NOT here.
 * `SupabaseAnalyticsRepository.add()` skips the network insert whenever the
 * supabase client has no authenticated session (the `analytics_events` INSERT
 * policy is `TO authenticated` only — an anon insert is a guaranteed 42501 that
 * once surfaced as the login-screen "sync failed" banner). Keeping the single
 * authoritative gate at the repository means it also covers the DIRECT
 * `recordAnalyticsEvent` callers that bypass `track()` — e.g. `signup` (fired
 * with the freshly returned auth user before the app session store hydrates;
 * still anon at the client while email confirmation is pending).
 */
export function track(eventType: AnalyticsEventType, props?: Record<string, unknown>): void {
  const session = getSession()
  const userId = session.user?.id
  const cohortWeek = isoWeek(session.user?.created_at)
  recordAnalyticsEvent({
    eventType,
    entityType: 'user',
    entityId: userId ?? 'anonymous',
    actorUserId: userId,
    metadata: {
      role: resolveAppContext(session),
      ...(cohortWeek ? { cohortWeek } : {}),
      ...props,
    },
  })
}
