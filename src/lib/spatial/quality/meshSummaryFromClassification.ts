/**
 * Spatial Core · Phase 2 · MeshClassification → MeshSummary bridge
 *
 * The Capacitor plugin emits a rich `MeshClassification` aggregate (per-class
 * face counts, wall coverage ratio, thermal/throttle metadata) at scan finish.
 * The Quality Engine consumes the much simpler `MeshSummary` shape
 * (wall-coverage percentage + triangle count). This file is the single mapper
 * between the two so the contract stays in one place and both the in-memory
 * and Supabase RPC paths derive the same input.
 *
 * `averageConfidence` intentionally stays `undefined`: Apple's mesh API
 * surfaces classification labels but not per-face confidence. Synthesising a
 * proxy from `samplesCollected` × `totalFaces` would penalise short scans
 * unfairly — Rule R7 falls through to its surface-confidence fallback in
 * that case, which is the calibrated behaviour from Block C.
 *
 * When `degraded === true` we deliberately return `undefined`: the mesh was
 * paused mid-scan (thermal `.critical`) so the snapshot is partial and
 * feeding R6 with a partial coverage number would falsely flag scans on hot
 * devices. The capture-time telemetry surfaces the degraded state separately.
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'
import type { MeshSummary } from './rules'

export function meshSummaryFromClassification(
  mesh: MeshClassification | null | undefined,
): MeshSummary | undefined {
  if (!mesh) return undefined
  if (mesh.degraded) return undefined
  // `wallCoverageRatio` is already clamped to [0, 1] by the harvester. Mirror
  // the field as `wallCoveragePct` — Quality Engine reads the value as a
  // 0..1 fraction (the field name is historical, see `QUALITY_THRESHOLDS`).
  return {
    wallCoveragePct: mesh.wallCoverageRatio,
    triangleCount: mesh.totalFaces,
  }
}
