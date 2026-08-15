/**
 * Spatial Core · Block E2 · Annotations Read Hook
 *
 * Hydration-aware list of `scan_annotations` rows for a given scan.
 * `<AnchorPins>` consumes this list to render D2 hybrid-anchor pins in the
 * three.js scene; `<SpatialPinList>` (E3) consumes the same list for the
 * 2D side-panel.
 *
 * Mirrors the SaFix hydration contract:
 *   { annotations, isHydrated, error, refresh }
 *
 * `refresh()` follows the `useScanConvertStatus` pattern: bump the tick
 * without flipping `isHydrated` back to `false` so subscribers don't see a
 * mid-stream skeleton flash. The initial hydration still flips false→true
 * exactly once per `scanId` change.
 *
 * Realtime: opt-in via the `subscribe` flag. When subscribed, the hook joins
 * the `scan:${scanId}` broadcast channel (Block A.1 pattern) and refreshes
 * on `annotation_added` / `annotation_resolved` events. Default OFF so
 * screens that only read once (PDF export, share preview) stay cheap.
 */

import { useCallback, useEffect, useState } from 'react'
import { getSpatialRepository } from '../lib/spatial/repository/registry'
import { subscribeScanChannel } from '../lib/spatial/realtime/scanChannel'
import type { ScanAnnotation } from '../lib/spatial/types'

export interface UseSpatialAnnotationsOptions {
  /** Refresh automatically when the scan broadcasts an annotation event. */
  subscribe?: boolean
}

export interface UseSpatialAnnotationsReturn {
  annotations: ScanAnnotation[]
  isHydrated: boolean
  error: Error | null
  refresh: () => void
}

export function useSpatialAnnotations(
  scanId: string | null,
  options: UseSpatialAnnotationsOptions = {},
): UseSpatialAnnotationsReturn {
  const [annotations, setAnnotations] = useState<ScanAnnotation[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const subscribe = options.subscribe ?? false
  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let alive = true
    setIsHydrated(false)
    const load = async () => {
      if (!scanId) {
        if (alive) {
          setAnnotations([])
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const list = await getSpatialRepository().listScanAnnotations(scanId)
        if (!alive) return
        setAnnotations(list)
        setError(null)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setAnnotations([])
      } finally {
        if (alive) setIsHydrated(true)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [scanId, tick])

  useEffect(() => {
    if (!subscribe || !scanId) return
    const unsubscribe = subscribeScanChannel(scanId, event => {
      if (
        event.action === 'annotation_added' ||
        event.action === 'annotation_resolved'
      ) {
        refresh()
      }
    })
    return unsubscribe
  }, [subscribe, scanId, refresh])

  return { annotations, isHydrated, error, refresh }
}
