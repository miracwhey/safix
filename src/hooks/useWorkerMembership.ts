/**
 * Hook for resolving a worker's company membership state.
 *
 * Pattern mirrors useCraftsmanProfileReady.ts exactly:
 *   - Module-level cache survives component remount/tab-switch (instant re-reads)
 *   - [state, retry, membership] tuple return
 *   - enabled param skips fetch for non-worker sessions
 *
 * Role truth model:
 *   - profiles.craftsman_role = 'worker' is the onboarding flow signal.
 *   - An active team_members row (profile_id = user.id) is the primary truth
 *     for company-internal worker access.
 *   - craftsmanRole = 'worker' alone is NOT sufficient for /worker/* access;
 *     this hook provides the membership gate that EmployeeRouteGate enforces.
 */

import { useEffect, useState } from 'react'
import { getMyWorkerMembership, type WorkerMembership } from '../lib/company/membership'

export type WorkerMembershipState =
  | 'loading'
  | 'joined'
  | 'not_joined'
  | 'error'
  | 'disabled'

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedUserId: string | null = null
let cachedState: 'joined' | 'not_joined' | 'error' | null = null
let cachePromise: Promise<void> | null = null
let cachedMembership: WorkerMembership | null = null
// Monotonically increasing counter. Invalidated on cache clear so that
// any promise still in-flight from a previous request ignores its result.
let fetchGeneration = 0

function fetchAndCache(userId: string): Promise<void> {
  if (cachePromise) return cachePromise
  const gen = fetchGeneration  // capture before async work starts
  cachePromise = getMyWorkerMembership(userId)
    .then((m) => {
      if (gen !== fetchGeneration) return  // stale — a newer request owns the cache
      cachedMembership = m
      cachedState = m ? 'joined' : 'not_joined'
    })
    .catch(() => {
      if (gen !== fetchGeneration) return  // stale — don't overwrite newer result
      cachedMembership = null
      cachedState = 'error'
    })
    .finally(() => {
      if (gen === fetchGeneration) cachePromise = null
    })
  return cachePromise
}

/**
 * Clears the module-level cache.
 * Must be called on SIGNED_OUT and SIGNED_IN in session.ts to prevent
 * cross-session state leakage.
 * Also called after a successful joinCompanyWithCode() so the gate
 * re-reads the new membership.
 */
export function invalidateWorkerMembershipCache(): void {
  cachedUserId = null
  cachedState = null
  cachePromise = null
  cachedMembership = null
  fetchGeneration++  // mark any in-flight promise as stale
}

// ---------------------------------------------------------------------------
// useWorkerMembership
// ---------------------------------------------------------------------------
// Pass `userId = null` or `enabled = false` for non-worker sessions to skip
// the fetch entirely (returns 'disabled' immediately).
//
// If the userId changes (cross-account session), the cache is invalidated
// automatically before the new fetch begins.
//
// Returns [state, retry, membership]:
//   state      — WorkerMembershipState
//   retry      — re-triggers the fetch (for error recovery UI)
//   membership — WorkerMembership | null (populated when state === 'joined')
// ---------------------------------------------------------------------------

export function useWorkerMembership(
  userId: string | null,
  enabled = true,
): [WorkerMembershipState, () => void, WorkerMembership | null] {
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!enabled || !userId) return

    // Invalidate cache when a different user is detected
    if (cachedUserId !== null && cachedUserId !== userId) {
      invalidateWorkerMembershipCache()
    }

    if (cachedState !== null) return

    cachedUserId = userId
    let cancelled = false
    fetchAndCache(userId).then(() => {
      if (!cancelled) forceRender((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, userId])

  const retry = () => {
    if (!userId) return
    invalidateWorkerMembershipCache()
    cachedUserId = userId
    fetchAndCache(userId).then(() => forceRender((n) => n + 1))
  }

  const resolvedState: WorkerMembershipState =
    !enabled || !userId ? 'disabled' : (cachedState ?? 'loading')

  return [resolvedState, retry, cachedMembership]
}
