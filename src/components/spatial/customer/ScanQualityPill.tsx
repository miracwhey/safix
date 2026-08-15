/**
 * Spatial V1.6 · Phase 2 · ScanQualityPill
 *
 * Header-pill for the Customer detail-screen indicating scan quality
 * ("Gut" / "Mittel" / "Niedrig"). Renders nothing when the scan has no
 * computed quality (NULL `quality_score`) — Manual-Preset captures and
 * pre-Phase-2 rows don't get a placeholder pill (TBD #5 locked).
 *
 * Pill scope: both self-captured Customer scans AND HW-shared scans
 * (no `ownerType` guard at this layer). The hook computes state, this
 * component only renders.
 */

import type { Scan } from '../../../lib/spatial/types'
import { useScanQualityIndicator } from '../../../hooks/useScanQualityIndicator'

export interface ScanQualityPillProps {
  scan: Scan | null
  /** Optional className for layout anchoring (header positioning). */
  className?: string
}

export default function ScanQualityPill({ scan, className = '' }: ScanQualityPillProps) {
  const indicator = useScanQualityIndicator(scan)
  if (!indicator.visible) return null

  return (
    <span
      role="status"
      aria-label={`Scan-Qualität: ${indicator.displayLabel}`}
      title={indicator.tooltip}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md ${indicator.colorClass} ${className}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {indicator.displayLabel}
    </span>
  )
}
