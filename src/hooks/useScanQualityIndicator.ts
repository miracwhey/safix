/**
 * Spatial V1.6 · Phase 2 · useScanQualityIndicator
 *
 * Pure derivation hook that maps a scan's persisted quality fields into the
 * pill render-state (color, label, tooltip). Renders nothing when the scan
 * has no computed quality (NULL `quality_score`) — Manual-Preset captures
 * and pre-Phase-2 rows should not surface a "—" placeholder.
 *
 * ## TBD #5 LOCKED — pill scope = both
 *
 * The pill appears on BOTH self-captured customer scans (`owner_type='customer'`)
 * AND HW-shared scans (`owner_type='craftsman' AND shared_with_customer=true`).
 * No `ownerType` gate here — the consumer (CustomerSpatialDetailScreen) decides
 * which scans get the pill mounted; this hook only computes display state.
 *
 * ## Why a hook (and not a pure function)?
 *
 * The color/tooltip strings live close to the data so that future i18n or
 * theming changes ripple through a single import. The hook also lets future
 * "live recompute on quality change" callers subscribe via Scan refresh
 * without rewriting any render code.
 */

import { useMemo } from 'react'
import type { Scan } from '../lib/spatial/types'
import type { CustomerQualityLabel } from '../lib/spatial/quality/scanQualityScore'

export interface ScanQualityIndicator {
  /** True when the scan has a computed score AND label, so the pill can render. */
  visible: boolean
  score: number | null
  label: CustomerQualityLabel | null
  /** Tailwind class fragment for the pill's text + background. */
  colorClass: string
  /** Stable human label ("Gut" / "Mittel" / "Niedrig"). Empty when not visible. */
  displayLabel: string
  /** Tooltip text explaining what the score reflects. Empty when not visible. */
  tooltip: string
}

const COLOR_BY_LABEL: Record<CustomerQualityLabel, string> = {
  // Green for high — Tailwind 4.x emerald (matches the design-system motion-v1).
  high: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  // Amber for medium — distinct from warning-yellow so users don't misread it
  // as "broken".
  medium: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  // Orange for low (not red — low quality is not an error, just a warning).
  low: 'bg-orange-500/15 text-orange-300 border-orange-400/30',
}

const DISPLAY_LABEL_BY_LABEL: Record<CustomerQualityLabel, string> = {
  high: 'Gut',
  medium: 'Mittel',
  low: 'Niedrig',
}

const TOOLTIP_BY_LABEL: Record<CustomerQualityLabel, string> = {
  high:
    'Hohe Scan-Qualität — Wände + Maße sind verlässlich. Geeignet für Angebote.',
  medium:
    'Mittlere Scan-Qualität — Wände erkennbar, manche Maße ggf. ungenau. Re-Scan empfohlen für präzise Angebote.',
  low:
    'Niedrige Scan-Qualität — wenig Daten erfasst. Bitte erneut scannen mit besseren Lichtverhältnissen + mehr Wandabdeckung.',
}

const EMPTY: ScanQualityIndicator = {
  visible: false,
  score: null,
  label: null,
  colorClass: '',
  displayLabel: '',
  tooltip: '',
}

export function useScanQualityIndicator(scan: Scan | null): ScanQualityIndicator {
  return useMemo(() => {
    if (!scan) return EMPTY
    const { qualityScore, qualityLabel } = scan
    if (qualityScore == null || qualityLabel == null) return EMPTY
    return {
      visible: true,
      score: qualityScore,
      label: qualityLabel,
      colorClass: COLOR_BY_LABEL[qualityLabel],
      displayLabel: DISPLAY_LABEL_BY_LABEL[qualityLabel],
      tooltip: TOOLTIP_BY_LABEL[qualityLabel],
    }
  }, [scan])
}
