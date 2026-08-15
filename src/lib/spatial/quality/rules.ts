/**
 * Spatial Core · Block C.1 · Quality Engine Rules (Pure Functions)
 *
 * Each rule takes a snapshot of the captured scan and returns either the
 * `ScanQualityWarning` it emitted or `null` when the input is within bounds.
 *
 * Rules are intentionally deterministic, enum-output-only and free of any
 * domain side-effects so the same input always yields the same output across
 * runs and across runtimes (TS in the browser, plpgsql on the server). The
 * SQL mirror in `supabase/migrations/20260518000020_quality_engine_rpc.sql`
 * implements the same predicates — parity is exercised by
 * `tests/lib/spatial/qualityEngine.parity.test.ts`.
 *
 * Score weights (sum of warning weights subtracted from 100) live alongside
 * the rule itself so the calibration is visible in one place; tweaking a
 * weight without touching the predicate is intentional and supported.
 */

import type {
  ScanQualityWarning,
  ScanRoom,
  ScanSurface,
  ScanMeasurement,
  ScanDeviceMeta,
} from '../types'

/**
 * Optional Mesh summary handed in by the convert pipeline (Block X) or the
 * D-spike Mesh-Snapshot session. When absent, mesh-dependent rules silently
 * fall through (Plan B path — engine still ships score + bucket).
 */
export interface MeshSummary {
  /** 0–1 fraction of wall surface area covered by classified mesh triangles. */
  wallCoveragePct?: number
  /** Average per-surface confidence across the room (0–1). */
  averageConfidence?: number
  /** Triangle count for forensics; not used by any rule yet. */
  triangleCount?: number
}

export interface QualityInput {
  rooms: ScanRoom[]
  surfaces: ScanSurface[]
  measurements: ScanMeasurement[]
  meshSummary?: MeshSummary
  deviceMeta?: ScanDeviceMeta
}

export interface QualityRuleHit {
  warning: ScanQualityWarning
  /** Points subtracted from the 100-point starting score. */
  weight: number
}

/** Threshold + plausibility constants, declared once so rules + tests + SQL
 *  mirror reference the same numbers. Bumping a number here always requires
 *  a matching update in the SQL function. */
export const QUALITY_THRESHOLDS = Object.freeze({
  minWalls: 4,
  area: { minM2: 3, maxM2: 200 },
  ceiling: { minM: 2.0, maxM: 4.5 },
  door: { minW: 0.6, maxW: 1.2, minH: 1.8, maxH: 2.4 },
  window: { minW: 0.2, maxW: 3.0, minH: 0.3, maxH: 2.5 },
  meshWallCoveragePctFloor: 0.7,
  meshAverageConfidenceFloor: 0.5,
})

export const QUALITY_WEIGHTS: Record<ScanQualityWarning, number> = Object.freeze({
  too_few_walls: 25,
  area_implausible: 18,
  ceiling_implausible: 15,
  wall_coverage_low: 14,
  low_confidence: 10,
  door_dimensions_unusual: 9,
  window_dimensions_unusual: 9,
})

export const QUALITY_ENGINE_VERSION = 'v1.0.0' as const

// ── Rules ────────────────────────────────────────────────────────────────────

export function ruleTooFewWalls(input: QualityInput): QualityRuleHit | null {
  const wallCount = input.surfaces.filter(s => s.kind === 'wall').length
  if (wallCount < QUALITY_THRESHOLDS.minWalls) {
    return { warning: 'too_few_walls', weight: QUALITY_WEIGHTS.too_few_walls }
  }
  return null
}

export function ruleAreaImplausible(input: QualityInput): QualityRuleHit | null {
  const room = input.rooms[0]
  if (!room) return null
  const area = room.areaM2Verified ?? room.areaM2Estimated
  if (area == null) return null
  if (area < QUALITY_THRESHOLDS.area.minM2 || area > QUALITY_THRESHOLDS.area.maxM2) {
    return { warning: 'area_implausible', weight: QUALITY_WEIGHTS.area_implausible }
  }
  return null
}

export function ruleCeilingImplausible(input: QualityInput): QualityRuleHit | null {
  const room = input.rooms[0]
  if (!room) return null
  const h = room.ceilingHVerified ?? room.ceilingHEstimated
  if (h == null) return null
  if (h < QUALITY_THRESHOLDS.ceiling.minM || h > QUALITY_THRESHOLDS.ceiling.maxM) {
    return { warning: 'ceiling_implausible', weight: QUALITY_WEIGHTS.ceiling_implausible }
  }
  return null
}

export function ruleDoorDimensionsUnusual(input: QualityInput): QualityRuleHit | null {
  const doors = input.surfaces.filter(s => s.kind === 'door')
  if (doors.length === 0) return null
  const { door } = QUALITY_THRESHOLDS
  const anyUnusual = doors.some(d => {
    const w = d.dimWVerified ?? d.dimWEstimated
    const h = d.dimHVerified ?? d.dimHEstimated
    if (w == null || h == null) return false
    return w < door.minW || w > door.maxW || h < door.minH || h > door.maxH
  })
  if (anyUnusual) {
    return {
      warning: 'door_dimensions_unusual',
      weight: QUALITY_WEIGHTS.door_dimensions_unusual,
    }
  }
  return null
}

export function ruleWindowDimensionsUnusual(input: QualityInput): QualityRuleHit | null {
  const windows = input.surfaces.filter(s => s.kind === 'window')
  if (windows.length === 0) return null
  const { window } = QUALITY_THRESHOLDS
  const anyUnusual = windows.some(w => {
    const wid = w.dimWVerified ?? w.dimWEstimated
    const hei = w.dimHVerified ?? w.dimHEstimated
    if (wid == null || hei == null) return false
    return wid < window.minW || wid > window.maxW || hei < window.minH || hei > window.maxH
  })
  if (anyUnusual) {
    return {
      warning: 'window_dimensions_unusual',
      weight: QUALITY_WEIGHTS.window_dimensions_unusual,
    }
  }
  return null
}

export function ruleWallCoverageLow(input: QualityInput): QualityRuleHit | null {
  const cov = input.meshSummary?.wallCoveragePct
  if (cov == null) return null
  if (cov < QUALITY_THRESHOLDS.meshWallCoveragePctFloor) {
    return { warning: 'wall_coverage_low', weight: QUALITY_WEIGHTS.wall_coverage_low }
  }
  return null
}

export function ruleLowConfidence(input: QualityInput): QualityRuleHit | null {
  // Prefer mesh-supplied average; fall back to the average across surface
  // rows (so the rule still fires when D-spike is unavailable but surfaces
  // carry per-surface confidence values).
  const fromMesh = input.meshSummary?.averageConfidence
  if (fromMesh != null) {
    return fromMesh < QUALITY_THRESHOLDS.meshAverageConfidenceFloor
      ? { warning: 'low_confidence', weight: QUALITY_WEIGHTS.low_confidence }
      : null
  }
  const withConfidence = input.surfaces.filter(s => s.confidence != null)
  if (withConfidence.length === 0) return null
  const avg =
    withConfidence.reduce((acc, s) => acc + (s.confidence ?? 0), 0) / withConfidence.length
  return avg < QUALITY_THRESHOLDS.meshAverageConfidenceFloor
    ? { warning: 'low_confidence', weight: QUALITY_WEIGHTS.low_confidence }
    : null
}

/** Ordered for determinism — every TS↔SQL parity check expects this order. */
export const ALL_RULES: ReadonlyArray<(input: QualityInput) => QualityRuleHit | null> = [
  ruleTooFewWalls,
  ruleAreaImplausible,
  ruleCeilingImplausible,
  ruleDoorDimensionsUnusual,
  ruleWindowDimensionsUnusual,
  ruleWallCoverageLow,
  ruleLowConfidence,
]
