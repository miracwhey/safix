/**
 * Spatial · Canonical · Validator · Wall Rules
 *
 * Pure rule functions checking individual Walls inside a RoomScene against
 * the binding invariants of Master-Spec §1.6 + §9.2. Each rule:
 *
 *   - is a pure function `(scene: RoomScene) → ValidationIssue[]`,
 *   - emits at most one issue per offending node,
 *   - never throws.
 *
 * Threshold constants live at the top of the file so they can be tuned
 * (and tested) independently of the rule logic.
 */

import type { Wall } from '../../types/geometry.ts'
import type { RoomScene } from '../../types/scene-graph.ts'
import type { ValidationIssue, ValidationSeverity } from '../../types/validation.ts'
import { lengthCompute } from '../../geometry/wall-geometry.ts'
import { buildWallJoinGraph, type WallJoinDiagnostic } from '../../geometry/wall-joins.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds (tunable · exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Walls below this length are considered degenerate. */
export const WALL_MIN_LENGTH_M = 0.05

/** Walls shorter than this are flagged as unusual. */
export const WALL_UNUSUAL_HEIGHT_MIN_M = 2.0

/** Walls taller than this are flagged as unusual. */
export const WALL_UNUSUAL_HEIGHT_MAX_M = 4.0

/** Default thickness applied by the bridge when RoomPlan does not supply one. */
export const WALL_DEFAULT_THICKNESS_M = 0.15

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

export function checkWallHeightMissing(scene: RoomScene): ValidationIssue[] {
  return scene.walls
    .filter(w => w.height_m === undefined || w.height_m === null || w.height_m <= 0)
    .map(w => issue(w, 'WALL_HEIGHT_MISSING', 'error', `Wall ${w.id} has no usable height`))
}

export function checkWallZeroLength(scene: RoomScene): ValidationIssue[] {
  return scene.walls
    .filter(w => lengthCompute(w) < WALL_MIN_LENGTH_M)
    .map(w => issue(w, 'WALL_ZERO_LENGTH', 'error', `Wall ${w.id} has near-zero length`))
}

export function checkWallHeightUnusual(scene: RoomScene): ValidationIssue[] {
  return scene.walls
    .filter(w => w.height_m < WALL_UNUSUAL_HEIGHT_MIN_M || w.height_m > WALL_UNUSUAL_HEIGHT_MAX_M)
    .map(w =>
      issue(
        w,
        'WALL_HEIGHT_UNUSUAL',
        'warning',
        `Wall ${w.id} height ${w.height_m.toFixed(2)} m is outside the typical 2.0–4.0 m range`,
        'Verify wall height with the customer during scan-review.',
      ),
    )
}

export function checkWallThicknessDefaultUsed(scene: RoomScene): ValidationIssue[] {
  return scene.walls
    .filter(w => Math.abs(w.thickness_m - WALL_DEFAULT_THICKNESS_M) < 1e-6)
    .map(w =>
      issue(
        w,
        'WALL_THICKNESS_DEFAULT_USED',
        'warning',
        `Wall ${w.id} uses the default thickness ${WALL_DEFAULT_THICKNESS_M} m`,
        'RoomPlan does not report wall thickness; this is the implicit default.',
      ),
    )
}

export function checkWallNeedsMaterial(scene: RoomScene): ValidationIssue[] {
  return scene.walls
    .filter(w => !w.material_id)
    .map(w =>
      issue(w, 'WALL_NEEDS_MATERIAL', 'hint', `Wall ${w.id} has no material assigned`),
    )
}

/**
 * Surface the diagnostics produced while deriving the wall-join graph
 * (corners-edges-design §2.7): unresolved corner gaps, ambiguous junctions,
 * walls too short to host their miters, and suspected duplicate scans.
 *
 * All are warnings or hints — corner-joining never blocks rendering; the
 * scene still draws gracefully (Risk R7 / Decision #5).
 */
export function checkWallJoins(scene: RoomScene): ValidationIssue[] {
  const graph = buildWallJoinGraph(scene.walls)
  return graph.diagnostics.map(d => ({
    code: d.code,
    severity: JOIN_DIAGNOSTIC_SEVERITY[d.code],
    affected_node_ids: d.wall_ids,
    message: JOIN_DIAGNOSTIC_MESSAGE[d.code](d.wall_ids),
    suggested_fix: JOIN_DIAGNOSTIC_FIX[d.code],
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const WALL_RULES = [
  checkWallHeightMissing,
  checkWallZeroLength,
  checkWallHeightUnusual,
  checkWallThicknessDefaultUsed,
  checkWallNeedsMaterial,
  checkWallJoins,
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Wall-join diagnostic mapping
// ─────────────────────────────────────────────────────────────────────────────

const JOIN_DIAGNOSTIC_SEVERITY: Record<WallJoinDiagnostic['code'], ValidationSeverity> = {
  WALL_JOIN_GAP_LARGE: 'warning',
  WALL_JOIN_AMBIGUOUS: 'warning',
  WALL_TOO_SHORT_FOR_JOIN: 'warning',
  WALL_DUPLICATE_SUSPECTED: 'hint',
}

const JOIN_DIAGNOSTIC_MESSAGE: Record<
  WallJoinDiagnostic['code'],
  (wallIds: string[]) => string
> = {
  WALL_JOIN_GAP_LARGE: ids =>
    `Walls ${ids.join(' + ')} leave a corner gap too large to close automatically`,
  WALL_JOIN_AMBIGUOUS: ids =>
    `Wall ${ids.join(' + ')} has an endpoint equidistant to two corners — left unjoined`,
  WALL_TOO_SHORT_FOR_JOIN: ids =>
    `Wall ${ids.join(' + ')} is too short to host its corner miters`,
  WALL_DUPLICATE_SUSPECTED: ids =>
    `Walls ${ids.join(' + ')} share a near-identical centerline — possible scan duplicate`,
}

const JOIN_DIAGNOSTIC_FIX: Record<WallJoinDiagnostic['code'], string> = {
  WALL_JOIN_GAP_LARGE: 'Drag the wall endpoints together in edit mode.',
  WALL_JOIN_AMBIGUOUS: 'Nudge the wall endpoint toward the intended corner.',
  WALL_TOO_SHORT_FOR_JOIN: 'Verify the short wall is real, or merge it with a neighbour.',
  WALL_DUPLICATE_SUSPECTED: 'Remove one of the duplicate walls in edit mode.',
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function issue(
  w: Wall,
  code: ValidationIssue['code'],
  severity: ValidationIssue['severity'],
  message: string,
  suggested_fix?: string,
): ValidationIssue {
  return {
    code,
    severity,
    affected_node_ids: [w.id],
    message,
    suggested_fix,
  }
}
