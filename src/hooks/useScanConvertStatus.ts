/**
 * Spatial Core · Block X.5 · Convert-Status Read Hook
 *
 * Surfaces the state of the Block X convert pipeline for one scan:
 *
 *   * `hasUsdz`   — RoomPlan capture has landed (Block B).
 *   * `hasGltf`   — Cloud Run worker has produced the web-viewer asset.
 *   * `convertReady` — both formats present, scan is fully renderable.
 *
 * Lane-2.5 Stream A5 — stuck-detection heuristic. When the USDZ has been
 * sitting in Storage for longer than {@link CONVERT_STUCK_THRESHOLD_MS}
 * without a glb showing up, the Cloud Run worker is almost certainly
 * wedged (queue saturation, worker crash, USDZ shape the converter can't
 * handle). The hook surfaces this as `convertStuck` so the Presales
 * Detail screen can render a "3D-Modell hängt — erneut versuchen" CTA.
 *
 * `retryConvert()` re-fires `enqueueConvertJob` with a Sentry-tagged
 * retry-count. The Edge Function is idempotent on `(scanId, usdzPath)` so
 * spamming the button does not cost extra worker time — but we still
 * lock the user out after `MAX_USER_CONVERT_RETRIES` so a wedged scan
 * does not produce a thousand breadcrumb rows.
 *
 * Hybrid signal model: subscribes to the per-scan Realtime broadcast
 * channel (A.1 broadcast-from-DB pattern, emits on `scans` + `scan_events`
 * + `scan_quality_reports` writes) for an instant nudge, and falls back to
 * a 15s polling tick so the UI heals if the broadcast is lost. The first
 * load happens immediately; subsequent refreshes are debounced by the tick.
 *
 * Callers gate render with `isHydrated`. Toasts on the `hasGltf` edge are
 * the responsibility of the screen (use `useToast()` + a ref).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getSpatialRepository } from '../lib/spatial/repository/registry'
import type { ScanAsset } from '../lib/spatial/types'
import {
  enqueueConvertJob,
  type EnqueueConvertResult,
} from '../lib/spatial/workflow'

const POLL_INTERVAL_MS = 15_000

/**
 * USDZ exists this long without a glb → assume the convert pipeline is
 * wedged and surface the retry CTA. Cloud Run typically finishes in
 * 30-90s on healthy hardware; 5 min is a comfortable failure threshold
 * that does not flap on a normal worker run.
 */
export const CONVERT_STUCK_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Lane-2.5 A5: cap manual retries per page-session. Each call is idempotent
 * server-side, so this cap is just for UX — a wedged scan should escalate
 * to support instead of producing 100 retry breadcrumbs.
 */
export const MAX_USER_CONVERT_RETRIES = 3

export interface UseScanConvertStatusReturn {
  assets: ScanAsset[]
  hasUsdz: boolean
  hasGltf: boolean
  convertReady: boolean
  /** Lane-2.5 A5: heuristic — USDZ landed but glb has been missing > 5 min. */
  convertStuck: boolean
  /** Lane-2.5 A5: number of user-triggered retries this session. */
  convertRetryCount: number
  /** Lane-2.5 A5: convertRetryCount >= MAX_USER_CONVERT_RETRIES. */
  convertRetriesExhausted: boolean
  /** Lane-2.5 A5: true while a retry RPC is in flight. */
  convertRetryBusy: boolean
  isHydrated: boolean
  error: Error | null
  refresh: () => void
  /** Lane-2.5 A5: kick another convert job for the cached USDZ. No-op when
   *  no USDZ asset is present or retries are exhausted. */
  retryConvert: () => Promise<EnqueueConvertResult | null>
}

export function useScanConvertStatus(scanId: string | null): UseScanConvertStatusReturn {
  const [assets, setAssets] = useState<ScanAsset[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [convertRetryCount, setConvertRetryCount] = useState(0)
  const [convertRetryBusy, setConvertRetryBusy] = useState(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!scanId) {
        if (alive) {
          setAssets([])
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const list = await getSpatialRepository().listScanAssets(scanId)
        if (!alive) return
        setAssets(list)
        setError(null)
        setIsHydrated(true)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setIsHydrated(true)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [scanId, tick])

  useEffect(() => {
    if (!scanId) return
    // Polling fallback — keeps the UI eventually-consistent even if the
    // Realtime broadcast misses a tick (cellular reconnect, app resume).
    const interval = setInterval(() => {
      setNowMs(Date.now())
      refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [scanId, refresh])

  useEffect(() => {
    if (!scanId) return
    // Subscribe to the per-scan broadcast topic (A.1 broadcast-from-DB).
    // Any insert on scan_assets / scan_events / scan_quality_reports for
    // this scan fires a broadcast we can listen to without granting the
    // client postgres_changes access to those tables.
    const channel = supabase.channel(`scan:${scanId}`, { config: { private: true } })
    channel
      .on('broadcast', { event: '*' }, () => refresh())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [scanId, refresh])

  // Reset retry counter when the scan id changes — different scan, fresh budget.
  useEffect(() => {
    setConvertRetryCount(0)
  }, [scanId])

  const usdzAsset = useMemo(
    () => assets.find((a) => a.kind === 'usdz') ?? null,
    [assets],
  )
  const hasUsdz = usdzAsset !== null
  const hasGltf = assets.some((a) => a.kind === 'gltf')

  const convertStuck = useMemo(() => {
    if (!hasUsdz || hasGltf) return false
    if (!usdzAsset) return false
    return nowMs - usdzAsset.createdAt > CONVERT_STUCK_THRESHOLD_MS
  }, [hasUsdz, hasGltf, usdzAsset, nowMs])

  const convertRetriesExhausted = convertRetryCount >= MAX_USER_CONVERT_RETRIES

  const retryConvert = useCallback(async (): Promise<EnqueueConvertResult | null> => {
    if (!scanId || !usdzAsset) return null
    if (convertRetriesExhausted) return null
    if (convertRetryBusy) return null

    setConvertRetryBusy(true)
    const next = convertRetryCount + 1
    try {
      const result = await enqueueConvertJob({
        scanId,
        usdzPath: usdzAsset.storagePath,
        retryCount: next,
      })
      setConvertRetryCount(next)
      // Force an immediate refresh — gltf may already exist (dedup) so the
      // UI hides the stuck-card without waiting for the next poll tick.
      refresh()
      return result
    } finally {
      setConvertRetryBusy(false)
    }
  }, [
    scanId,
    usdzAsset,
    convertRetriesExhausted,
    convertRetryBusy,
    convertRetryCount,
    refresh,
  ])

  return {
    assets,
    hasUsdz,
    hasGltf,
    convertReady: hasUsdz && hasGltf,
    convertStuck,
    convertRetryCount,
    convertRetriesExhausted,
    convertRetryBusy,
    isHydrated,
    error,
    refresh,
    retryConvert,
  }
}
