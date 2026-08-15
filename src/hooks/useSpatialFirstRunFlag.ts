/**
 * Spatial V1.6 · Phase 4 · useSpatialFirstRunFlag
 *
 * SSR-safe localStorage gate for first-run UI (onboarding tour, ruler-tip
 * sheet, first-success toast). Returns `[seen, markSeen]`. `seen=true` means
 * the surface has been dismissed at least once and should auto-skip.
 *
 * Storage-event aware: when another tab marks the same key as seen, this
 * hook flips its local state without a re-mount so the surface does not
 * re-open on the second tab. Cross-tab race window is one event-loop tick;
 * the writer always wins.
 *
 * Centralises the inline `localStorage.setItem` / `getItem` calls that
 * Phase 2-3 sprinkled across components. Phase 4 standardises every
 * customer-spatial first-run gate on this helper so adding a new flag is a
 * one-liner.
 *
 * The key namespace is the caller's responsibility — keep it descriptive
 * and versioned (e.g. `spatial-customer-foo-seen-v1`) so future flag-
 * resets only need a `-v2` bump.
 */

import { useCallback, useEffect, useState } from 'react'

export interface UseSpatialFirstRunFlagApi {
  /** True once the flag has been written to localStorage. */
  seen: boolean
  /** Persist the flag and flip local state to `true`. Idempotent. */
  markSeen: () => void
}

function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    // Safari private mode + jsdom edge-cases throw on localStorage access.
    // Treat any failure as "not seen" so the surface still renders rather
    // than disappearing because storage is sandboxed.
    return false
  }
}

export function useSpatialFirstRunFlag(key: string): UseSpatialFirstRunFlagApi {
  // Lazy init so the open decision is a pure derivation of localStorage
  // at mount time (no set-state-in-effect cascade).
  const [seen, setSeen] = useState<boolean>(() => readFlag(key))

  // Cross-tab + cross-component sync — any other window that flips this
  // key fires a `storage` event. Listen so a tour dismissed in tab A
  // does not re-open in tab B on the next refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      setSeen(readFlag(key))
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [key])

  const markSeen = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, '1')
    } catch {
      // Storage write failed (quota / private mode). Still flip local
      // state so the surface dismisses for this session — the user
      // explicitly asked to skip and we honour that even when persist fails.
    }
    setSeen(true)
  }, [key])

  return { seen, markSeen }
}
