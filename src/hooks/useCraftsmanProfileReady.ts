import { useEffect, useState } from 'react'
import { getMyCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import { isProviderReady } from '../lib/craftsman/craftsmanReadinessSelectors'

export type ProfileReadyState = 'loading' | 'ready' | 'incomplete' | 'error' | 'disabled'

// ---------------------------------------------------------------------------
// Global cache — survives component unmount/remount so tab switches are instant
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000

let cachedState: 'ready' | 'incomplete' | 'error' | null = null
let cachePromise: Promise<void> | null = null
let cachedAt: number | null = null

function fetchAndCache(): Promise<void> {
  if (cachePromise) return cachePromise
  cachePromise = getMyCraftsmanBusinessProfile()
    .then((profile) => {
      cachedState = isProviderReady(profile) ? 'ready' : 'incomplete'
      cachedAt = Date.now()
    })
    .catch(() => {
      cachedState = 'error'
      cachedAt = Date.now()
    })
    .finally(() => {
      cachePromise = null
    })
  return cachePromise
}

/**
 * Fetches the current user's craftsman profile and derives readiness state.
 * Pass `enabled = false` to skip the fetch (e.g., for non-owner users).
 * Returns `'disabled'` immediately when `enabled` is false, to distinguish
 * from a genuinely incomplete profile.
 *
 * Results are cached globally — subsequent mounts (e.g. tab switches)
 * return the cached value instantly without a network round-trip.
 *
 * Returns a tuple of [state, retry] where retry() re-triggers the fetch.
 * Use retry() in error-state UI to let the user attempt recovery without
 * a full page reload.
 *
 * States:
 *   'loading'    — fetch in progress
 *   'ready'      — fetch succeeded and all required fields are present
 *   'incomplete' — fetch succeeded but required fields are missing
 *   'error'      — fetch failed (network, RLS, timeout, etc.)
 *   'disabled'   — hook not enabled; non-owners should never reach readiness checks
 */
export function invalidateCraftsmanProfileCache(): void {
  cachedState = null
  cachePromise = null
  cachedAt = null
}

export function useCraftsmanProfileReady(enabled = true): [ProfileReadyState, () => void] {
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!enabled) return

    // Expire stale cache so a re-mount after TTL triggers a fresh fetch
    if (cachedState !== null && cachedAt !== null && Date.now() - cachedAt > CACHE_TTL_MS) {
      cachedState = null
      cachePromise = null
      cachedAt = null
    }

    // Cache hit — no fetch needed
    if (cachedState !== null) return

    let cancelled = false
    fetchAndCache().then(() => {
      if (!cancelled) forceRender((n) => n + 1)
    })
    return () => { cancelled = true }
  }, [enabled])

  const retry = () => {
    cachedState = null
    cachePromise = null
    cachedAt = null
    fetchAndCache().then(() => forceRender((n) => n + 1))
  }

  const profileState: ProfileReadyState =
    !enabled ? 'disabled'
    : cachedState ?? 'loading'

  return [profileState, retry]
}
