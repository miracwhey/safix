/**
 * Spatial · Canonical · Validator · Object-Position (V1.6.1 L0.6)
 *
 * Hard-bounds + AABB-overlap validator for a candidate WallOpening or
 * wall-mounted SpatialObject on a given wall. Called by Customer-Hub's
 * `handlePinPlaced` BEFORE committing the mutator (Plan §L0.6) and by the
 * EditSheet during slider-drag re-validation.
 *
 * Hard-checks (Phase L0 — block, no soft-warn):
 *   - out-of-wall:       offset_along_wall < 0 OR offset_along_wall + width > wallLength
 *   - ceiling-breach:    offset_from_floor + height > wallHeight
 *   - floor-breach:      offset_from_floor < 0
 *   - aabb-overlap:      candidate's 2D AABB on the wall plane intersects an
 *                        existing opening or wall_mounted-object's AABB
 *
 * Soft-checks (Phase L1 DIN-plausibility — separate validator):
 *   - corner-distance, brüstung, schalter-band-vs-griff, schutzbereich, etc.
 *
 * Pure L1: no three.js / React / DOM. Consumes only canonical types so it
 * is vitest-fähig and can be reused by Provider workflows later.
 */

import type { Wall, WallOpening, Floor } from '../types/geometry'
import type { SpatialObject } from '../types/objects'
import type { Vector3 } from '../types/primitives'

/**
 * Single 2D axis-aligned bounding-box on the wall-plane. Coordinates are
 * wall-local: x along the wall, y up from the wall base.
 */
export interface WallPlaneAABB {
  left: number
  right: number
  bottom: number
  top: number
}

export type ValidationReason =
  | 'out_of_wall'
  | 'ceiling_breach'
  | 'floor_breach'
  | 'aabb_overlap'
  | 'out_of_floor'
  | 'too_tall'

export interface ObjectPositionValidationOk {
  ok: true
}

export interface ObjectPositionValidationFail {
  ok: false
  reason: ValidationReason
  /** Human-readable hint for the toast / EditSheet conflict-banner. */
  message: string
  /** Optional: id of the existing object the candidate overlaps with (for aabb_overlap). */
  conflictingId?: string
}

export type ObjectPositionValidation =
  | ObjectPositionValidationOk
  | ObjectPositionValidationFail

/**
 * Build the wall-plane AABB for a WallOpening (left-edge convention).
 */
export function aabbForOpening(o: WallOpening): WallPlaneAABB {
  return {
    left: o.offset_along_wall_m,
    right: o.offset_along_wall_m + o.width_m,
    bottom: o.offset_from_floor_m,
    top: o.offset_from_floor_m + o.height_m,
  }
}

/**
 * Build the wall-plane AABB for a wall-mounted SpatialObject (left-edge
 * convention, matching buildDefaultWallMountedObject in customerObjectMutator).
 *
 * Returns null when the object is not actually wall-mounted (e.g. floor or
 * ceiling host) — callers should skip those entries when collecting AABBs.
 */
export function aabbForWallMounted(o: SpatialObject): WallPlaneAABB | null {
  if (o.host !== 'wall') return null
  const offset = o.offset_along_wall_m ?? 0
  const fromFloor = o.height_from_floor_m ?? 0
  return {
    left: offset,
    right: offset + o.dimensions.width_m,
    bottom: fromFloor,
    top: fromFloor + o.dimensions.height_m,
  }
}

/**
 * True iff two AABBs overlap (touching edges = no overlap, strict inequality).
 */
export function aabbOverlaps(a: WallPlaneAABB, b: WallPlaneAABB): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.top <= b.bottom || a.bottom >= b.top)
}

/**
 * Validate a candidate object placement on a wall. The candidate is described
 * by its wall-plane AABB plus an optional `excludeId` so an existing object
 * being edited does not overlap with itself.
 *
 * Returns the first failing reason found in the canonical order:
 *   floor_breach → ceiling_breach → out_of_wall → aabb_overlap
 */
export function validateObjectPosition(input: {
  wall: Wall
  /** Cached wall length — pass `wallLengthMeters(wall)` from wallCoords. */
  wallLengthM: number
  /** Candidate AABB on the wall plane. */
  candidate: WallPlaneAABB
  /** When editing an existing object, exclude self from overlap check. */
  excludeId?: string
}): ObjectPositionValidation {
  const { wall, wallLengthM, candidate, excludeId } = input

  if (candidate.bottom < 0) {
    return {
      ok: false,
      reason: 'floor_breach',
      message: 'Objekt-Unterkante liegt unter dem Boden',
    }
  }
  if (candidate.top > wall.height_m + 1e-6) {
    return {
      ok: false,
      reason: 'ceiling_breach',
      message: 'Objekt ragt über die Decke hinaus',
    }
  }
  if (candidate.left < -1e-6 || candidate.right > wallLengthM + 1e-6) {
    return {
      ok: false,
      reason: 'out_of_wall',
      message: 'Objekt ragt aus der Wand',
    }
  }

  for (const o of wall.openings) {
    if (excludeId && o.id === excludeId) continue
    if (aabbOverlaps(candidate, aabbForOpening(o))) {
      return {
        ok: false,
        reason: 'aabb_overlap',
        message: `Position belegt durch ${o.name ?? 'bestehendes Objekt'}`,
        conflictingId: o.id,
      }
    }
  }
  for (const o of wall.wall_mounted) {
    if (excludeId && o.id === excludeId) continue
    const aabb = aabbForWallMounted(o)
    if (!aabb) continue
    if (aabbOverlaps(candidate, aabb)) {
      return {
        ok: false,
        reason: 'aabb_overlap',
        message: `Position belegt durch ${o.name ?? 'bestehendes Objekt'}`,
        conflictingId: o.id,
      }
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 · Floor-mounted (free-standing furniture) — Hard-Bounds in den Raum
//
// Möbel werden per Boden-Tap platziert / per Finger gezogen. Hard-Check: die
// komplette Stellfläche (rotiert + skaliert) muss innerhalb des Floor-Polygons
// liegen. Overlap zwischen Möbeln ist bewusst deferred an L1 DIN (Auto-Snap).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the 4 floor-plane footprint corners (world X/Z) of a floor-mounted
 * object, applying its `rotation_around_y_deg` and `transform.scale` to the
 * catalog dimensions. Centered on `transform.position`.
 */
export function floorFootprintCorners(o: SpatialObject): { x: number; z: number }[] {
  const cx = o.transform?.position?.x ?? 0
  const cz = o.transform?.position?.z ?? 0
  const sx = o.transform?.scale?.x ?? 1
  const sz = o.transform?.scale?.z ?? 1
  const halfW = (o.dimensions.width_m * sx) / 2
  const halfD = (o.dimensions.depth_m * sz) / 2
  const rad = ((o.rotation_around_y_deg ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const local: Array<[number, number]> = [
    [-halfW, -halfD],
    [halfW, -halfD],
    [halfW, halfD],
    [-halfW, halfD],
  ]
  return local.map(([lx, lz]) => ({
    x: cx + lx * cos - lz * sin,
    z: cz + lx * sin + lz * cos,
  }))
}

/**
 * Ray-casting point-in-polygon test on the floor plane (X/Z). Works for convex
 * and concave polygons (L-shaped rooms). Boundary points are treated as inside
 * within numerical tolerance is NOT guaranteed — fine for furniture footprints.
 */
export function pointInPolygon(pt: { x: number; z: number }, polygon: Vector3[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const zi = polygon[i].z
    const xj = polygon[j].x
    const zj = polygon[j].z
    const intersect =
      (zi > pt.z) !== (zj > pt.z) && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Effective (scaled) height of a floor object in meters.
 */
export function scaledHeightM(o: SpatialObject): number {
  const sy = o.transform?.scale?.y ?? 1
  return o.dimensions.height_m * sy
}

/**
 * Validate that a floor-mounted object's full footprint lies inside the room
 * AND (when `ceilingHeightM` is given) that the object is not taller than the
 * room — a 3.2 m shelf in a 2.8 m room would otherwise punch through the
 * ceiling mesh (Block A · A2). The height-check is opt-in so the many existing
 * footprint-only call sites stay unchanged.
 *
 * Returns `out_of_floor` if any footprint corner falls outside `floor.polygon`,
 * or `too_tall` if the scaled height exceeds the ceiling. A degenerate floor
 * (<3 vertices) never blocks the footprint.
 */
export function validateFloorObjectPosition(input: {
  floor: Floor
  object: SpatialObject
  /** Room ceiling height in meters. When provided, enforces the A2 height cap. */
  ceilingHeightM?: number
}): ObjectPositionValidation {
  const { floor, object, ceilingHeightM } = input
  if (ceilingHeightM != null && ceilingHeightM > 0) {
    if (scaledHeightM(object) > ceilingHeightM + 1e-6) {
      return {
        ok: false,
        reason: 'too_tall',
        message: 'Möbel ist höher als der Raum',
      }
    }
  }
  if (floor.polygon.length < 3) return { ok: true }
  const corners = floorFootprintCorners(object)
  for (const c of corners) {
    if (!pointInPolygon(c, floor.polygon)) {
      return {
        ok: false,
        reason: 'out_of_floor',
        message: 'Möbel passt nicht komplett in den Raum',
      }
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block A · A1 — Möbel-Möbel-Overlap (Soft-Notice, kein Block)
//
// Zwei Möbel auf demselben Punkt sehen falsch aus, ABER „Stuhl unter Tisch" /
// „Beistelltisch am Sofa" sind legitim. Deshalb KEIN Hard-Block, sondern eine
// Soft-Notice nur bei SUBSTANZIELLER Footprint-Überlappung (Default ≥50% der
// kleineren Stellfläche). Flache Objekte (Teppich/Vorleger, height < FLAT_MAX)
// werden ignoriert — Möbel stehen bestimmungsgemäß auf ihnen.
// ─────────────────────────────────────────────────────────────────────────────

/** Objekte flacher als das gelten als „Unterlage" und lösen keine Overlap-Notice aus. */
export const FLAT_OBJECT_MAX_HEIGHT_M = 0.06
const SUBSTANTIAL_OVERLAP_RATIO = 0.5

/** Achsen-ausgerichtete Footprint-Halbweiten (Rotation + Scale angewandt). */
function footprintHalfExtents(o: SpatialObject): { extX: number; extZ: number } {
  const sx = o.transform?.scale?.x ?? 1
  const sz = o.transform?.scale?.z ?? 1
  const halfW = (o.dimensions.width_m * sx) / 2
  const halfD = (o.dimensions.depth_m * sz) / 2
  const rad = ((o.rotation_around_y_deg ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return { extX: halfW * cos + halfD * sin, extZ: halfW * sin + halfD * cos }
}

/**
 * Find the first existing floor object whose footprint substantially overlaps
 * the candidate (AABB intersection ≥ 50% of the smaller footprint). Flat
 * underlay objects (rugs) and the candidate itself (`excludeId`) are skipped.
 * Returns the conflicting object's id + display name, or null when clear.
 *
 * Cheap axis-aligned approximation — exact for unrotated objects, conservative
 * for rotated ones (uses the rotated AABB), which is fine for a soft hint.
 */
export function findSubstantialFloorOverlap(input: {
  floor: Floor
  candidate: SpatialObject
  excludeId?: string
}): { id: string; name?: string } | null {
  const { floor, candidate, excludeId } = input
  if (scaledHeightM(candidate) < FLAT_OBJECT_MAX_HEIGHT_M) return null
  const cx = candidate.transform?.position?.x ?? 0
  const cz = candidate.transform?.position?.z ?? 0
  const c = footprintHalfExtents(candidate)
  const candArea = c.extX * 2 * (c.extZ * 2)
  for (const o of floor.floor_mounted) {
    if (o.id === excludeId || o.id === candidate.id) continue
    if (scaledHeightM(o) < FLAT_OBJECT_MAX_HEIGHT_M) continue
    const ox = o.transform?.position?.x ?? 0
    const oz = o.transform?.position?.z ?? 0
    const e = footprintHalfExtents(o)
    const overlapX = Math.min(cx + c.extX, ox + e.extX) - Math.max(cx - c.extX, ox - e.extX)
    const overlapZ = Math.min(cz + c.extZ, oz + e.extZ) - Math.max(cz - c.extZ, oz - e.extZ)
    if (overlapX <= 0 || overlapZ <= 0) continue
    const overlapArea = overlapX * overlapZ
    const otherArea = e.extX * 2 * (e.extZ * 2)
    const smaller = Math.min(candArea, otherArea)
    if (smaller > 0 && overlapArea / smaller >= SUBSTANTIAL_OVERLAP_RATIO) {
      return { id: o.id, name: o.name }
    }
  }
  return null
}

/**
 * Nudge a floor-mounted object's centre so its FULL (rotated + scaled) footprint
 * lies inside the room — instead of hard-rejecting an out-of-bounds tap/drag.
 * This is the "clamp-to-fit" placement policy: a tap inside the room always
 * lands the object (slid away from the walls if needed); only an object that is
 * genuinely larger than the room is refused.
 *
 * Returns the corrected world {x, z} centre, or `null` when no fit is found
 * (footprint wider/deeper than the room, or a concave-notch tap the cheap
 * fallback can't resolve). A non-null result is ALWAYS a fully-valid pose.
 *
 *   1. polygon < 3 verts (degenerate) → return the centre unchanged.
 *   2. already fully inside → return the centre unchanged.
 *   3. rectangular room (the common case — all customer presets) → axis-clamp
 *      the centre into the polygon bounding box, inset by the footprint's
 *      axis-aligned half-extents (+1mm so corners sit strictly inside).
 *   4. concave room (L-shape) where the box-clamp still pokes a corner into a
 *      notch → best-effort step toward the centroid; may return `null` if the
 *      centroid path stays in the notch (caller then rejects). Never returns an
 *      invalid pose.
 *
 * Pure: mirrors `floorFootprintCorners` conventions, no three.js / DOM.
 */
export function clampFloorObjectIntoRoom(
  floor: Floor,
  object: SpatialObject,
): { x: number; z: number } | null {
  const cx = object.transform?.position?.x ?? 0
  const cz = object.transform?.position?.z ?? 0
  if (floor.polygon.length < 3) return { x: cx, z: cz }
  if (validateFloorObjectPosition({ floor, object }).ok) return { x: cx, z: cz }

  // Footprint axis-aligned half-extents (rotation + scale applied).
  const sx = object.transform?.scale?.x ?? 1
  const sz = object.transform?.scale?.z ?? 1
  const halfW = (object.dimensions.width_m * sx) / 2
  const halfD = (object.dimensions.depth_m * sz) / 2
  const rad = ((object.rotation_around_y_deg ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const extX = halfW * cos + halfD * sin
  const extZ = halfW * sin + halfD * cos

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let centroidX = 0
  let centroidZ = 0
  for (const p of floor.polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
    centroidX += p.x
    centroidZ += p.z
  }
  centroidX /= floor.polygon.length
  centroidZ /= floor.polygon.length

  // 1mm inset so the clamped corners land STRICTLY inside the polygon — a corner
  // exactly on an edge reads as outside in the ray-cast `pointInPolygon`, which
  // would bounce the box-clamp into the centroid-walk fallback unnecessarily.
  const EPS = 1e-3
  // Footprint wider/deeper than the room's bounding box → cannot fit anywhere.
  if (maxX - minX < extX * 2 + EPS * 2 || maxZ - minZ < extZ * 2 + EPS * 2) return null

  const clampedX = Math.min(Math.max(cx, minX + extX + EPS), maxX - extX - EPS)
  const clampedZ = Math.min(Math.max(cz, minZ + extZ + EPS), maxZ - extZ - EPS)

  const at = (x: number, z: number): SpatialObject => ({
    ...object,
    transform: {
      ...object.transform,
      position: { ...object.transform.position, x, z },
    },
  })

  if (validateFloorObjectPosition({ floor, object: at(clampedX, clampedZ) }).ok) {
    return { x: clampedX, z: clampedZ }
  }

  // Concave room: the bbox-clamped point can still land in a notch — walk it
  // toward the centroid until the whole footprint clears the polygon.
  for (let i = 1; i <= 12; i++) {
    const t = i / 12
    const x = clampedX + (centroidX - clampedX) * t
    const z = clampedZ + (centroidZ - clampedZ) * t
    if (validateFloorObjectPosition({ floor, object: at(x, z) }).ok) {
      return { x, z }
    }
  }
  return null
}
