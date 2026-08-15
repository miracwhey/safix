/**
 * Spatial V1.6 · Phase 2 · Customer Scan Quality Score
 *
 * Thin Customer-facing wrapper around the existing `runQualityEngine` (V1)
 * pipeline. The engine itself already produces a 0-100 integer score and a
 * four-bucket label ('excellent'|'good'|'fair'|'poor'); the Customer surface
 * needs the simpler three-tier label per F1 migration CHECK constraint
 * (`high`|`medium`|`low`).
 *
 * ## Why a separate function, not a bucket-remap?
 *
 * F1 stores `quality_score smallint` and `quality_label text` on `public.scans`
 * — the label is denormalised so that index scans can filter by tier without
 * recomputing thresholds in SQL. Keeping the Customer threshold definition
 * here (not in `qualityEngine.ts`) keeps the V1 engine's bucket contract
 * (TS↔SQL parity, internal HW surfaces) untouched. The two label systems are
 * independent and may drift if A/B-testing pushes the Customer thresholds.
 *
 * ## Thresholds (LOCKED 2026-05-26 Tag, TBD #5 + Plan §1)
 *
 *   score ≥ 80  →  'high'    (entspricht 'excellent' + Teil von 'good')
 *   50 – 79     →  'medium'  (Teil von 'good' + 'fair')
 *   < 50        →  'low'     ('poor' = score < 50 im V1 engine)
 *
 * The constants are exported so A/B-calibration in Hannover-Pilot (10 HW)
 * can shift the boundary without touching call-sites.
 *
 * ## Scope (TBD #5 locked)
 *
 * The Customer-Pill renders on both self-captured scans (`owner_type='customer'`)
 * AND HW-shared scans (`owner_type='craftsman' AND shared_with_customer=true`).
 * This file makes NO `owner_type`-guard — the call-site decides whether to
 * compute. NULL scores (Manual-Preset captures, pre-Phase-2 rows) are handled
 * by the call-site too (rendering `null` for the pill when `quality_score IS NULL`).
 */

import { runQualityEngine, type QualityResult } from './qualityEngine'
import type { QualityInput } from './rules'

export type CustomerQualityLabel = 'high' | 'medium' | 'low'

export interface CustomerScanQuality {
  /** 0-100 integer score. Identical to the V1 engine's score; clamped, rounded. */
  score: number
  /** Three-tier Customer label. Persisted in `scans.quality_label` (F1 CHECK). */
  label: CustomerQualityLabel
}

export const CUSTOMER_QUALITY_THRESHOLDS = Object.freeze({
  /** Floor for the 'high' tier. Score ≥ this value maps to 'high'. */
  highMin: 80,
  /** Floor for the 'medium' tier. Score ≥ this value (but < highMin) maps to 'medium'. */
  mediumMin: 50,
})

/**
 * Map a raw quality score (any numeric) to the three-tier Customer label.
 * Negative or out-of-range inputs are clamped to [0, 100] then rounded.
 * Boundary behaviour: `score === 80` → 'high', `score === 50` → 'medium'.
 */
export function customerLabelForScore(score: number): CustomerQualityLabel {
  const safe = Number.isFinite(score) ? score : 0
  const clamped = Math.max(0, Math.min(100, Math.round(safe)))
  if (clamped >= CUSTOMER_QUALITY_THRESHOLDS.highMin) return 'high'
  if (clamped >= CUSTOMER_QUALITY_THRESHOLDS.mediumMin) return 'medium'
  return 'low'
}

/**
 * Run the V1 quality engine and project its output onto the Customer label
 * space. The engine itself is the single source of truth for the score — any
 * future rule changes or weight tuning ripple through automatically.
 */
export function computeCustomerScanQuality(input: QualityInput): CustomerScanQuality {
  const result: QualityResult = runQualityEngine(input)
  return {
    score: result.score,
    label: customerLabelForScore(result.score),
  }
}
