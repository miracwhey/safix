/**
 * Spatial · Canonical · Workflow · wallPointOrchestrator (manual footprint edit)
 *
 * PURE domain layer for footprint-first wall-GEOMETRY edits on manual rooms,
 * mirroring `customerWallObjectOrchestrator` (which handles wall OBJECTS).
 * Operations:
 *   - `moveWallCorner` — drag a ring vertex; every wall endpoint at that corner
 *     moves atomically (the footprint-first win: one vertex, never two endpoints
 *     to keep in sync — eliminates the shared-corner-desync class of bugs).
 *   - `setEdgeLength` — type an exact wall length (moves the shared end corner).
 *   - `setWallHeight` / `setAllWallsHeight` — numeric / slider height edits.
 *
 * Every op: mutate the wall ring → refresh cached fields → re-derive floor +
 * ceiling (`rebuildFloorCeilingFromWalls`) → validate (min edge length, no
 * self-intersection) → reject moves that would orphan a hosted opening
 * (Phase-1 MVP: opening re-anchoring on length change is deferred — the gesture
 * layer holds the last valid pose on reject).
 *
 * ZERO React / zustand / three.js / supabase imports — the gesture layer / Hub
 * applies the store write, the blob persist, and the toast.
 */
import type { RoomScene } from '../types/scene-graph.ts'
import type { Wall, WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type { Vector3 } from '../types/primitives.ts'
import {
  refreshWallCachedFields,
  normalCompute,
  centerlineMidpoint,
} from '../geometry/wall-geometry.ts'
import { rebuildFloorCeilingFromWalls } from '../geometry/footprint.ts'
import { checkFloorSelfIntersecting } from '../validator/rules/room-rules.ts'
import { pointInPolygon } from '../validator/objectPositionValidator.ts'

/** Walls shorter than this collapse the footprint — rejected on commit. */
export const MIN_WALL_LENGTH_M = 0.5

/** Endpoints within this of a dragged corner snap to it (matches the stitch ε). */
const CORNER_MATCH_EPSILON_M = 0.05

export type WallPointEditResult =
  | { kind: 'updated'; scene: RoomScene }
  | { kind: 'rejected'; message: string }

interface XZ {
  x: number
  z: number
}

const dist2D = (a: XZ, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Snap every wall endpoint within {@link CORNER_MATCH_EPSILON_M} of `from` to
 * `to`. PURE walls→walls (no validation) so it can back BOTH the validated
 * `moveWallCorner` and the live `previewWallCorner`. `moved` counts endpoints
 * touched (a shared corner is 2 → both adjacent walls drag atomically).
 */
function translateCornerWalls(
  walls: Wall[],
  from: XZ,
  to: XZ,
): { walls: Wall[]; moved: number } {
  let moved = 0
  const out = walls.map((w): Wall => {
    let next = w
    if (dist2D(from, w.start_point) <= CORNER_MATCH_EPSILON_M) {
      next = { ...next, start_point: { ...next.start_point, x: to.x, z: to.z } }
      moved++
    }
    if (dist2D(from, w.end_point) <= CORNER_MATCH_EPSILON_M) {
      next = { ...next, end_point: { ...next.end_point, x: to.x, z: to.z } }
      moved++
    }
    return next === w ? w : refreshWallCachedFields(next)
  })
  return { walls: out, moved }
}

/**
 * Move a footprint corner (ring vertex). Every wall endpoint within
 * {@link CORNER_MATCH_EPSILON_M} of `from` snaps to `to`, so a shared corner
 * drags both adjacent walls in one atomic edit.
 */
export function moveWallCorner(input: {
  scene: RoomScene
  from: XZ
  to: XZ
}): WallPointEditResult {
  const { walls, moved } = translateCornerWalls(input.scene.walls, input.from, input.to)
  if (moved === 0) return { kind: 'rejected', message: 'Keine Ecke an dieser Position.' }
  return finalize(input.scene, walls)
}

/**
 * Set an exact wall length. Keeps the start point fixed and moves the shared
 * END corner along the wall direction — cascading to the neighbouring wall
 * that shares that corner (so the ring stays closed).
 */
export function setEdgeLength(input: {
  scene: RoomScene
  wallId: string
  lengthM: number
}): WallPointEditResult {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { kind: 'rejected', message: 'Wand nicht gefunden.' }
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return { kind: 'rejected', message: 'Wand hat keine Richtung.' }
  const ux = dx / len
  const uz = dz / len
  return moveWallCorner({
    scene: input.scene,
    from: { x: wall.end_point.x, z: wall.end_point.z },
    to: {
      x: wall.start_point.x + ux * input.lengthM,
      z: wall.start_point.z + uz * input.lengthM,
    },
  })
}

/** Default outward step of an inserted corner (m) — comfortably above MIN. */
export const CORNER_INSERT_STEP_M = 0.6

/**
 * Insert a rectilinear CORNER into a wall — the footprint-first "Ecke einfügen"
 * that replaces free corner dragging (which felt catastrophic on device: hang +
 * jump). The selected wall S→E is rebuilt into THREE axis-aligned segments that
 * step the SECOND half outward by {@link CORNER_INSERT_STEP_M}:
 *
 *     left:  S → M                  (first half, unchanged)
 *     riser: M → M + n·step         (perpendicular, the new corner)
 *     right: M+n·step → E + n·step   (second half, pushed outward)
 *
 * and the wall(s) sharing the END corner E are translated by n·step too, so the
 * ring stays closed. The result is a clean L — every wall stays axis-aligned, so
 * sliding any of them afterwards (mid-bar) can NEVER produce a slanted edge (a
 * plain midpoint split would: its two collinear halves share a corner, and
 * sliding one slants the other). Slide the `right` segment to deepen the L, the
 * `riser` to widen it.
 *
 * Hosted openings + wall-mounted objects are reassigned to whichever half FULLY
 * contains them (offset re-based onto the second half); a straddling object
 * blocks the insert (reject → caller toasts "woanders teilen"). A wall whose
 * halves would fall below {@link MIN_WALL_LENGTH_M} is rejected.
 *
 * Caller supplies the three new wall ids + an ISO timestamp so this module stays
 * pure (no crypto / Date import) — mirroring `buildDefaultOpening`.
 */
export function insertWallCorner(input: {
  scene: RoomScene
  wallId: string
  newWallIdLeft: string
  newWallIdRiser: string
  newWallIdRight: string
  generatedAt: string
}): WallPointEditResult {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { kind: 'rejected', message: 'Wand nicht gefunden.' }
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return { kind: 'rejected', message: 'Wand hat keine Richtung.' }
  const half = len / 2
  if (half < MIN_WALL_LENGTH_M) {
    return {
      kind: 'rejected',
      message: `Wand zu kurz für eine Ecke (Hälften min. ${MIN_WALL_LENGTH_M.toFixed(2)} m).`,
    }
  }
  const n = wallOutwardNormalXZ(input.scene, input.wallId)
  if (!n) return { kind: 'rejected', message: 'Wand hat keine Richtung.' }
  const step = CORNER_INSERT_STEP_M
  const sx = n.x * step
  const sz = n.z * step

  const y = wall.start_point.y ?? 0
  const mid: Vector3 = { x: wall.start_point.x + dx / 2, y, z: wall.start_point.z + dz / 2 }
  const midOut: Vector3 = { x: mid.x + sx, y, z: mid.z + sz }
  const endOut: Vector3 = { x: wall.end_point.x + sx, y, z: wall.end_point.z + sz }
  const endCorner = { x: wall.end_point.x, z: wall.end_point.z }

  // Reassign hosted openings/objects to the half that fully contains them (right
  // half offset re-based by `half`); a straddling object blocks the insert.
  const openingsLeft: WallOpening[] = []
  const openingsRight: WallOpening[] = []
  for (const o of wall.openings) {
    const left = o.offset_along_wall_m
    const right = left + o.width_m
    if (right <= half + 1e-6) {
      openingsLeft.push({ ...o, host_wall_id: input.newWallIdLeft, parent_id: input.newWallIdLeft })
    } else if (left >= half - 1e-6) {
      openingsRight.push({
        ...o,
        host_wall_id: input.newWallIdRight,
        parent_id: input.newWallIdRight,
        offset_along_wall_m: left - half,
      })
    } else {
      return { kind: 'rejected', message: 'Tür/Fenster liegt auf der Ecke — woanders einfügen.' }
    }
  }
  const mountedLeft: SpatialObject[] = []
  const mountedRight: SpatialObject[] = []
  for (const o of wall.wall_mounted) {
    const left = o.offset_along_wall_m ?? 0
    const right = left + o.dimensions.width_m
    if (right <= half + 1e-6) {
      mountedLeft.push({ ...o, host_id: input.newWallIdLeft, parent_id: input.newWallIdLeft })
    } else if (left >= half - 1e-6) {
      mountedRight.push({
        ...o,
        host_id: input.newWallIdRight,
        parent_id: input.newWallIdRight,
        offset_along_wall_m: left - half,
      })
    } else {
      return { kind: 'rejected', message: 'Objekt liegt auf der Ecke — woanders einfügen.' }
    }
  }

  const leftWall: Wall = refreshWallCachedFields({
    ...wall,
    id: input.newWallIdLeft,
    start_point: { ...wall.start_point },
    end_point: { ...mid },
    openings: openingsLeft,
    wall_mounted: mountedLeft,
    updated_at: input.generatedAt,
  })
  const riserWall: Wall = refreshWallCachedFields({
    ...wall,
    id: input.newWallIdRiser,
    start_point: { ...mid },
    end_point: { ...midOut },
    openings: [],
    wall_mounted: [],
    updated_at: input.generatedAt,
  })
  const rightWall: Wall = refreshWallCachedFields({
    ...wall,
    id: input.newWallIdRight,
    start_point: { ...midOut },
    end_point: { ...endOut },
    openings: openingsRight,
    wall_mounted: mountedRight,
    updated_at: input.generatedAt,
  })

  // Translate the perpendicular neighbour(s) sharing the END corner by n·step so
  // the ring closes (the original wall is rebuilt above, so skip it).
  const near = (p: { x: number; z: number }): boolean =>
    dist2D(endCorner, p) <= CORNER_MATCH_EPSILON_M
  const walls = input.scene.walls.flatMap((w): Wall[] => {
    if (w.id === input.wallId) return [leftWall, riserWall, rightWall]
    let next = w
    if (near(w.start_point)) {
      next = { ...next, start_point: { ...next.start_point, x: next.start_point.x + sx, z: next.start_point.z + sz } }
    }
    if (near(w.end_point)) {
      next = { ...next, end_point: { ...next.end_point, x: next.end_point.x + sx, z: next.end_point.z + sz } }
    }
    return [next === w ? w : refreshWallCachedFields(next)]
  })
  return finalize(input.scene, walls)
}

/**
 * The wall's OUTWARD unit normal in the XZ plane (points away from the room
 * interior), or `null` for a zero-length wall / missing wall.
 *
 * `normalCompute` derives its normal from the wall's stored start→end
 * direction, which is ARBITRARY relative to the CCW floor ring — so its sign is
 * NOT reliably outward. We disambiguate against the actual floor polygon: probe
 * a hair along the raw normal from the centerline midpoint; if that lands INSIDE
 * the room, the raw normal pointed inward → flip it. Used for the edge-slide
 * pille's arrow glyph (which must point out of the room).
 */
export function wallOutwardNormalXZ(scene: RoomScene, wallId: string): XZ | null {
  const wall = scene.walls.find((w) => w.id === wallId)
  if (!wall) return null
  const n = normalCompute(wall)
  if (n.x === 0 && n.z === 0) return null
  const mid = centerlineMidpoint(wall)
  const ring = scene.floor?.polygon ?? []
  if (
    ring.length >= 3 &&
    pointInPolygon({ x: mid.x + n.x * 0.02, z: mid.z + n.z * 0.02 }, ring)
  ) {
    return { x: -n.x, z: -n.z }
  }
  return { x: n.x, z: n.z }
}

/**
 * Translate BOTH corners of one wall (and every neighbour endpoint sharing
 * them) by `delta`. PURE walls→walls. The gesture layer constrains `delta` to
 * the wall's outward-normal axis → the wall slides perpendicular (1 DOF), the
 * two adjacent walls stretch with it, and the ring stays closed + rectilinear.
 *
 * Done in ONE pass (NOT two `moveWallCorner` calls): a sequential per-corner
 * move would leave the edge transiently diagonal and self-intersecting between
 * the two updates, which `finalize` would reject.
 */
function translateEdgeWalls(walls: Wall[], cornerA: XZ, cornerB: XZ, delta: XZ): Wall[] {
  const near = (p: { x: number; z: number }): boolean =>
    dist2D(cornerA, p) <= CORNER_MATCH_EPSILON_M ||
    dist2D(cornerB, p) <= CORNER_MATCH_EPSILON_M
  return walls.map((w): Wall => {
    let next = w
    if (near(w.start_point)) {
      next = {
        ...next,
        start_point: {
          ...next.start_point,
          x: next.start_point.x + delta.x,
          z: next.start_point.z + delta.z,
        },
      }
    }
    if (near(w.end_point)) {
      next = {
        ...next,
        end_point: {
          ...next.end_point,
          x: next.end_point.x + delta.x,
          z: next.end_point.z + delta.z,
        },
      }
    }
    return next === w ? w : refreshWallCachedFields(next)
  })
}

/**
 * Slide a whole outer wall along `delta` (room grows/shrinks in that direction).
 * `delta` is the already-resolved meter displacement from the gesture layer
 * (projected onto the wall's normal axis + magnet/grid-snapped) — this pure op
 * just translates the edge's two corners + their shared neighbours, then runs
 * the same `finalize` validate→rebuild→reject pipeline as `moveWallCorner`.
 */
export function moveWallEdge(input: {
  scene: RoomScene
  wallId: string
  delta: XZ
}): WallPointEditResult {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { kind: 'rejected', message: 'Wand nicht gefunden.' }
  const walls = translateEdgeWalls(
    input.scene.walls,
    { x: wall.start_point.x, z: wall.start_point.z },
    { x: wall.end_point.x, z: wall.end_point.z },
    input.delta,
  )
  return finalize(input.scene, walls)
}

/**
 * The result of a LIVE (per-pointermove) footprint edit. Unlike the validated
 * ops, `scene` is ALWAYS renderable — when the in-progress pose is invalid the
 * walls still follow the finger (floor/ceiling held at the last valid shape) so
 * the drag never freezes; `rejection` carries the reason for the red tint + the
 * snap-back-on-release. A valid pose returns the fully rebuilt scene + `null`.
 */
export interface LiveWallEdit {
  scene: RoomScene
  rejection: string | null
}

/** Live corner drag — see {@link LiveWallEdit}. */
export function previewWallCorner(input: {
  scene: RoomScene
  from: XZ
  to: XZ
}): LiveWallEdit {
  const { walls, moved } = translateCornerWalls(input.scene.walls, input.from, input.to)
  if (moved === 0) return { scene: input.scene, rejection: 'Keine Ecke an dieser Position.' }
  const res = finalize(input.scene, walls)
  if (res.kind === 'updated') return { scene: res.scene, rejection: null }
  return { scene: { ...input.scene, walls }, rejection: res.message }
}

/** Live edge slide — see {@link LiveWallEdit}. */
export function previewWallEdge(input: {
  scene: RoomScene
  wallId: string
  delta: XZ
}): LiveWallEdit {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { scene: input.scene, rejection: 'Wand nicht gefunden.' }
  const walls = translateEdgeWalls(
    input.scene.walls,
    { x: wall.start_point.x, z: wall.start_point.z },
    { x: wall.end_point.x, z: wall.end_point.z },
    input.delta,
  )
  const res = finalize(input.scene, walls)
  if (res.kind === 'updated') return { scene: res.scene, rejection: null }
  return { scene: { ...input.scene, walls }, rejection: res.message }
}

/** Set a single wall's height (numeric / slider). Floor footprint is unchanged. */
export function setWallHeight(input: {
  scene: RoomScene
  wallId: string
  heightM: number
}): WallPointEditResult {
  let found = false
  const walls = input.scene.walls.map((w): Wall => {
    if (w.id !== input.wallId) return w
    found = true
    return { ...w, height_m: input.heightM }
  })
  if (!found) return { kind: 'rejected', message: 'Wand nicht gefunden.' }
  return finalize(input.scene, walls)
}

/**
 * Set the height of EVERY wall plus the room ceiling height ("Höhe für alle
 * Wände" toggle). Re-derive recomputes volume + bounds from the new height.
 */
export function setAllWallsHeight(input: {
  scene: RoomScene
  heightM: number
}): WallPointEditResult {
  const walls = input.scene.walls.map((w): Wall => ({ ...w, height_m: input.heightM }))
  const scene: RoomScene = {
    ...input.scene,
    ceiling: { ...input.scene.ceiling, height_m: input.heightM },
  }
  return finalize(scene, walls)
}

/**
 * Set a single wall's height + thickness in one edit (the customer / HW wall
 * dims sheet). The footprint ring is unchanged — thickness affects only the
 * wall mesh, not the floor polygon — so this is the cheap dims-only path.
 */
export function setWallDims(input: {
  scene: RoomScene
  wallId: string
  heightM: number
  thicknessM: number
}): WallPointEditResult {
  let found = false
  const walls = input.scene.walls.map((w): Wall => {
    if (w.id !== input.wallId) return w
    found = true
    return refreshWallCachedFields({
      ...w,
      height_m: input.heightM,
      thickness_m: input.thicknessM,
    })
  })
  if (!found) return { kind: 'rejected', message: 'Wand nicht gefunden.' }
  // Height + thickness do NOT change the footprint ring (the floor is derived
  // from wall CENTERLINES). Critically we must NOT rebuild floor/ceiling here:
  // for a SCANNED room whose RoomPlan walls don't stitch into a closed ring,
  // rebuildFloorCeilingFromWalls would wipe the valid floor polygon + area (whose
  // only source is the scan-ingest fallback). Return the dims-only mutation with
  // the footprint untouched.
  return { kind: 'updated', scene: { ...input.scene, walls } }
}

function finalize(prevScene: RoomScene, walls: Wall[]): WallPointEditResult {
  for (const w of walls) {
    // Reject collapsed walls INCLUDING ~zero length: a grid-snapped corner-merge
    // can drive a wall to exactly 0, which a `> 1e-6` lower bound would skip.
    if (w.length_m < MIN_WALL_LENGTH_M) {
      return { kind: 'rejected', message: `Wand zu kurz (min. ${MIN_WALL_LENGTH_M.toFixed(2)} m).` }
    }
    for (const o of w.openings) {
      if (o.offset_along_wall_m + o.width_m > w.length_m + 1e-6) {
        return { kind: 'rejected', message: 'Tür/Fenster passt nicht mehr in die Wand.' }
      }
    }
  }
  const rebuilt = rebuildFloorCeilingFromWalls({ ...prevScene, walls })
  const ring = rebuilt.floor.polygon
  // A wall move that breaks the closed-loop stitch makes inferFloorPolygonFromWalls
  // return [] → an empty floor ring. Committing that as 'updated' would persist a
  // BLANK floor (area 0) while the walls sit elsewhere — the "floor collapsed /
  // outside the room" bug. Reject so the gesture layer holds the last valid pose +
  // snaps back on release. (Draw-from-blank legitimately starts at 0 walls, but that
  // path builds the floor via rebuildFloorCeilingFromWalls directly — never through
  // finalize, which only runs on reshape ops over an already-closed ring.)
  if (ring.length < 3) {
    return { kind: 'rejected', message: 'Form ist nicht geschlossen.' }
  }
  // checkFloorSelfIntersecting self-guards `<4 → []`, so a triangle is a safe no-op.
  if (checkFloorSelfIntersecting(rebuilt).length > 0) {
    return { kind: 'rejected', message: 'Die Form überschneidet sich.' }
  }
  // Grid-snap can drag a corner exactly onto another → coincident ring vertices
  // (a pinch the strict self-intersection test misses). Reject the degenerate ring.
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      if (Math.hypot(ring[i].x - ring[j].x, ring[i].z - ring[j].z) < CORNER_MATCH_EPSILON_M) {
        return { kind: 'rejected', message: 'Zwei Ecken liegen aufeinander.' }
      }
    }
  }
  return { kind: 'updated', scene: rebuilt }
}
