/**
 * Spatial V1.6 · Phase 4 · useSpatialFirstSuccessToast
 *
 * Mount-once celebration toast when the customer lands their first own
 * scan (`ownerType='customer'` count transitions 0 → 1). Friction-aware:
 *   - Persisted via `useSpatialFirstRunFlag` so re-installs / sign-outs
 *     do not re-trigger.
 *   - Gated on `isHydrated` — the toast must fire on a real 0→1
 *     transition, not on the first hydration flip.
 *   - Confetti-free (Memory pref `feedback_html_mockup_design_lessons`):
 *     emoji-only outcome wording, no canvas-confetti dependency.
 *
 * Usage: mount once in `CustomerSpatialHubScreen` with the live
 * `customerScans` array and `isHydrated`. The hook itself owns nothing
 * else.
 */

import { useEffect, useRef } from 'react'

import { useToast } from './useToast'
import { useSpatialFirstRunFlag } from './useSpatialFirstRunFlag'
import type { Scan } from '../lib/spatial/types'

const STORAGE_KEY = 'spatial-customer-first-success-toast-seen-v1'

const TOAST_MESSAGE =
  'Dein erster Raum ist vermessen 🎉 — der Handwerker kann ihn jetzt sehen.'

export interface UseSpatialFirstSuccessToastArgs {
  scans: ReadonlyArray<Scan>
  isHydrated: boolean
}

export function useSpatialFirstSuccessToast({
  scans,
  isHydrated,
}: UseSpatialFirstSuccessToastArgs): void {
  const toast = useToast()
  const { seen, markSeen } = useSpatialFirstRunFlag(STORAGE_KEY)
  // `null` = not yet hydrated baseline; first hydration sets the baseline,
  // and only subsequent increments past that baseline count as a 0→1
  // transition. Prevents the toast from firing on initial hydration when
  // the customer already has scans from a previous session.
  const baselineRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isHydrated) return
    if (seen) return
    const ownCount = scans.filter((s) => s.ownerType === 'customer').length

    if (baselineRef.current === null) {
      baselineRef.current = ownCount
      return
    }

    if (baselineRef.current === 0 && ownCount >= 1) {
      toast.success(TOAST_MESSAGE)
      markSeen()
      baselineRef.current = ownCount
    }
  }, [scans, isHydrated, seen, markSeen, toast])
}
