/**
 * Spatial · Canonical · Geometry · Walkable Area
 *
 * Compute the polygon of floor-plane points a camera-capsule can stand on
 * without intersecting a wall, a floor-mounted obstacle, or a column.
 *
 *   walkable = floor.polygon
 *            − wall.thickness_footprints
 *            − floor_mounted_object.footprints (with clearance buffer)
 *            + door.opening_cutouts
 *
 * Implemented via `polygon-clipping` (mfogel, MIT) — the most robust pure-JS
 * Martinez-Rueda-Feito boolean implementation as of 2026. polygon-clipping
 * operates on 2D coordinate pairs `[x, z]`; this module converts between
 * the 2D form and the canonical `Vector3` form at the boundary so the rest
 * of the L1 layer stays in 3D.
 *
 * Risk R13 mitigation: columns are modelled as floor-mounted SpatialObjects
 * (`category === 'column'`), NOT as walls; their footprints are subtracted
 * through the same object-subtraction pass.
 */

// polygon-clipping@0.15 ships an ESM bundle that only exports `default`; its
// .d.ts wrongly declares named exports. Import the default object (works for
// both the strict Rollup build and esbuild) and pull types separately.
import polygonClipping from 'polygon-clipping'
import type { Geom, MultiPolygon, Ring } from 'polygon-clipping'

import { EPSILON, type Vector3 } from '../types/primitives.ts'
import type { Wall, Floor } from '../types/geometry.ts'
import type { WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type {
  ObstacleFootprint,
  WalkableArea,
  WalkablePolygon,
} from '../types/walkable.ts'
import { polygonFromWallFootprint, type WallGeometryInput } from './wall-geometry.ts'
import { portalFloorFootprint } from './door-portal.ts'

/**
 * Default clearance buffer around floor-mounted objects, in meters. Tuned
 * for typical sanitary fixtures (WC, sink) — leaves enough room for the
 * camera-capsule to circulate without immediate collision-resolve.
 */
export const DEFAULT_OBJECT_CLEARANCE_M = 0.2

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input shape accepted by {@link computeWalkableArea}. The function does not
 * touch any other fields of the host nodes, which keeps tests easy: callers
 * pass synthetic minimal structures rather than full canonical scene-graphs.
 */
export interface WalkableComputeInput {
  room_id: string
  floor: Pick<Floor, 'polygon' | 'transform'>
  walls: ReadonlyArray<Wall>
  objects: ReadonlyArray<SpatialObject>
  /** Door / opening list flattened across all walls (consumers usually flatten in the bridge). */
  openings?: ReadonlyArray<{ host_wall: Wall; opening: WallOpening }>
  /** Override per-object clearance (default {@link DEFAULT_OBJECT_CLEARANCE_M}). */
  clearance_buffer_m?: number
}

/**
 * Compute the walkable polygon for a room.
 *
 * Returns a {@link WalkableArea} record:
 *   - `polygon.outer` (CCW) is the largest outer ring after boolean ops.
 *   - `polygon.holes` (each CW) describe interior obstacles (columns).
 *   - `obstacles` lists every subtracted footprint for debug rendering.
 *
 * If the input room is degenerate (no floor polygon, or zero-area floor),
 * the result has empty `outer` + `holes` so downstream renderers can render-
 * graceful (Decision #5) — the validator flags `ROOM_NO_FLOOR` separately.
 *
 * The function never throws on numerically-tricky inputs; polygon-clipping
 * is mature enough that we treat its output as authoritative.
 */
export function computeWalkableArea(input: WalkableComputeInput): WalkableArea {
  const obstacles: ObstacleFootprint[] = []
  const clearance = input.clearance_buffer_m ?? DEFAULT_OBJECT_CLEARANCE_M

  const computedAt = new Date().toISOString()
  const baseY = floorBaseY(input)

  // Start with the floor polygon. If the floor is missing or has <3 vertices
  // we cannot do anything meaningful — return an empty walkable area.
  const floorRing = floorPolygonAs2D(input.floor.polygon)
  if (floorRing === null) {
    return {
      room_id: input.room_id,
      polygon: { outer: [], holes: [] },
      computed_at: computedAt,
      obstacles,
    }
  }

  let walkable: MultiPolygon = ensureMultiPolygon([floorRing])

  // 1. Subtract every wall's footprint.
  for (const wall of input.walls) {
    const footprint = polygonFromWallFootprint(wall)
    if (footprint.length < 3) continue
    const ring = pointsTo2DRing(footprint)
    walkable = subtract(walkable, ring)
    obstacles.push({
      source_id: wall.id,
      source_type: 'wall',
      polygon: ringTo3D(ring, baseY),
      clearance_buffer_m: 0,
    })
  }

  // 2. Add back the floor-plane footprint of each door / opening that is
  //    flagged as a walkable portal. This re-opens the wall mass we just
  //    subtracted.
  if (input.openings) {
    for (const { host_wall, opening } of input.openings) {
      if (!opening.is_walkable_portal) continue
      const portal = portalFloorFootprint(host_wall, opening)
      if (portal.length < 3) continue
      const ring = pointsTo2DRing(portal)
      walkable = union(walkable, ring)
    }
  }

  // 3. Subtract every floor-mounted object footprint (with clearance buffer).
  //    Object footprints are axis-aligned in their LOCAL frame; this is a V1
  //    simplification: we treat each object as an axis-aligned bounding-box
  //    on the floor plane, expanded by the clearance buffer. A V1.x version
  //    will rotate the AABB by `rotation_around_y_deg`.
  for (const obj of input.objects) {
    if (obj.host !== 'floor' && obj.host !== 'free') continue
    const ring = objectFootprintRing(obj, clearance)
    if (ring === null) continue
    walkable = subtract(walkable, ring)
    obstacles.push({
      source_id: obj.id,
      source_type: 'object',
      polygon: ringTo3D(ring, baseY),
      clearance_buffer_m: clearance,
    })
  }

  // 4. Pick the largest outer polygon (V1 = one room per walkable area).
  const winner = pickLargestPolygon(walkable)
  if (winner === null) {
    return {
      room_id: input.room_id,
      polygon: { outer: [], holes: [] },
      computed_at: computedAt,
      obstacles,
    }
  }

  const [outerRing, ...holeRings] = winner
  return {
    room_id: input.room_id,
    polygon: {
      outer: ringTo3D(outerRing, baseY),
      holes: holeRings.map(r => ringTo3D(r, baseY)),
    },
    computed_at: computedAt,
    obstacles,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: wall + object footprints (re-exported for direct callers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AABB footprint of a floor-mounted object on the floor plane, expanded by
 * the clearance buffer. Returns null when the object has zero or negative
 * dimensions in any axis.
 *
 * The implementation projects an axis-aligned bounding box in WORLD space:
 *   - center = transform.position
 *   - half-extents = dimensions / 2 plus clearance buffer
 *
 * Rotation around Y is not yet applied in V1 (the bridge stores the
 * canonical AABB axis-aligned in world space because RoomPlan already
 * supplies axis-aligned object bounds). V1.x will lift this restriction.
 */
function objectFootprintRing(obj: SpatialObject, buffer: number): Ring | null {
  const { width_m, depth_m } = obj.dimensions
  if (width_m <= 0 || depth_m <= 0) return null
  const halfW = width_m / 2 + buffer
  const halfD = depth_m / 2 + buffer
  const cx = obj.transform.position.x
  const cz = obj.transform.position.z

  // CCW outer ring: bottom-left → bottom-right → top-right → top-left
  return [
    [cx - halfW, cz - halfD],
    [cx + halfW, cz - halfD],
    [cx + halfW, cz + halfD],
    [cx - halfW, cz + halfD],
  ]
}

/**
 * Direct exposure of the per-wall thickness footprint. Mirrors
 * {@link polygonFromWallFootprint} but available from this module for
 * callers (e.g. tests, debug overlays) that don't want to chase the
 * wall-geometry import.
 */
export function wallFootprint(wall: WallGeometryInput): Vector3[] {
  return polygonFromWallFootprint(wall)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: polygon-clipping bridges
// ─────────────────────────────────────────────────────────────────────────────

function pointsTo2DRing(points: Vector3[]): Ring {
  return points.map(p => [p.x, p.z] as [number, number])
}

function ringTo3D(ring: Ring, y: number): Vector3[] {
  return ring.map(([x, z]) => ({ x, y, z }))
}

function ensureMultiPolygon(polygon: Geom): MultiPolygon {
  // polygon-clipping accepts both `Polygon` (Ring[]) and `MultiPolygon`
  // (Polygon[]) at boolean-op boundaries; normalise to MultiPolygon here so
  // downstream code uses a single shape.
  if (polygon.length === 0) return []
  const first = polygon[0]
  if (Array.isArray(first) && Array.isArray(first[0]) && typeof first[0][0] === 'number') {
    // Geom was a Ring[] (single polygon)
    return [polygon as unknown as Ring[]]
  }
  return polygon as MultiPolygon
}

function isRing(value: Ring | Geom): value is Ring {
  // A Ring is `Array<[number, number]>` — first element is a 2-tuple of numbers.
  if (value.length === 0) return false
  const first = value[0] as unknown
  if (!Array.isArray(first) || first.length === 0) return false
  return typeof (first as unknown[])[0] === 'number'
}

function union(a: MultiPolygon, b: Ring | Geom): MultiPolygon {
  return polygonClipping.union(a, ensureMultiPolygon(isRing(b) ? [b] : b))
}

function subtract(a: MultiPolygon, b: Ring | Geom): MultiPolygon {
  return polygonClipping.difference(a, ensureMultiPolygon(isRing(b) ? [b] : b))
}

function floorPolygonAs2D(polygon: Vector3[]): Ring | null {
  if (polygon.length < 3) return null
  // Drop the closing duplicate vertex if present.
  const cleaned = polygon[polygon.length - 1].x === polygon[0].x &&
    polygon[polygon.length - 1].z === polygon[0].z
    ? polygon.slice(0, -1)
    : polygon
  if (cleaned.length < 3) return null

  const ring: Ring = cleaned.map(p => [p.x, p.z])
  // Reject zero-area floors (validator surfaces ROOM_BOUNDS_TOO_SMALL).
  if (Math.abs(signedArea2D(ring)) < EPSILON) return null
  return ring
}

function floorBaseY(input: WalkableComputeInput): number {
  if (input.floor.polygon.length > 0) return input.floor.polygon[0].y
  return input.floor.transform.position.y ?? 0
}

function signedArea2D(ring: Ring): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    area += x0 * y1 - x1 * y0
  }
  return area / 2
}

/**
 * Among the multi-polygon result of polygon-clipping, pick the polygon
 * with the largest signed area of its outer ring. Returns null when the
 * result is empty.
 *
 * V1 convention: the largest outer ring is the room's main walkable
 * surface; any other disjoint pieces (e.g. an outdoor balcony picked up
 * via a door-cutout that crossed the exterior wall) are discarded so the
 * walk-mode camera never spawns outside the room.
 */
function pickLargestPolygon(multi: MultiPolygon): Ring[] | null {
  if (multi.length === 0) return null
  let bestIndex = 0
  let bestArea = Math.abs(signedArea2D(multi[0][0]))
  for (let i = 1; i < multi.length; i++) {
    const area = Math.abs(signedArea2D(multi[i][0]))
    if (area > bestArea) {
      bestArea = area
      bestIndex = i
    }
  }
  return multi[bestIndex]
}

// ─────────────────────────────────────────────────────────────────────────────
// Public diagnostics (used by tests + future debug overlay)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Area of a {@link WalkablePolygon} (outer minus holes), in m². Useful as a
 * quick sanity-check in tests + validator hints.
 */
export function walkablePolygonAreaM2(polygon: WalkablePolygon): number {
  if (polygon.outer.length < 3) return 0
  const outerArea = Math.abs(signedArea2D(pointsTo2DRing(polygon.outer)))
  const holeArea = polygon.holes.reduce(
    (acc, h) => acc + (h.length < 3 ? 0 : Math.abs(signedArea2D(pointsTo2DRing(h)))),
    0,
  )
  return Math.max(0, outerArea - holeArea)
}
