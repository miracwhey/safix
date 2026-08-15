/**
 * Spatial Core · Block E2 · Measurements Read Hook
 *
 * Hydration-aware list of `scan_measurements` rows for a given scan.
 * `<MeasurementLines>` renders them as 3D segments between surface
 * endpoints; `<SpatialMeasurementTable>` (E3) shows the estimated-vs-
 * verified split per row.
 *
 * Mirrors useSpatialAnnotations: identical hydration contract, identical
 * tick-only refresh, identical opt-in realtime subscription.
 */

import { useCallback, useEffect, useState } from 'react'
import { getSpatialRepository } from '../lib/spatial/repository/registry'
import { subscribeScanChannel } from '../lib/spatial/realtime/scanChannel'
import type { ScanMeasurement } from '../lib/spatial/types'

export interface UseSpatialMeasurementsOptions {
  subscribe?: boolean
}

export interface UseSpatialMeasurementsReturn {
  measurements: ScanMeasurement[]
  isHydrated: boolean
  error: Error | null
  refresh: () => void
}

export function useSpatialMeasurements(
  scanId: string | null,
  options: UseSpatialMeasurementsOptions = {},
): UseSpatialMeasurementsReturn {
  const [measurements, setMeasurements] = useState<ScanMeasurement[]>([])
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
          setMeasurements([])
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const list = await getSpatialRepository().listScanMeasurements(scanId)
        if (!alive) return
        setMeasurements(list)
        setError(null)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setMeasurements([])
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
      if (event.action === 'measurement_edited') {
        refresh()
      }
    })
    return unsubscribe
  }, [subscribe, scanId, refresh])

  return { measurements, isHydrated, error, refresh }
}
