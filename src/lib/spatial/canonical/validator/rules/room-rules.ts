/**
 * Spatial · Canonical · Validator · Room Rules
 *
 * Top-level room consistency checks:
 *   - floor / walls / ceiling existence
 *   - floor polygon validity (closed, non-self-intersecting, ≥3 vertices)
 *   - bounding-box area (rooms below 1 m² are flagged)
 *   - hints when the room has no doors / no windows / no ceiling
 *
 * The wall / opening / object / pin rules already cover per-node concerns;
 * this file focuses on whole-room invariants.
 */

import type { RoomScene } from '../../types/scene-graph.ts'
import type { ValidationIssue } from '../../types/validation.ts'

/** Rooms with floor area below this are flagged as ROOM_BOUNDS_TOO_SMALL. */
export const ROOM_MIN_AREA_M2 = 1.0

export function checkRoomNoFloor(scene: RoomScene): ValidationIssue[] {
  if (!scene.floor || scene.floor.polygon.length < 3) {
    return [
      {
        code: 'ROOM_NO_FLOOR',
        severity: 'error',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has no usable floor polygon`,
      },
    ]
  }
  return []
}

export function checkRoomNoWalls(scene: RoomScene): ValidationIssue[] {
  if (scene.walls.length < 3) {
    return [
      {
        code: 'ROOM_NO_WALLS',
        severity: 'error',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has fewer than three walls`,
      },
    ]
  }
  return []
}

export function checkRoomBoundsTooSmall(scene: RoomScene): ValidationIssue[] {
  if (scene.computed_area_m2 > 0 && scene.computed_area_m2 < ROOM_MIN_AREA_M2) {
    return [
      {
        code: 'ROOM_BOUNDS_TOO_SMALL',
        severity: 'warning',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has only ${scene.computed_area_m2.toFixed(2)} m² of floor area`,
      },
    ]
  }
  return []
}

export function checkRoomHasNoDoors(scene: RoomScene): ValidationIssue[] {
  const hasDoor = scene.walls.some(w => w.openings.some(o => o.type === 'door' || o.type === 'opening'))
  if (!hasDoor && scene.walls.length >= 3) {
    return [
      {
        code: 'ROOM_HAS_NO_DOORS',
        severity: 'warning',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has no doors / unframed openings`,
        suggested_fix: 'Confirm the scan captured the doorway(s) — RoomPlan can miss flush-mounted doors.',
      },
    ]
  }
  return []
}

export function checkRoomNoCeiling(scene: RoomScene): ValidationIssue[] {
  if (!scene.ceiling || scene.ceiling.polygon.length < 3) {
    return [
      {
        code: 'ROOM_NO_CEILING',
        severity: 'hint',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has no ceiling — Dollhouse mode will not be able to hide one`,
      },
    ]
  }
  return []
}

export function checkRoomNoWindows(scene: RoomScene): ValidationIssue[] {
  const hasWindow = scene.walls.some(w => w.openings.some(o => o.type === 'window'))
  if (!hasWindow) {
    return [
      {
        code: 'ROOM_NO_WINDOWS',
        severity: 'hint',
        affected_node_ids: [scene.id],
        message: `Room ${scene.id} has no windows`,
      },
    ]
  }
  return []
}

export function checkFloorSelfIntersecting(scene: RoomScene): ValidationIssue[] {
  if (!scene.floor || scene.floor.polygon.length < 4) return []
  if (polygonHasSelfIntersection(scene.floor.polygon.map(p => [p.x, p.z] as [number, number]))) {
    return [
      {
        code: 'FLOOR_SELF_INTERSECTING',
        severity: 'error',
        affected_node_ids: [scene.floor.id],
        message: `Floor polygon of room ${scene.id} self-intersects`,
      },
    ]
  }
  return []
}

export function checkFloorPolygonNotClosed(scene: RoomScene): ValidationIssue[] {
  // The canonical representation does NOT carry a trailing duplicate vertex;
  // a polygon is "closed" by convention if it has ≥3 distinct vertices.
  // This rule catches polygons with degenerate consecutive duplicates.
  if (!scene.floor) return []
  const pts = scene.floor.polygon
  const distinct = pts.filter((p, i) => {
    if (i === 0) return true
    const prev = pts[i - 1]
    return Math.abs(p.x - prev.x) > 1e-6 || Math.abs(p.z - prev.z) > 1e-6
  })
  if (distinct.length < 3) {
    return [
      {
        code: 'FLOOR_POLYGON_NOT_CLOSED',
        severity: 'error',
        affected_node_ids: [scene.floor.id],
        message: `Floor polygon of room ${scene.id} has fewer than three distinct vertices`,
      },
    ]
  }
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + helpers
// ─────────────────────────────────────────────────────────────────────────────

export const ROOM_RULES = [
  checkRoomNoFloor,
  checkRoomNoWalls,
  checkRoomBoundsTooSmall,
  checkRoomHasNoDoors,
  checkRoomNoCeiling,
  checkRoomNoWindows,
  checkFloorSelfIntersecting,
  checkFloorPolygonNotClosed,
] as const

/**
 * Bentley–Ottmann simplified: O(n²) all-pairs segment intersection check.
 * Sufficient for V1 rooms (≤ 32 floor vertices); switch to a sweep algorithm
 * if rooms ever ship with hundreds of polygon vertices.
 */
function polygonHasSelfIntersection(ring: Array<[number, number]>): boolean {
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]
    const a2 = ring[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // adjacent edges share a vertex
      const b1 = ring[j]
      const b2 = ring[(j + 1) % n]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return false
}

function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d1 = direction(p3, p4, p1)
  const d2 = direction(p3, p4, p2)
  const d3 = direction(p1, p2, p3)
  const d4 = direction(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function direction(a: [number, number], b: [number, number], c: [number, number]): number {
  return (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1])
}
