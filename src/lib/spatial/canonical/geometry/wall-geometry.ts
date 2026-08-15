/**
 * Spatial · Canonical · Geometry · Walls
 *
 * Pure helpers that derive geometric quantities from a parametric `Wall`.
 *
 * Conventions (binding · Master-Spec §1.6, §2.4):
 *   - Walls live in a Right-Handed Y-Up world.
 *   - `start_point` and `end_point` are the world-space endpoints of the wall
 *     CENTERLINE on the floor plane (Y == base_height_m).
 *   - `thickness_m` is the FULL wall thickness; the wall extends half a
 *     thickness on each side of the centerline.
 *   - The outward-facing normal is the right-hand-perpendicular of the
 *     centerline direction projected onto the XZ plane — i.e. when walking
 *     from `start` to `end`, the outer face is on the right.
 *
 * All functions in this file are pure: no allocations beyond the returned
 * value, no side-effects, no dependency on three.js / DOM.
 */

import { EPSILON, type Vector3 } from '../types/primitives.ts'
import type { Wall } from '../types/geometry.ts'

/**
 * Subset of {@link Wall} that the wall-geometry helpers actually consume.
 * Exposed so callers can compute derived values from partial / synthetic
 * inputs (e.g. fixture builders in tests) without having to construct a
 * full canonical Wall.
 */
export interface WallGeometryInput {
  start_point: Vector3
  end_point: Vector3
  thickness_m: number
  height_m: number
  base_height_m: number
  /**
   * Optional iOS 17+ polygon-wall override (H11 audit-fix). When present, the
   * portal helpers (`portalPolygonCompute`, etc.) MUST refuse — V1 has no
   * generic polygon-cutout solver yet, so a wall with an irregular outline
   * cannot host doors/windows until V1.x ships the polygon-portal code.
   */
  polygon_override?: Vector3[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Length + normal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Euclidean length of the wall centerline in meters.
 *
 * Computed from `end_point - start_point` (XYZ); typically `start.y == end.y`,
 * but we tolerate vertical offsets so the helper survives misconfigured
 * input. The validator separately flags `WALL_ZERO_LENGTH` when the
 * length is below `EPSILON`.
 */
export function lengthCompute(wall: WallGeometryInput): number {
  return Math.hypot(
    wall.end_point.x - wall.start_point.x,
    wall.end_point.y - wall.start_point.y,
    wall.end_point.z - wall.start_point.z,
  )
}

/**
 * 2D outward-facing unit normal of the wall, projected onto the floor (XZ)
 * plane. The Y component is always 0 by construction (walls are vertical
 * in V1; sloped walls are V1.x).
 *
 * Right-hand rule for "outward":
 *   - dir = (end - start) projected onto XZ
 *   - normal = (dir.z, 0, -dir.x) normalised
 *
 * When walking along the centerline from start to end, the outward face is
 * on the right. For zero-length walls (start == end), returns `{0, 0, 0}`
 * as an explicit signal — the validator will surface this as
 * `WALL_ZERO_LENGTH` before any renderer is asked to consume the normal.
 */
export function normalCompute(wall: WallGeometryInput): Vector3 {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  if (len < EPSILON) return { x: 0, y: 0, z: 0 }
  return { x: dz / len, y: 0, z: -dx / len }
}

/**
 * 2D inward-facing unit normal — the negation of {@link normalCompute}.
 * Used by walkable-area subtraction to determine which side of the wall
 * the "inside" of the room is on (so the wall-footprint is offset
 * correctly when expanding around the centerline).
 */
export function innerNormalCompute(wall: WallGeometryInput): Vector3 {
  const n = normalCompute(wall)
  return { x: -n.x, y: -n.y, z: -n.z }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3D footprint of the wall as a planar quad in world-space, lying on the
 * floor plane (Y == base_height_m). Used as the input to walkable-area
 * computation (the polygon-clipping difference operator) and as the basis
 * for wall meshing in the renderer.
 *
 * Order of vertices (CCW when viewed from above):
 *
 *   outer_start ──→ outer_end
 *        ↑              │
 *        │              ↓
 *   inner_start ←─ inner_end
 *
 * where "outer" is along the outward normal and "inner" is along the inward
 * normal, each offset by `thickness_m / 2` from the centerline.
 *
 * For zero-length walls we return an empty array so downstream
 * polygon-clipping treats the wall as a no-op.
 */
export function polygonFromWallFootprint(wall: WallGeometryInput): Vector3[] {
  const len = lengthCompute(wall)
  if (len < EPSILON) return []

  const outer = normalCompute(wall)
  const half = wall.thickness_m / 2
  const y = wall.base_height_m

  return [
    { x: wall.start_point.x + outer.x * half, y, z: wall.start_point.z + outer.z * half },
    { x: wall.end_point.x + outer.x * half, y, z: wall.end_point.z + outer.z * half },
    { x: wall.end_point.x - outer.x * half, y, z: wall.end_point.z - outer.z * half },
    { x: wall.start_point.x - outer.x * half, y, z: wall.start_point.z - outer.z * half },
  ]
}

/**
 * Full 3D bounding box of the wall as 8 corner points (bottom 4 + top 4).
 * Used by the collision-volume builder and by validators that need to test
 * whether an opening intersects the wall mass.
 *
 * Vertex ordering matches `polygonFromWallFootprint` for the bottom face;
 * the top face mirrors the bottom at height `base_height_m + height_m`.
 */
export function polygonFromWall(wall: WallGeometryInput): Vector3[] {
  const bottom = polygonFromWallFootprint(wall)
  if (bottom.length === 0) return []
  const top = bottom.map(p => ({ x: p.x, y: p.y + wall.height_m, z: p.z }))
  return [...bottom, ...top]
}

/**
 * Midpoint of the wall centerline in world-space.
 *
 * Cheap helper used by door-host detection and by validator hints (e.g.
 * "wall is too far from any door candidate").
 */
export function centerlineMidpoint(wall: WallGeometryInput): Vector3 {
  return {
    x: (wall.start_point.x + wall.end_point.x) / 2,
    y: (wall.start_point.y + wall.end_point.y) / 2,
    z: (wall.start_point.z + wall.end_point.z) / 2,
  }
}

/**
 * Project an arbitrary world-space point onto the wall plane (the infinite
 * plane that contains the wall's centerline and is perpendicular to its
 * outward normal). Returns the projected point + the signed perpendicular
 * distance along the normal (positive on the outer side).
 *
 * Used by door-host detection (Day 3 A10): for each wall, project the
 * door's centroid onto the plane and pick the wall with the smallest
 * absolute perpendicular distance.
 */
export function projectPointOntoWallPlane(
  wall: WallGeometryInput,
  point: Vector3,
): { projected: Vector3; signedDistance: number } {
  const normal = normalCompute(wall)
  // For zero-length walls the normal is (0,0,0); fall back to zero distance.
  if (normal.x === 0 && normal.y === 0 && normal.z === 0) {
    return { projected: { ...point }, signedDistance: 0 }
  }
  // Vector from wall start to the query point.
  const dx = point.x - wall.start_point.x
  const dy = point.y - wall.start_point.y
  const dz = point.z - wall.start_point.z
  const signedDistance = dx * normal.x + dy * normal.y + dz * normal.z
  return {
    projected: {
      x: point.x - normal.x * signedDistance,
      y: point.y - normal.y * signedDistance,
      z: point.z - normal.z * signedDistance,
    },
    signedDistance,
  }
}

/**
 * Compute how far along the wall centerline a projected point sits. Returns
 * a value in [0, length_m] when the point lies within the wall segment;
 * outside that range when the projection falls past either endpoint.
 *
 * Used by door-host detection to verify the projected point sits within
 * the wall's length, not just on the infinite plane.
 */
export function offsetAlongWall(
  wall: WallGeometryInput,
  point: Vector3,
): number {
  const len = lengthCompute(wall)
  if (len < EPSILON) return 0
  const dirX = (wall.end_point.x - wall.start_point.x) / len
  const dirY = (wall.end_point.y - wall.start_point.y) / len
  const dirZ = (wall.end_point.z - wall.start_point.z) / len
  return (
    (point.x - wall.start_point.x) * dirX +
    (point.y - wall.start_point.y) * dirY +
    (point.z - wall.start_point.z) * dirZ
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute the cached `length_m` and `normal` fields on a Wall and return
 * a fresh object. Used by the bridge (Day 8 B13) after constructing walls
 * from RoomPlan output, and by the Phase-2 edit-system after any operation
 * that changes `start_point` / `end_point`.
 */
export function refreshWallCachedFields<T extends Wall>(wall: T): T {
  return {
    ...wall,
    length_m: lengthCompute(wall),
    normal: normalCompute(wall),
  }
}
