/**
 * Spatial · Canonical · Geometry · Wall-Local Coordinates (V1.6.1 L0.1)
 *
 * Pure helper functions to convert between world-space points (e.g. from a
 * three.js raycast hit on a wall mesh) and wall-local `(offset_along_wall_m,
 * offset_from_floor_m)` coordinates — the canonical positional fields used
 * by `WallOpening` and `SpatialObject` (host='wall').
 *
 * Pure L1: no three.js / React / DOM. Only the canonical `Vector3` + `Wall`
 * types. Mid-2D-projection on the wall plane (Y-axis at floor level, X-axis
 * along start→end direction of the wall centerline).
 *
 * Use-case:
 *   handlePinPlaced(event) — event.point is a world-space hit on the wall.
 *   We want to drop a new opening or wall-mounted object at the tap-X
 *   instead of at the wall midpoint. R13 ignored event.point and always
 *   centered the new object — this helper closes that gap (Plan §L0.1).
 */

import type { Wall } from '../types/geometry'
import type { Vector3 } from '../types/primitives'

/**
 * Project a world-space point onto a wall's local 2D coordinate system.
 *
 * The wall is treated as a vertical rectangle:
 *   - X-axis = unit vector from `start_point` to `end_point` (along the wall)
 *   - Y-axis = world +Y (vertical)
 *
 * `offset_along_wall_m` is the projection onto the wall's X-axis, clamped
 * into `[0, wallLengthM]`. `offset_from_floor_m` is the world-Y of the hit
 * minus the wall's `base_height_m`, clamped into `[0, wallHeightM]`.
 *
 * The wall's thickness is irrelevant for this projection — the tap is
 * assumed to hit the wall's centerline plane (R3F raycast on the wall mesh
 * already returns a point on that plane).
 */
export function worldPointToWallLocalOffset(
  wall: Wall,
  worldPoint: Vector3,
  wallLengthM: number,
  wallHeightM: number,
): { offset_along_wall_m: number; offset_from_floor_m: number } {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  // Degenerate wall — caller should never pass a zero-length wall, but be
  // defensive (returning 0,0 keeps the caller-side default-center logic safe).
  if (len < 1e-6) {
    return { offset_along_wall_m: 0, offset_from_floor_m: 0 }
  }
  const ux = dx / len
  const uz = dz / len
  // Project (worldPoint - start_point) onto the wall direction.
  const projected =
    (worldPoint.x - wall.start_point.x) * ux +
    (worldPoint.z - wall.start_point.z) * uz
  const offsetAlong = clamp(projected, 0, wallLengthM)
  const offsetFromFloor = clamp(worldPoint.y - wall.base_height_m, 0, wallHeightM)
  return {
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: offsetFromFloor,
  }
}

/**
 * Cached `|end_point - start_point|` is the canonical wall length. This is
 * the same quantity `wall.length_m` would expose when the convenience cache
 * is up-to-date — recompute defensively so callers don't depend on cache
 * freshness.
 */
export function wallLengthMeters(wall: Wall): number {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  return Math.hypot(dx, dz)
}

/**
 * Clamp helper for caller convenience (e.g. snapping a new object's
 * `offset_along_wall_m` so it doesn't poke past the wall ends given the
 * object's width).
 *
 * Returns the input clamped into `[lo, hi]`. If `lo > hi` (e.g. very wide
 * object on a very short wall), returns the midpoint of the input range.
 */
export function clampOffsetForObject(
  desiredOffsetAlongWallM: number,
  objectWidthM: number,
  wallLengthM: number,
): number {
  // Object's left edge is `offset - widthM/2` (if pivot is center along wall)
  // OR `offset` (if pivot is left edge). For both WallOpening (Plan-spec
  // says offset is "from start, left-edge") and wall-mounted objects with
  // `offset_along_wall_m` (object center), we lean on the simpler "left-edge"
  // convention used by the existing R13 `buildDefaultOpening`: the value is
  // the position of the LEFT edge of the object along the wall axis.
  const min = 0
  const max = Math.max(0, wallLengthM - objectWidthM)
  if (max < min) return wallLengthM / 2 - objectWidthM / 2
  return clamp(desiredOffsetAlongWallM, min, max)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Hit-test a wall-local point against the wall's openings + wall-mounted
 * objects. Used to resolve "the user tapped a door / heating on this wall"
 * WITHOUT depending on per-opening pick proxies (openings render as a CSG hole
 * → no own pick target; the wall PickProxy covers the whole face incl. the
 * doorway, so we test the hit point's wall-local offset against each object's
 * rect). CSG- and decal-agnostic, no shared TappedSurfaceKind change.
 *
 * Openings are checked before wall-mounted objects (a door overlapping a socket
 * is the more likely intended target). Returns the first covering object.
 *
 * `offset_along_wall_m` convention is left-edge (matches `WallOpening` +
 * `buildDefaultWallMountedObject`). Pure L1 — vitest-fähig.
 */
export function findWallObjectAtOffset(
  wall: Wall,
  local: { offset_along_wall_m: number; offset_from_floor_m: number },
): { kind: 'opening' | 'wall_mounted'; id: string } | null {
  const along = local.offset_along_wall_m
  const up = local.offset_from_floor_m
  for (const op of wall.openings) {
    if (
      along >= op.offset_along_wall_m &&
      along <= op.offset_along_wall_m + op.width_m &&
      up >= op.offset_from_floor_m &&
      up <= op.offset_from_floor_m + op.height_m
    ) {
      return { kind: 'opening', id: op.id }
    }
  }
  for (const obj of wall.wall_mounted) {
    const left = obj.offset_along_wall_m ?? 0
    const bottom = obj.height_from_floor_m ?? 0
    if (
      along >= left &&
      along <= left + obj.dimensions.width_m &&
      up >= bottom &&
      up <= bottom + obj.dimensions.height_m
    ) {
      return { kind: 'wall_mounted', id: obj.id }
    }
  }
  return null
}
