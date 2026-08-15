/**
 * Spatial Core · Block G.3 · Re-Scan CTA on large measurement diffs
 *
 * Surfaces a one-row "Maße weichen stark ab — neuer Scan?" call-to-action
 * when more than two measurements have a |verified - estimated| / estimated
 * delta > 10%. The threshold + count come straight from the master plan;
 * the actual scan trigger lives in the parent screen (Block E3's onStartScan).
 */

import { useMemo } from 'react'
import type { ScanMeasurement } from '../../../lib/spatial/types'

export interface RescanCTAProps {
  measurements: ScanMeasurement[]
  onStartScan?: () => void
  /** Threshold as a ratio (default 0.10 = 10%). */
  threshold?: number
  /** Minimum number of out-of-bounds measurements before the CTA fires (default 3). */
  minCount?: number
}

export function RescanCTA(props: RescanCTAProps) {
  const threshold = props.threshold ?? 0.1
  const minCount = props.minCount ?? 3

  const driftedCount = useMemo(() => {
    let count = 0
    for (const m of props.measurements) {
      if (m.valueEstimatedM == null || m.valueVerifiedM == null) continue
      if (m.valueEstimatedM === 0) continue
      const delta = Math.abs(m.valueVerifiedM - m.valueEstimatedM) / m.valueEstimatedM
      if (delta > threshold) count += 1
    }
    return count
  }, [props.measurements, threshold])

  if (driftedCount < minCount) return null

  return (
    <div className="flex items-center justify-between rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm">
      <span className="text-rose-800">
        {driftedCount} Maße weichen stark vom Erstscan ab — neuer Scan empfohlen.
      </span>
      {props.onStartScan ? (
        <button
          type="button"
          onClick={props.onStartScan}
          className="ml-3 rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700"
        >
          Raum erneut scannen
        </button>
      ) : null}
    </div>
  )
}
