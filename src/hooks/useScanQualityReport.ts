/**
 * Spatial Core · Block C.3 · Quality Report Read Hook
 *
 * Hydration-aware hook for the latest scan_quality_reports row of a scan.
 * Pairs with `useSpatialScan(scope)` — the typical screen pattern is:
 *
 *   const { scan, isHydrated: scanHydrated } = useSpatialScan({ jobId })
 *   const { report, isHydrated: reportHydrated, rerun } = useScanQualityReport(scan?.id ?? null)
 *
 * `rerun()` calls the SECURITY DEFINER RPC `run_quality_engine` (or the
 * in-process mirror under VITE_DATA_SOURCE=in-memory) and refreshes the
 * cached report.
 */

import { useCallback, useEffect, useState } from 'react'
import { meshSummaryFromClassification } from '../lib/spatial/quality/meshSummaryFromClassification'
import { getSpatialRepository } from '../lib/spatial/repository/registry'
import { loadMeshClassificationAsset } from '../lib/spatial/storage'
import type { ScanQualityReport } from '../lib/spatial/types'

export interface UseScanQualityReportReturn {
  report: ScanQualityReport | null
  isHydrated: boolean
  error: Error | null
  /** Triggers `run_quality_engine` on the server and refreshes state. */
  rerun: () => Promise<void>
  /** Manual refresh without re-running the engine. */
  refresh: () => void
}

export function useScanQualityReport(scanId: string | null): UseScanQualityReportReturn {
  const [report, setReport] = useState<ScanQualityReport | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!scanId) {
        if (alive) {
          setReport(null)
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const latest = await getSpatialRepository().getLatestQualityReport(scanId)
        if (!alive) return
        setReport(latest)
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

  const refresh = useCallback(() => {
    setIsHydrated(false)
    setTick(t => t + 1)
  }, [])

  const rerun = useCallback(async () => {
    if (!scanId) return
    setIsHydrated(false)
    try {
      // Phase 2: rehydrate the mesh aggregate from storage so R6 + R7
      // evaluate against the same data the live capture used. Returns null
      // gracefully on non-LiDAR scans, storage 404, or in-memory mode →
      // engine falls through to Plan B exactly like the live path does.
      const meshClassification = await loadMeshClassificationAsset(scanId)
      const meshSummary = meshSummaryFromClassification(meshClassification)
      const fresh = await getSpatialRepository().runQualityEngine(scanId, { meshSummary })
      setReport(fresh)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsHydrated(true)
    }
  }, [scanId])

  return { report, isHydrated, error, rerun, refresh }
}
