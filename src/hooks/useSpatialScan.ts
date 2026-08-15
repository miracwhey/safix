/**
 * Spatial Core · Block B.5 · Hydration-aware Spatial Read Hook
 *
 * Single read entry point for screens that show a project's or job's latest
 * scan. Matches the SaFix hydration contract used by useCorrections,
 * useJobs, useDisputes etc.:
 *
 *   { scan, assets, isHydrated, error, refresh }
 *
 * Callers gate render with `isHydrated` (`<ScreenSkeleton variant="detail" />`
 * is the canonical loader) and treat `scan == null` as the empty state.
 *
 * V1 returns the most-recently created scan per scope. Versioning (parent
 * chain via listScanVersions) is exposed for Block F + I.
 */

import { useCallback, useEffect, useState } from 'react'
import { getSpatialRepository } from '../lib/spatial/repository/registry'
import type { Scan, ScanAsset } from '../lib/spatial/types'

export type SpatialScanScope =
  | { projectId: string; jobId?: undefined }
  | { jobId: string; projectId?: undefined }
  | null

export interface UseSpatialScanReturn {
  scan: Scan | null
  assets: ScanAsset[]
  isHydrated: boolean
  error: Error | null
  /** Re-runs the load (kept stable across renders). */
  refresh: () => void
}

export function useSpatialScan(scope: SpatialScanScope): UseSpatialScanReturn {
  const [scan, setScan] = useState<Scan | null>(null)
  const [assets, setAssets] = useState<ScanAsset[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const projectId = scope && 'projectId' in scope ? scope.projectId : null
  const jobId = scope && 'jobId' in scope ? scope.jobId : null

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!projectId && !jobId) {
        if (alive) {
          setScan(null)
          setAssets([])
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const repo = getSpatialRepository()
        const scans = projectId
          ? await repo.listScansForProject(projectId)
          : await repo.listScansForJob(jobId!)
        const latest = scans[0] ?? null
        const latestAssets = latest ? await repo.listScanAssets(latest.id) : []
        if (!alive) return
        setScan(latest)
        setAssets(latestAssets)
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
  }, [projectId, jobId, tick])

  const refresh = useCallback(() => {
    setIsHydrated(false)
    setTick(t => t + 1)
  }, [])

  return { scan, assets, isHydrated, error, refresh }
}
