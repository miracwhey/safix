/**
 * Spatial · Workflow · Pin-Anchor World→UV Projection (Phase 3 · Block 3.6/3.7)
 *
 * The pure inverse of the PinAdapter / PinSet UV→world resolver. Given a
 * world-space raycast hit and the host surface it landed on, this projects the
 * point onto the surface's canonical UV (Master-Spec §13.2):
 *
 *   - Wall    : U along (start → end), V from bottom → top.
 *   - Floor   : U along room-bounds X, V along room-bounds Z.
 *   - Ceiling : same as Floor (V along Z).
 *   - Object  : the V1 fallback anchors at the object centre (UV 0.5, 0.5) —
 *               the asset UV map is V1.x; pinning an object surface still
 *               produces a stable, deterministic anchor.
 *
 * Keeping this in the workflow layer (not the renderer) means the Stage-4
 * Pin-Drop path can resolve a UV without a three.js dependency, and the
 * projection is unit-testable with plain literals.
 *
 * Layer: pure — no React, no three.js, no DB. Deterministic over its inputs.
 */

import type { RoomScene } from '../canonical/types/scene-graph'
import type { Wall, Floor, Ceiling } from '../canonical/types/geometry'
import type { SpatialObject } from '../canonical/types/objects'
import type { AnchorSurfaceType } from '../canonical/types/annotations'
import type { TappedSurfaceKind } from '../../../components/spatial/three/canonical/surfaceTap'

/** A resolved pin anchor — the surface + canonical UV the pin binds to. */
export interface ResolvedPinAnchor {
  surfaceId: string
  surfaceType: AnchorSurfaceType
  uv: { u: number; v: number }
}

/** Clamp a value to `[0, 1]`. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Map a {@link TappedSurfaceKind} onto the {@link AnchorSurfaceType}. */
export function tappedKindToAnchorSurfaceType(
  kind: TappedSurfaceKind,
): AnchorSurfaceType {
  return kind
}

/** Project a world point onto a wall's canonical UV (U along length, V height). */
function projectWallUv(
  wall: Wall,
  point: { x: number; y: number; z: number },
): { u: number; v: number } {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  // U: the point's projection along the wall centerline, normalised by length.
  const u =
    len === 0
      ? 0.5
      : ((point.x - wall.start_point.x) * dx + (point.z - wall.start_point.z) * dz) /
        (len * len)
  // V: height above the wall base, normalised by wall height.
  const v =
    wall.height_m === 0 ? 0.5 : (point.y - wall.base_height_m) / wall.height_m
  return { u: clamp01(u), v: clamp01(v) }
}

/** Project a world point onto a floor/ceiling polygon's bounds-box UV. */
function projectPolygonUv(
  ring: ReadonlyArray<{ x: number; z: number }>,
  point: { x: number; z: number },
): { u: number; v: number } {
  if (ring.length < 3) return { u: 0.5, v: 0.5 }
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of ring) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  return {
    u: clamp01(spanX === 0 ? 0.5 : (point.x - minX) / spanX),
    v: clamp01(spanZ === 0 ? 0.5 : (point.z - minZ) / spanZ),
  }
}

/**
 * Resolve a pin anchor from a tapped surface + (optional) world hit point.
 *
 * When `point` is omitted (a synthetic tap, or a renderer that did not carry
 * an intersection) the anchor falls back to the surface centre (UV 0.5, 0.5) —
 * the pin is still 3D-native and deterministic, just not at the exact tap
 * pixel. Returns `null` when the surface id does not resolve on the scene.
 */
export function resolvePinAnchor(
  scene: RoomScene,
  surfaceKind: TappedSurfaceKind,
  surfaceId: string,
  point?: { x: number; y: number; z: number },
): ResolvedPinAnchor | null {
  const surfaceType = tappedKindToAnchorSurfaceType(surfaceKind)
  const CENTRE = { u: 0.5, v: 0.5 }

  if (surfaceKind === 'wall') {
    const wall: Wall | undefined = scene.walls.find((w) => w.id === surfaceId)
    if (!wall) return null
    return {
      surfaceId,
      surfaceType,
      uv: point ? projectWallUv(wall, point) : CENTRE,
    }
  }
  if (surfaceKind === 'floor') {
    const floor: Floor = scene.floor
    if (floor.id !== surfaceId) return null
    return {
      surfaceId,
      surfaceType,
      uv: point ? projectPolygonUv(floor.polygon, point) : CENTRE,
    }
  }
  if (surfaceKind === 'ceiling') {
    const ceiling: Ceiling = scene.ceiling
    if (ceiling.id !== surfaceId) return null
    return {
      surfaceId,
      surfaceType,
      uv: point ? projectPolygonUv(ceiling.polygon, point) : CENTRE,
    }
  }
  // Object — V1 anchors at the object centre (the asset UV map is V1.x).
  const objects: SpatialObject[] = [
    ...scene.free_objects,
    ...scene.floor.floor_mounted,
    ...scene.ceiling.ceiling_mounted,
    ...scene.walls.flatMap((w) => w.wall_mounted),
  ]
  if (!objects.some((o) => o.id === surfaceId)) return null
  return { surfaceId, surfaceType, uv: CENTRE }
}
