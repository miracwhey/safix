/**
 * Spatial Lane 3 V1.6 Block 3 · useCustomerSpatialDetail
 *
 * Single-scan read hook for the customer detail screen. Resolves:
 *   - scan
 *   - scan_assets (USDZ + glTF)
 *   - scan_annotations (RLS filters customer_visible server-side; the hook
 *     itself does not double-filter, so HW debugging via the same hook
 *     still sees all pins)
 *   - scan_measurements
 *
 * Direct import path — no spatial workflow barrel.
 */

import { useCallback, useEffect, useState } from 'react'

import { getSpatialRepository } from '../repository/registry'
import type { Scan, ScanAsset, ScanAnnotation, ScanMeasurement } from '../types'

export interface UseCustomerSpatialDetailResult {
  scan: Scan | null
  assets: ScanAsset[]
  annotations: ScanAnnotation[]
  measurements: ScanMeasurement[]
  isHydrated: boolean
  error: string | null
  refresh: () => void
}

export function useCustomerSpatialDetail(
  scanId: string | null,
): UseCustomerSpatialDetailResult {
  const [scan, setScan] = useState<Scan | null>(null)
  const [assets, setAssets] = useState<ScanAsset[]>([])
  const [annotations, setAnnotations] = useState<ScanAnnotation[]>([])
  const [measurements, setMeasurements] = useState<ScanMeasurement[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    const load = async () => {
      // Single async entry point — `await Promise.resolve()` upfront keeps the
      // empty-scanId branch off the synchronous render path (react-hooks/
      // set-state-in-effect).
      await Promise.resolve()
      if (!alive) return
      if (!scanId) {
        setScan(null)
        setAssets([])
        setAnnotations([])
        setMeasurements([])
        setError(null)
        setIsHydrated(true)
        return
      }
      try {
        const repo = getSpatialRepository()
        const [s, a, ann, m] = await Promise.all([
          repo.getScan(scanId),
          repo.listScanAssets(scanId),
          repo.listScanAnnotations(scanId),
          repo.listScanMeasurements(scanId),
        ])
        if (!alive) return
        setScan(s)
        setAssets(a)
        setAnnotations(ann)
        setMeasurements(m)
        setError(null)
        setIsHydrated(true)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
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

  return { scan, assets, annotations, measurements, isHydrated, error, refresh }
}
