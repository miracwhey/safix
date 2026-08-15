/**
 * Spatial · Canonical · Validator · Opening Rules
 *
 * Checks doors / windows / openings against their host walls:
 *   - host wall must exist
 *   - opening must fit within the host wall's length × height
 *   - windows must sit above the floor and below the ceiling
 *
 * Per Master-Spec §1.8 invariants:
 *   - 0 ≤ offset_along_wall_m ≤ host_wall.length_m − width_m
 *   - 0 ≤ offset_from_floor_m ≤ host_wall.height_m − height_m
 */

import type { Wall, WallOpening } from '../../types/geometry.ts'
import type { RoomScene } from '../../types/scene-graph.ts'
import type { ValidationIssue } from '../../types/validation.ts'
import { lengthCompute } from '../../geometry/wall-geometry.ts'

export function checkDoorHostWallNotFound(scene: RoomScene): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const wallIds = new Set(scene.walls.map(w => w.id))
  for (const wall of scene.walls) {
    for (const op of wall.openings) {
      if (!wallIds.has(op.host_wall_id)) {
        issues.push({
          code: 'DOOR_HOST_WALL_NOT_FOUND',
          severity: 'error',
          affected_node_ids: [op.id],
          message: `Opening ${op.id} references missing host wall ${op.host_wall_id}`,
        })
      }
    }
  }
  return issues
}

export function checkDoorOutsideWallBounds(scene: RoomScene): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const wall of scene.walls) {
    for (const op of wall.openings) {
      if (op.type !== 'door' && op.type !== 'opening') continue
      if (!fitsAlongWall(op, wall)) {
        issues.push({
          code: 'DOOR_OUTSIDE_WALL_BOUNDS',
          severity: 'error',
          affected_node_ids: [op.id, wall.id],
          message: `Opening ${op.id} (${op.width_m.toFixed(2)} m wide @ offset ${op.offset_along_wall_m.toFixed(2)} m) does not fit within wall ${wall.id} (${lengthCompute(wall).toFixed(2)} m)`,
        })
      }
    }
  }
  return issues
}

export function checkWindowOutsideWallBounds(scene: RoomScene): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const wall of scene.walls) {
    for (const op of wall.openings) {
      if (op.type !== 'window') continue
      if (!fitsAlongWall(op, wall)) {
        issues.push({
          code: 'WINDOW_OUTSIDE_WALL_BOUNDS',
          severity: 'error',
          affected_node_ids: [op.id, wall.id],
          message: `Window ${op.id} does not fit within wall ${wall.id}`,
        })
      }
    }
  }
  return issues
}

export function checkWindowBelowFloor(scene: RoomScene): ValidationIssue[] {
  return collectOpenings(scene)
    .filter(([, op]) => op.type === 'window' && op.offset_from_floor_m < 0)
    .map(([wall, op]) => ({
      code: 'WINDOW_BELOW_FLOOR',
      severity: 'error',
      affected_node_ids: [op.id, wall.id],
      message: `Window ${op.id} has negative floor offset (${op.offset_from_floor_m.toFixed(2)} m)`,
    }))
}

export function checkWindowAboveCeiling(scene: RoomScene): ValidationIssue[] {
  return collectOpenings(scene)
    .filter(([wall, op]) => op.type === 'window' && op.offset_from_floor_m + op.height_m > wall.height_m + 1e-6)
    .map(([wall, op]) => ({
      code: 'WINDOW_ABOVE_CEILING',
      severity: 'error',
      affected_node_ids: [op.id, wall.id],
      message: `Window ${op.id} extends above wall ${wall.id} (top at ${(op.offset_from_floor_m + op.height_m).toFixed(2)} m vs wall height ${wall.height_m.toFixed(2)} m)`,
    }))
}

/**
 * H17 audit-fix: surface the bridge-emitted host-wall confidence as a
 * validator warning when it dropped below 1.0. The matcher (Day 8 B13) sets
 * `host_wall_confidence` to a fractional value when a second wall sat within
 * ambiguity_tolerance_m of the picked one. Render-time fall-back may produce
 * the wrong cutout in those cases; a warning lets the operator review.
 */
export function checkDoorHostWallAmbiguous(scene: RoomScene): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const wall of scene.walls) {
    for (const op of wall.openings) {
      const c = op.host_wall_confidence
      if (typeof c === 'number' && c < 1.0) {
        issues.push({
          code: 'DOOR_HOST_WALL_AMBIGUOUS',
          severity: 'warning',
          affected_node_ids: [op.id, wall.id],
          message: `Opening ${op.id} host-wall match confidence ${c.toFixed(2)} < 1.0 — bridge found a second wall within tolerance`,
        })
      }
    }
  }
  return issues
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + helpers
// ─────────────────────────────────────────────────────────────────────────────

export const OPENING_RULES = [
  checkDoorHostWallNotFound,
  checkDoorOutsideWallBounds,
  checkWindowOutsideWallBounds,
  checkWindowBelowFloor,
  checkWindowAboveCeiling,
  checkDoorHostWallAmbiguous,
] as const

function fitsAlongWall(op: WallOpening, wall: Wall): boolean {
  const wallLen = lengthCompute(wall)
  return (
    op.offset_along_wall_m >= -1e-6 &&
    op.offset_along_wall_m + op.width_m <= wallLen + 1e-6
  )
}

function collectOpenings(scene: RoomScene): Array<[Wall, WallOpening]> {
  const out: Array<[Wall, WallOpening]> = []
  for (const wall of scene.walls) {
    for (const op of wall.openings) out.push([wall, op])
  }
  return out
}
