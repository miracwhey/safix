/**
 * Spatial · Canonical · Geometry · Footprint
 *
 * Footprint-first helpers: derive the closed floor ring + floor/ceiling
 * polygons + room metrics from a wall list. The wall list is the editable
 * structure for manual rooms (Lane-2.5 · Stream B); the floor + ceiling are
 * DERIVED here so they can never drift from the walls.
 *
 * `inferFloorPolygonFromWalls` is the canonical head-to-tail topology stitch.
 * It was previously private to the scan bridge (`scanToParametric.ts`); it
 * lives here now so the scan-ingest path AND the manual-edit path share ONE
 * implementation (geometry is the lowest layer — the bridge imports it).
 *
 * All pure: no three.js / DOM / store / Supabase dependencies.
 */

import type { Vector3 } from '../types/primitives.ts'
import type { Wall, Floor, Ceiling } from '../types/geometry.ts'
import type { RoomScene } from '../types/scene-graph.ts'

/** Endpoint-match epsilon for the floor-polygon topology stitch (F10). */
const WALL_STITCH_EPSILON_M = 0.05

/**
 * Infer the floor polygon from the wall endpoints (F10).
 *
 * Walls arrive in NO particular order — RoomPlan `scan_surfaces` rows are in
 * detection order, and the manual draw tool appends in tap order. Walking
 * `walls.map(w => w.start_point)` in declaration order therefore produces a
 * self-intersecting garbage polygon for any non-perimeter-ordered list (the
 * common case for L-/non-convex rooms).
 *
 * Strategy: a head-to-tail topology stitch. Starting from the first wall,
 * repeatedly find the next wall whose `start_point` OR `end_point` matches the
 * current open endpoint within {@link WALL_STITCH_EPSILON_M}, flipping it as
 * needed, until the ring closes back onto the starting vertex. When the walls
 * do NOT form a single closed loop the function returns an empty polygon (the
 * caller flags it via the validator's degenerate-floor codes / area fallback,
 * and the in-progress empty-canvas draw state is exactly this case).
 */
export function inferFloorPolygonFromWalls(walls: Wall[]): Vector3[] {
  if (walls.length === 0) return []

  const segments = walls.map(w => ({
    a: { x: w.start_point.x, z: w.start_point.z },
    b: { x: w.end_point.x, z: w.end_point.z },
  }))

  const close = (p: { x: number; z: number }, q: { x: number; z: number }): boolean =>
    Math.hypot(p.x - q.x, p.z - q.z) <= WALL_STITCH_EPSILON_M

  const used = new Array<boolean>(segments.length).fill(false)
  used[0] = true
  const startVertex = segments[0].a
  let cursor = segments[0].b
  const ring: Vector3[] = [{ x: startVertex.x, y: 0, z: startVertex.z }]

  for (let placed = 1; placed < segments.length; placed++) {
    ring.push({ x: cursor.x, y: 0, z: cursor.z })
    let nextIdx = -1
    let nextEndpoint: { x: number; z: number } | null = null
    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue
      if (close(segments[i].a, cursor)) {
        nextIdx = i
        nextEndpoint = segments[i].b
        break
      }
      if (close(segments[i].b, cursor)) {
        nextIdx = i
        nextEndpoint = segments[i].a
        break
      }
    }
    if (nextIdx < 0 || nextEndpoint === null) {
      // The walls do not chain into a single ring — reject (empty polygon).
      return []
    }
    used[nextIdx] = true
    cursor = nextEndpoint
  }

  // The final cursor must land back on the starting vertex for a closed loop.
  if (!close(cursor, startVertex)) return []

  // Ensure CCW (positive shoelace area). If negative, reverse.
  if (signedShoelaceArea(ring) < 0) ring.reverse()
  return ring
}

/** Signed shoelace area of a polygon on the XZ plane (positive = CCW). */
export function signedShoelaceArea(polygon: Vector3[]): number {
  if (polygon.length < 3) return 0
  let a = 0
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]
    const q = polygon[(i + 1) % polygon.length]
    a += p.x * q.z - q.x * p.z
  }
  return a / 2
}

/** Absolute floor area in m² of an XZ polygon. */
export function polygonAreaM2(polygon: Vector3[]): number {
  return Math.abs(signedShoelaceArea(polygon))
}

/**
 * Axis-aligned room bounds from the wall endpoints. Y spans the floor plane
 * (0) up to the ceiling height. For a wall-less scene (empty canvas) the
 * footprint collapses to the origin (matching the empty-canvas preset).
 */
export function computeWallBounds(
  walls: Wall[],
  ceilingHeightM: number,
): { min: Vector3; max: Vector3 } {
  if (walls.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: ceilingHeightM, z: 0 } }
  }
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.start_point.x, w.end_point.x)
    minZ = Math.min(minZ, w.start_point.z, w.end_point.z)
    maxX = Math.max(maxX, w.start_point.x, w.end_point.x)
    maxZ = Math.max(maxZ, w.start_point.z, w.end_point.z)
  }
  return { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: ceilingHeightM, z: maxZ } }
}

/**
 * Re-derive floor + ceiling polygons + room metrics from the current walls.
 *
 * Footprint-first invariant: the wall ring is the source of truth; floor +
 * ceiling are regenerated so they can NEVER drift from the walls. This is the
 * one place wall-mutating base-scene commands (AddWall / DeleteWall) + the
 * manual orchestrator funnel through, replacing the latent gap where adding a
 * wall left the floor polygon degenerate (the empty-canvas preset comment
 * claimed AddWall patched the polygon — it did not).
 *
 * Open / <3-wall rings yield an empty polygon (area 0) WITHOUT throwing — that
 * is the legitimate in-progress empty-canvas state. The ceiling polygon shares
 * the floor ring (XZ coords, y=0); the ceiling height lives in `ceiling.height_m`
 * (unchanged here). Wall `variant_id`s and every other field are untouched —
 * this is a base-scene mutation, persisted via blob re-upload, never an override.
 */
export function rebuildFloorCeilingFromWalls(scene: RoomScene): RoomScene {
  const ring = inferFloorPolygonFromWalls(scene.walls)
  const ceilingHeightM = scene.ceiling.height_m
  const areaM2 = polygonAreaM2(ring)
  const bounds = computeWallBounds(scene.walls, ceilingHeightM)
  const floor: Floor = { ...scene.floor, polygon: ring }
  const ceiling: Ceiling = { ...scene.ceiling, polygon: ring }
  return {
    ...scene,
    floor,
    ceiling,
    bounds_min: bounds.min,
    bounds_max: bounds.max,
    computed_area_m2: areaM2,
    computed_volume_m3: areaM2 * ceilingHeightM,
  }
}
