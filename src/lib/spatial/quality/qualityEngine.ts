/**
 * Spatial Core · Block C.1 · Quality Engine V1 Entry Point
 *
 * Pure function — given a scan snapshot, returns score (0–100) + bucket +
 * sorted warnings + the engine-version that produced the report.
 *
 * The score starts at 100 and is reduced by the sum of weights of every
 * warning that fires; the final value is clamped to [0, 100]. The bucket
 * is derived from fixed boundaries (matches the SQL mirror exactly).
 *
 * Engine version is part of the output so downstream consumers can re-run
 * outdated reports or sort historic reports by engine generation when the
 * weights or rules change in v1.1+.
 *
 * ## TS↔SQL parity contract (Phase 2)
 *
 * Rules R1–R7 are now mirrored 1:1 between this engine and the SECURITY
 * DEFINER RPC `public.run_quality_engine(uuid, jsonb)` in migration
 * `20260519000000_quality_engine_mesh_summary.sql`. Callers SHOULD pass
 * `meshSummary` when a Phase 2 harvester aggregate is available — both
 * the live capture-path (`captureScan → finishCapture(autoQuality=true)`)
 * and the manual rerun-path (`useScanQualityReport.rerun()` reading
 * `mesh_summary.json` from storage) do this. Omit `meshSummary` to take
 * Plan B (surface-confidence fallback only); TS + SQL stay byte-identical
 * in that path too. The integration tests in
 * `tests/lib/spatial/qualityEngineIntegration.test.ts` exercise both;
 * `tests/lib/spatial/qualityEngine.parity.test.ts` pins the mesh-aware
 * contract.
 */

import type { ScanQualityBucket, ScanQualityWarning } from '../types'
import {
  ALL_RULES,
  QUALITY_ENGINE_VERSION,
  type QualityInput,
} from './rules'

export interface QualityResult {
  score: number
  bucket: ScanQualityBucket
  warnings: ScanQualityWarning[]
  engineVersion: typeof QUALITY_ENGINE_VERSION
}

const BUCKET_FLOORS: ReadonlyArray<{ floor: number; bucket: ScanQualityBucket }> = [
  { floor: 85, bucket: 'excellent' },
  { floor: 70, bucket: 'good' },
  { floor: 50, bucket: 'fair' },
  { floor: 0, bucket: 'poor' },
]

export function bucketForScore(score: number): ScanQualityBucket {
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  for (const entry of BUCKET_FLOORS) {
    if (clamped >= entry.floor) return entry.bucket
  }
  return 'poor'
}

export function runQualityEngine(input: QualityInput): QualityResult {
  const hits = ALL_RULES.map(rule => rule(input)).filter(
    (h): h is NonNullable<ReturnType<(typeof ALL_RULES)[number]>> => h !== null,
  )
  const penalty = hits.reduce((acc, h) => acc + h.weight, 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  // Sort warnings alphabetically so the JSON output is byte-stable across
  // runs — matters for cache + idempotency keys derived from the report.
  const warnings: ScanQualityWarning[] = hits
    .map(h => h.warning)
    .sort((a, b) => a.localeCompare(b))
  return {
    score,
    bucket: bucketForScore(score),
    warnings,
    engineVersion: QUALITY_ENGINE_VERSION,
  }
}
