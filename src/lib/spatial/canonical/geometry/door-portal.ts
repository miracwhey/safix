/**
 * Spatial · Canonical · Geometry · Door Portals & Host-Wall Matching
 *
 * Two responsibilities:
 *
 *   1. Build the walkable rectangle ("portal polygon") of a door — used by
 *      walkable-area computation to punch a hole in the wall footprint, and
 *      by walk-mode camera traversal to detect room-to-room crossings.
 *
 *   2. Match a free-floating door candidate (e.g. as emitted by RoomPlan)
 *      to the wall it lives on. RoomPlan does NOT supply `host_wall_id`,
 *      so the bridge has to derive it. Risk R11: when two walls are equally
 *      close, the matcher must surface ambiguity rather than silently
 *      picking one.
 *
 * Both responsibilities are pure-function (no allocations beyond return,
 * no side-effects, no three.js dependency).
 */

import { CanonicalError } from '../types/errors.ts'
import type { Vector3 } from '../types/primitives.ts'
import {
  centerlineMidpoint,
  innerNormalCompute,
  lengthCompute,
  normalCompute,
  offsetAlongWall,
  projectPointOntoWallPlane,
  type WallGeometryInput,
} from './wall-geometry.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Portal polygon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parametric door / opening data sufficient to compute its portal polygon.
 * Defined locally so this module stays decoupled from the full WallOpening
 * type (which carries fields like `swing_direction` we don't need here).
 */
export interface PortalInput {
  /** Distance along the host-wall centerline from `start_point` to the door's left edge. */
  offset_along_wall_m: number
  /** Distance from the floor plane to the door's bottom edge. */
  offset_from_floor_m: number
  width_m: number
  height_m: number
}

/**
 * Build the 4-vertex rectangle of a door / opening in world-space, lying
 * on the host-wall plane.
 *
 * Vertex ordering (CCW when viewed from the outside of the room):
 *
 *   top_left  ───→  top_right
 *      ↑                 │
 *      │                 ↓
 *   bot_left  ←───  bot_right
 *
 * Returns an empty array if the host wall is degenerate (zero length).
 */
export function portalPolygonCompute(
  hostWall: WallGeometryInput,
  portal: PortalInput,
): Vector3[] {
  // H11 audit-fix · R15: irregular polygon walls (iOS 17+ polygon_override)
  // cannot host doors/windows in V1 — the rectangle math below assumes a
  // straight centerline. Fail loud so the bridge / validator can react.
  if (hostWall.polygon_override !== undefined) {
    throw new CanonicalError(
      'R15_NOT_YET_IMPLEMENTED',
      'portalPolygonCompute: polygon_override walls are V1.x — no portal solver yet',
    )
  }
  const len = lengthCompute(hostWall)
  if (len === 0) return []

  // Direction along the wall (unit vector on XZ plane).
  const dx = (hostWall.end_point.x - hostWall.start_point.x) / len
  const dz = (hostWall.end_point.z - hostWall.start_point.z) / len

  const yBase = hostWall.base_height_m + portal.offset_from_floor_m
  const yTop = yBase + portal.height_m

  const leftX = hostWall.start_point.x + dx * portal.offset_along_wall_m
  const leftZ = hostWall.start_point.z + dz * portal.offset_along_wall_m
  const rightX = leftX + dx * portal.width_m
  const rightZ = leftZ + dz * portal.width_m

  return [
    { x: leftX, y: yBase, z: leftZ },
    { x: rightX, y: yBase, z: rightZ },
    { x: rightX, y: yTop, z: rightZ },
    { x: leftX, y: yTop, z: leftZ },
  ]
}

/**
 * 2D walkable cross-section of a door projected onto the floor plane. Used
 * by `geometry/walkable.ts` to UNION back into the walkable polygon (after
 * walls were subtracted), and by walk-mode portal-traversal detection.
 *
 * The rectangle has the door's full width and the wall's full thickness
 * (so the camera-capsule passes through cleanly without clipping into the
 * surrounding wall mass).
 */
export function portalFloorFootprint(
  hostWall: WallGeometryInput,
  portal: PortalInput,
): Vector3[] {
  const len = lengthCompute(hostWall)
  if (len === 0) return []

  const dx = (hostWall.end_point.x - hostWall.start_point.x) / len
  const dz = (hostWall.end_point.z - hostWall.start_point.z) / len
  const outer = normalCompute(hostWall)
  const half = hostWall.thickness_m / 2
  const y = hostWall.base_height_m

  const leftX = hostWall.start_point.x + dx * portal.offset_along_wall_m
  const leftZ = hostWall.start_point.z + dz * portal.offset_along_wall_m
  const rightX = leftX + dx * portal.width_m
  const rightZ = leftZ + dz * portal.width_m

  return [
    { x: leftX + outer.x * half, y, z: leftZ + outer.z * half },
    { x: rightX + outer.x * half, y, z: rightZ + outer.z * half },
    { x: rightX - outer.x * half, y, z: rightZ - outer.z * half },
    { x: leftX - outer.x * half, y, z: leftZ - outer.z * half },
  ]
}

/**
 * Inward-facing portal normal (from "outside of room" to "inside of room").
 * Used by walk-mode portal-traversal to decide on which side of the door
 * the camera currently is — once it flips sign, the camera has crossed the
 * threshold and the active `room_id` must switch.
 */
export function portalInwardNormal(hostWall: WallGeometryInput): Vector3 {
  return innerNormalCompute(hostWall)
}

// ─────────────────────────────────────────────────────────────────────────────
// Host-wall matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A wall candidate paired with its identifier. Lookups stay generic so the
 * matcher works against both full `Wall` nodes and lighter synthetic
 * structures used in tests.
 */
export interface HostWallCandidate {
  id: string
  geometry: WallGeometryInput
}

/**
 * Outcome of {@link findHostWall}: the picked wall, the matcher's
 * confidence in the match, and any human-readable warnings.
 *
 * Confidence semantics:
 *   - 1.0 : unique winner, perpendicular distance well below threshold
 *   - 0.5 : a second candidate sits within `ambiguity_tolerance_m` of the
 *           winner (Risk R11); caller should surface this to the user via
 *           `DOOR_HOST_WALL_AMBIGUOUS`
 *   - 0.0 : no candidate within `max_distance_m`; caller should surface as
 *           `DOOR_HOST_WALL_NOT_FOUND`
 *
 * `winner` is null only in the no-candidate-found case.
 */
export interface HostWallMatchResult {
  winner: HostWallCandidate | null
  confidence: 0 | 0.5 | 1
  warnings: string[]
  /** Sorted by ascending perpendicular distance — useful for debug output. */
  candidates: Array<{ candidate: HostWallCandidate; perpDistance: number; alongDistance: number }>
}

/**
 * Configurable thresholds for the host-wall matcher. Defaults tuned for
 * RoomPlan output where wall-thickness defaults to 0.15 m and the door
 * centroid is typically reported on the wall's centerline.
 */
export interface HostWallMatchOptions {
  /** Doors farther than this from any wall are rejected (default 0.5 m). */
  max_distance_m?: number
  /**
   * Two candidates whose perpendicular distances differ by less than this
   * are flagged as ambiguous (default 0.05 m · 5 cm).
   */
  ambiguity_tolerance_m?: number
  /**
   * If the projected point falls beyond the wall's end by more than this
   * tolerance, the candidate is rejected (default 0.10 m to allow for the
   * door's half-width).
   */
  along_tolerance_m?: number
}

/**
 * Match a free-floating door candidate to the wall it lives on.
 *
 * Algorithm:
 *   1. For every wall, project the door centroid onto the wall plane and
 *      record (perpendicular distance, along-wall distance).
 *   2. Sort candidates by ascending perpendicular distance.
 *   3. The winner is the closest wall whose along-wall distance lies within
 *      [-along_tolerance_m, length_m + along_tolerance_m] AND whose
 *      perpendicular distance is below `max_distance_m`.
 *   4. If a second candidate's perpendicular distance is within
 *      `ambiguity_tolerance_m`, set confidence = 0.5 and emit a warning
 *      (Risk R11).
 *
 * Note: This matcher operates on the door's WORLD-SPACE centroid (e.g.
 * the position embedded in RoomPlan's `simd_float4x4` transform). The
 * Swift converter (Day 9 B15) performs the same algorithm natively for
 * iOS-side conversion.
 */
export function findHostWall(
  doorCentroid: Vector3,
  walls: HostWallCandidate[],
  options: HostWallMatchOptions = {},
): HostWallMatchResult {
  const maxDistance = options.max_distance_m ?? 0.5
  const ambiguityTolerance = options.ambiguity_tolerance_m ?? 0.05
  const alongTolerance = options.along_tolerance_m ?? 0.1

  const scored = walls
    .map(c => {
      const { signedDistance } = projectPointOntoWallPlane(c.geometry, doorCentroid)
      const alongDistance = offsetAlongWall(c.geometry, doorCentroid)
      return {
        candidate: c,
        perpDistance: Math.abs(signedDistance),
        alongDistance,
      }
    })
    .sort((a, b) => a.perpDistance - b.perpDistance)

  // Filter by along-wall span: the door has to project onto the wall segment,
  // not just onto its infinite plane.
  const eligible = scored.filter(entry => {
    const len = lengthCompute(entry.candidate.geometry)
    return entry.alongDistance >= -alongTolerance && entry.alongDistance <= len + alongTolerance
  })

  if (eligible.length === 0 || eligible[0].perpDistance > maxDistance) {
    return {
      winner: null,
      confidence: 0,
      warnings: ['DOOR_HOST_WALL_NOT_FOUND: no wall within tolerance'],
      candidates: scored,
    }
  }

  const winner = eligible[0]
  const warnings: string[] = []
  let confidence: 0 | 0.5 | 1 = 1

  // Ambiguity check against the next candidate (R11).
  if (
    eligible.length > 1 &&
    eligible[1].perpDistance - winner.perpDistance <= ambiguityTolerance
  ) {
    confidence = 0.5
    warnings.push(
      `DOOR_HOST_WALL_AMBIGUOUS: walls ${winner.candidate.id} and ${eligible[1].candidate.id} are within ${ambiguityTolerance.toFixed(3)} m of the door centroid`,
    )
  }

  return { winner: winner.candidate, confidence, warnings, candidates: scored }
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlapping-wall detection (used by Wall-Doubling collapse · R12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of the wall-overlap detector — used by the bridge (Day 8 B13) and
 * by the Swift converter (Day 9 B15) to decide which wall pairs should be
 * merged into a single thicker wall (Risk R12 mitigation).
 */
export interface OverlapPair {
  a: HostWallCandidate
  b: HostWallCandidate
  /** Perpendicular distance between centerlines (XZ projection). */
  perpDistance_m: number
  /** Length-overlap ratio in [0, 1] — fraction of `a` covered by `b`'s projection. */
  lengthOverlapRatio: number
  /** Angle between outward normals in radians (close to π means anti-parallel). */
  normalAngle_rad: number
}

/**
 * Detect pairs of walls that look like a single thicker wall that RoomPlan
 * split into two parallel thin walls.
 *
 * Heuristic (per Master-Spec §14.3 wall-doubling note):
 *   - centerlines are parallel within `angle_tolerance_rad` (default 5°)
 *   - perpendicular distance is below `max_perp_distance_m` (default 0.30 m)
 *   - length-overlap ratio is above `min_overlap_ratio` (default 0.80)
 *
 * Returns each candidate pair once (a.id < b.id). Caller decides whether
 * to actually collapse — typically: yes for default-thickness walls, no
 * for explicitly-set non-default thickness.
 */
export interface OverlapOptions {
  angle_tolerance_rad?: number
  max_perp_distance_m?: number
  min_overlap_ratio?: number
}

export function findOverlappingWalls(
  walls: HostWallCandidate[],
  options: OverlapOptions = {},
): OverlapPair[] {
  const angleTolerance = options.angle_tolerance_rad ?? (Math.PI / 36) // 5°
  const maxPerpDistance = options.max_perp_distance_m ?? 0.3
  const minOverlapRatio = options.min_overlap_ratio ?? 0.8

  const pairs: OverlapPair[] = []
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i]
      const b = walls[j]

      const nA = normalCompute(a.geometry)
      const nB = normalCompute(b.geometry)

      // Doubled walls may have either ANTI-PARALLEL normals (outward of one
      // is inward of the other · typical RoomPlan output) or PARALLEL normals
      // (when the bridge has not yet flipped a captured surface's normal
      // direction · H10 audit-fix).
      const dot = nA.x * nB.x + nA.z * nB.z
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      const isAntiParallel = Math.abs(angle - Math.PI) < angleTolerance
      const isParallel = Math.abs(angle) < angleTolerance
      if (!isAntiParallel && !isParallel) continue

      // Perpendicular distance: distance from B's start to A's plane.
      const { signedDistance } = projectPointOntoWallPlane(a.geometry, b.geometry.start_point)
      const perp = Math.abs(signedDistance)
      if (perp > maxPerpDistance) continue

      // Length-overlap ratio: project B's endpoints onto A's centerline and
      // compute the overlap with [0, length_a].
      const lenA = lengthCompute(a.geometry)
      if (lenA === 0) continue
      const t0 = offsetAlongWall(a.geometry, b.geometry.start_point)
      const t1 = offsetAlongWall(a.geometry, b.geometry.end_point)
      const lo = Math.max(0, Math.min(t0, t1))
      const hi = Math.min(lenA, Math.max(t0, t1))
      const overlap = Math.max(0, hi - lo)
      const overlapRatio = overlap / lenA
      if (overlapRatio < minOverlapRatio) continue

      pairs.push({
        a,
        b,
        perpDistance_m: perp,
        lengthOverlapRatio: overlapRatio,
        normalAngle_rad: angle,
      })
    }
  }
  return pairs
}

// Re-export centerlineMidpoint so callers that primarily use door-portal
// helpers don't need to reach into wall-geometry separately.
export { centerlineMidpoint }
