/**
 * Spatial · Canonical · Geometry · Wall Joins
 *
 * Derives, for a set of parametric walls, the corner-join topology and the
 * mitered floor footprint of every wall — so a renderer can draw clean
 * corners instead of overlapping butt-jointed boxes.
 *
 * Approach (binding · `spatial-zwischen-latte-corners-edges-design.md` §2):
 * Hybrid "Miter-Math + Union-Net". Per wall-end we compute an analytic
 * angle-bisector miter (exact for L/T/X and arbitrary angles, including
 * unequal wall thicknesses). Degenerate inputs fall back to the plain
 * perpendicular end-cap — the result is never broken geometry, never NaN.
 *
 * NON-DESTRUCTIVE: the input walls' `start_point` / `end_point` are never
 * mutated. A `WallJoinGraph` is *derived* and held alongside the scene; the
 * canonical truth stays the parametric wall.
 *
 * Conventions (inherited from `wall-geometry.ts`):
 *   - Walls live on the floor plane (XZ); Y is up.
 *   - Outward normal of a wall = right-hand-perpendicular of (end - start):
 *     `(dz, 0, -dx)` normalised.
 *   - `polygonFromWallFootprint` vertex order, CCW from above:
 *       [0] outer_start · [1] outer_end · [2] inner_end · [3] inner_start
 *
 * All functions are pure: no three.js, no DOM, no side-effects.
 */

// polygon-clipping@0.15 ships an ESM bundle that only exports `default`; its
// .d.ts wrongly declares named exports. Import the default object (works for
// both the strict Rollup build and esbuild) and pull types separately.
import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Ring } from 'polygon-clipping'

import { EPSILON, type Vector3 } from '../types/primitives.ts'
import {
  lengthCompute,
  polygonFromWallFootprint,
  type WallGeometryInput,
} from './wall-geometry.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Domain constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two wall endpoints closer than this are treated as the SAME corner and are
 * snapped onto a shared junction node. A domain threshold (≈ half a typical
 * wall thickness) — deliberately NOT the float `EPSILON`: it absorbs the
 * sub-cm-to-cm gaps RoomPlan LiDAR leaves between walls that physically meet.
 */
export const JOIN_TOLERANCE_M = 0.12

/**
 * Upper bound for the centerline-extension gap-closing stage. Endpoints
 * farther apart than {@link JOIN_TOLERANCE_M} but closer than this may still
 * be joined if their centerlines intersect near both ends. Beyond this we
 * never guess — the validator surfaces `WALL_JOIN_GAP_LARGE` instead.
 */
export const JOIN_TOLERANCE_LOOSE_M = 0.30

/**
 * Miter-spike clamp (degenerate case D1): at very acute angles the analytic
 * miter point shoots far past the junction. When the miter depth exceeds
 * `maxHalfThickness * MITER_LIMIT_FACTOR` the corner falls back to the plain
 * perpendicular cap.
 */
export const MITER_LIMIT_FACTOR = 4

/**
 * Determinant threshold below which two half-lines count as parallel /
 * collinear (degenerate case D2). Separate from {@link EPSILON} because it
 * gates an angular quantity, not a positional one.
 */
export const ANGLE_EPSILON = 1e-6

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A wall plus its stable scene-graph id — the unit consumed by this module. */
export type WallJoinInput = WallGeometryInput & { id: string }

/** Which endpoint of a wall centerline a join refers to. */
export type WallEnd = 'start' | 'end'

/**
 * One wall-end incident on a junction.
 *
 * `direction` points AWAY from the junction, into the wall body — so a
 * junction's incident ends fan out from `point`. `half_thickness_m` is half
 * the host wall's full thickness (the wall extends this far either side of
 * its centerline).
 */
export interface WallEndRef {
  wall_id: string
  end: WallEnd
  direction: Vector3
  half_thickness_m: number
}

/**
 * A clustered corner where two or more wall-ends meet (or where one wall's
 * end runs into another wall's side — a T-junction).
 *
 * `incident` lists only real wall-ends and is sorted cyclically by the
 * angle of each end's outgoing `direction`. For a T-junction `through_wall_id`
 * names the wall that passes through this point WITHOUT ending here.
 */
export interface WallJunction {
  id: string
  /** Junction point in world space (XZ on the floor plane). */
  point: Vector3
  kind: 'free' | 'L' | 'T' | 'X'
  /** Real wall-ends meeting here · cyclically sorted by outgoing angle. */
  incident: WallEndRef[]
  /** T-junction only: the wall passing through this point with no end here. */
  through_wall_id?: string
}

/**
 * A non-fatal finding produced while deriving the join graph. Feeds the
 * scene validator (`WALL_JOIN_*` / `WALL_TOO_SHORT_FOR_JOIN` codes). All are
 * warnings or hints — join derivation never blocks rendering.
 */
export interface WallJoinDiagnostic {
  code:
    | 'WALL_JOIN_GAP_LARGE'
    | 'WALL_JOIN_AMBIGUOUS'
    | 'WALL_TOO_SHORT_FOR_JOIN'
    | 'WALL_DUPLICATE_SUSPECTED'
  wall_ids: string[]
}

/**
 * The derived corner-join topology of a room's walls.
 *
 *   - `junctions`   — every clustered corner.
 *   - `byWallEnd`   — fast lookup keyed by `"<wall_id>|<end>"`; a missing key
 *                     means that wall-end is free (no neighbour).
 *   - `wallsById`   — derived lookup of the input walls, so the miter helpers
 *                     can resolve a T-junction's through-wall geometry.
 *   - `diagnostics` — validator feed (see {@link WallJoinDiagnostic}).
 */
export interface WallJoinGraph {
  junctions: WallJunction[]
  byWallEnd: Map<string, WallJunction>
  wallsById: Map<string, WallJoinInput>
  diagnostics: WallJoinDiagnostic[]
}

/**
 * Result of {@link computeMiteredWallFootprint}: the wall's floor footprint
 * with corners adjusted for its neighbours, plus how deep the miter cut into
 * each end (consumed by `wall-profile.ts` to bound opening placement).
 */
export interface MiterResult {
  /**
   * 4-point CCW footprint quad, same vertex order as
   * `polygonFromWallFootprint`. Empty array only for zero-length walls (D3).
   */
  footprint: Vector3[]
  /** Inward miter depth in meters at each end (0 = plain perpendicular cap). */
  miterDepth: { start: number; end: number }
}

/**
 * The unioned floor outline of a room's whole wall mass — the input the
 * floorplan view + walkable-area subtraction want. `outer` is the outer
 * boundary; `holes` are the interior voids (typically the room cavity).
 */
export interface WallFootprintOutline {
  outer: Vector3[]
  holes: Vector3[][]
}

// ─────────────────────────────────────────────────────────────────────────────
// Small XZ vector helpers (kept local — pure, no three.js)
// ─────────────────────────────────────────────────────────────────────────────

function dist2D(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function normalize2D(x: number, z: number): Vector3 {
  const len = Math.hypot(x, z)
  if (len < EPSILON) return { x: 0, y: 0, z: 0 }
  return { x: x / len, y: 0, z: z / len }
}

/** Right-hand perpendicular of a direction on XZ — `(d.z, 0, -d.x)`. */
function perp2D(d: Vector3): Vector3 {
  return { x: d.z, y: 0, z: -d.x }
}

function dot2D(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.z * b.z
}

/** Signed area of a polygon ring on XZ — positive when CCW (viewed from +Y). */
function signedArea2D(ring: Vector3[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area += a.x * b.z - b.x * a.z
  }
  return area / 2
}

/** Endpoint of a wall by end tag. */
function endpointOf(wall: WallGeometryInput, end: WallEnd): Vector3 {
  return end === 'start' ? wall.start_point : wall.end_point
}

/** Unit centerline direction pointing AWAY from `end`, into the wall body. */
function directionInto(wall: WallGeometryInput, end: WallEnd): Vector3 {
  const s = wall.start_point
  const e = wall.end_point
  return end === 'start'
    ? normalize2D(e.x - s.x, e.z - s.z)
    : normalize2D(s.x - e.x, s.z - e.z)
}

/** Unit centerline direction from `start_point` to `end_point`. */
function wallDirection(wall: WallGeometryInput): Vector3 {
  return normalize2D(
    wall.end_point.x - wall.start_point.x,
    wall.end_point.z - wall.start_point.z,
  )
}

function wallEndKey(wallId: string, end: WallEnd): string {
  return `${wallId}|${end}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Half-line intersection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intersection of two lines on the XZ plane, each given as a support point
 * and a direction (`P + s·dirP`, `Q + u·dirQ`). Returns `null` when the two
 * directions are parallel / collinear within {@link ANGLE_EPSILON}.
 *
 * The result's `y` is copied from `p` — all join math stays on one floor
 * plane. Exported for direct unit-testing of the core primitive.
 */
export function intersectHalfLinesXZ(
  p: Vector3,
  dirP: Vector3,
  q: Vector3,
  dirQ: Vector3,
): Vector3 | null {
  const denom = dirP.x * dirQ.z - dirP.z * dirQ.x
  if (Math.abs(denom) < ANGLE_EPSILON) return null
  const s = ((q.x - p.x) * dirQ.z - (q.z - p.z) * dirQ.x) / denom
  if (!Number.isFinite(s)) return null
  return { x: p.x + s * dirP.x, y: p.y, z: p.z + s * dirP.z }
}

// ─────────────────────────────────────────────────────────────────────────────
// Junction arms — the uniform model behind L / T / X miters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A directional "arm" sticking out of a junction. A real wall-end is one
 * arm; a T-junction's through-wall contributes TWO arms (`+dir` and `-dir`),
 * which is why the same cyclic-sort math handles L, T and X uniformly.
 */
interface JunctionArm {
  /** Stable key — `"<wallId>|<end>"` for real ends, synthetic for through-halves. */
  key: string
  /** Unit direction away from the junction. */
  dir: Vector3
  /** Half thickness of the arm's wall. */
  halfThk: number
}

/** Cyclic angle of an arm direction, used as the sort key. */
function armAngle(arm: JunctionArm): number {
  return Math.atan2(arm.dir.z, arm.dir.x)
}

/**
 * All arms incident on a junction, cyclically sorted by outgoing angle.
 * Real wall-ends come straight from `incident`; a through-wall is expanded
 * into its two opposite half-arms.
 */
function junctionArms(
  junction: WallJunction,
  wallsById: Map<string, WallJoinInput>,
): JunctionArm[] {
  const arms: JunctionArm[] = junction.incident.map(ref => ({
    key: wallEndKey(ref.wall_id, ref.end),
    dir: ref.direction,
    halfThk: ref.half_thickness_m,
  }))

  if (junction.through_wall_id) {
    const through = wallsById.get(junction.through_wall_id)
    if (through) {
      const d = wallDirection(through)
      const halfThk = through.thickness_m / 2
      arms.push({ key: `${through.id}|through+`, dir: d, halfThk })
      arms.push({
        key: `${through.id}|through-`,
        dir: { x: -d.x, y: 0, z: -d.z },
        halfThk,
      })
    }
  }

  return arms.sort((a, b) => armAngle(a) - armAngle(b))
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWallJoinGraph — stages 1-3 + diagnostics
// ─────────────────────────────────────────────────────────────────────────────

interface EndpointRecord {
  wall: WallJoinInput
  end: WallEnd
  point: Vector3
  dir: Vector3
  halfThk: number
}

interface Cluster {
  centroid: Vector3
  members: EndpointRecord[]
}

/**
 * Derive the {@link WallJoinGraph} for a set of walls.
 *
 * Three-stage gap-closing (corners-edges-design §2.5), all non-destructive:
 *   1. Endpoint clustering — endpoints within {@link JOIN_TOLERANCE_M} snap
 *      onto a shared junction at the cluster centroid.
 *   2. Centerline extension — a near-miss pair (gap in the loose band whose
 *      centerlines cross near both ends) is joined at the crossing point.
 *   3. T-junction inference — a still-free end sitting on another wall's
 *      centerline interior becomes a T-junction.
 *
 * Zero-length walls (D3) are excluded entirely. Override-polygon walls still
 * participate as join arms (so neighbours miter against them) but are not
 * themselves mitered (see {@link computeMiteredWallFootprint}).
 */
export function buildWallJoinGraph(
  walls: ReadonlyArray<WallJoinInput>,
): WallJoinGraph {
  const diagnostics: WallJoinDiagnostic[] = []
  const wallsById = new Map<string, WallJoinInput>()
  for (const w of walls) wallsById.set(w.id, w)

  // Only non-degenerate walls take part in the topology (D3 / D4).
  const usable = walls.filter(w => lengthCompute(w) >= EPSILON)

  // Endpoint records — stable iteration order: wall order, then start/end.
  const endpoints: EndpointRecord[] = []
  for (const wall of usable) {
    for (const end of ['start', 'end'] as const) {
      endpoints.push({
        wall,
        end,
        point: endpointOf(wall, end),
        dir: directionInto(wall, end),
        halfThk: wall.thickness_m / 2,
      })
    }
  }

  // ── Duplicate-wall detection (D12) ──────────────────────────────────────
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      const sameWay =
        dist2D(a.start_point, b.start_point) <= JOIN_TOLERANCE_M &&
        dist2D(a.end_point, b.end_point) <= JOIN_TOLERANCE_M
      const flipped =
        dist2D(a.start_point, b.end_point) <= JOIN_TOLERANCE_M &&
        dist2D(a.end_point, b.start_point) <= JOIN_TOLERANCE_M
      if (sameWay || flipped) {
        diagnostics.push({ code: 'WALL_DUPLICATE_SUSPECTED', wall_ids: [a.id, b.id] })
      }
    }
  }

  // ── Stage 1: endpoint clustering ────────────────────────────────────────
  const clusters: Cluster[] = []
  for (const ep of endpoints) {
    const candidates = clusters
      .map(c => ({ c, d: dist2D(c.centroid, ep.point) }))
      .filter(({ d }) => d <= JOIN_TOLERANCE_M)
      .sort((x, y) => x.d - y.d)

    if (candidates.length === 0) {
      clusters.push({ centroid: { ...ep.point }, members: [ep] })
    } else if (
      candidates.length >= 2 &&
      Math.abs(candidates[0].d - candidates[1].d) < EPSILON
    ) {
      // Ambiguous: equidistant to two clusters — never guess (D5).
      diagnostics.push({ code: 'WALL_JOIN_AMBIGUOUS', wall_ids: [ep.wall.id] })
      clusters.push({ centroid: { ...ep.point }, members: [ep] })
    } else {
      const target = candidates[0].c
      target.members.push(ep)
      target.centroid = centroidOf(target.members)
    }
  }

  // ── Build junctions from multi-member clusters ──────────────────────────
  const junctions: WallJunction[] = []
  const byWallEnd = new Map<string, WallJunction>()
  let junctionCounter = 0
  const joinedKeys = new Set<string>()

  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue
    const junction = makeJunction(
      `j${junctionCounter++}`,
      cluster.centroid,
      cluster.members,
    )
    junctions.push(junction)
    for (const ref of junction.incident) {
      const key = wallEndKey(ref.wall_id, ref.end)
      byWallEnd.set(key, junction)
      joinedKeys.add(key)
    }
  }

  const isFree = (ep: EndpointRecord): boolean =>
    !joinedKeys.has(wallEndKey(ep.wall.id, ep.end))

  // ── Stage 2: centerline extension for near-miss pairs ───────────────────
  for (let i = 0; i < endpoints.length; i++) {
    const a = endpoints[i]
    if (!isFree(a)) continue
    for (let j = i + 1; j < endpoints.length; j++) {
      const b = endpoints[j]
      if (b.wall.id === a.wall.id || !isFree(b)) continue
      const gap = dist2D(a.point, b.point)
      if (gap <= JOIN_TOLERANCE_M || gap > JOIN_TOLERANCE_LOOSE_M) continue

      const crossing = intersectHalfLinesXZ(
        a.wall.start_point,
        wallDirection(a.wall),
        b.wall.start_point,
        wallDirection(b.wall),
      )
      if (
        crossing === null ||
        dist2D(crossing, a.point) > JOIN_TOLERANCE_LOOSE_M ||
        dist2D(crossing, b.point) > JOIN_TOLERANCE_LOOSE_M
      ) {
        continue
      }

      const junction = makeJunction(
        `j${junctionCounter++}`,
        { x: crossing.x, y: a.point.y, z: crossing.z },
        [a, b],
      )
      junctions.push(junction)
      for (const ref of junction.incident) {
        const key = wallEndKey(ref.wall_id, ref.end)
        byWallEnd.set(key, junction)
        joinedKeys.add(key)
      }
      break
    }
  }

  // ── Stage 3: T-junction inference for still-free ends ───────────────────
  for (const ep of endpoints) {
    if (!isFree(ep)) continue

    let best: { wall: WallJoinInput; proj: Vector3; perp: number } | null = null
    for (const through of usable) {
      if (through.id === ep.wall.id) continue
      const len = lengthCompute(through)
      const dir = wallDirection(through)
      const along = dot2D(
        { x: ep.point.x - through.start_point.x, y: 0, z: ep.point.z - through.start_point.z },
        dir,
      )
      // Must land on the wall's INTERIOR — endpoints would have clustered.
      if (along < JOIN_TOLERANCE_M || along > len - JOIN_TOLERANCE_M) continue
      const proj: Vector3 = {
        x: through.start_point.x + dir.x * along,
        y: ep.point.y,
        z: through.start_point.z + dir.z * along,
      }
      const perp = dist2D(ep.point, proj)
      if (perp > JOIN_TOLERANCE_M) continue
      if (best === null || perp < best.perp) best = { wall: through, proj, perp }
    }

    if (best !== null) {
      const junction: WallJunction = {
        id: `j${junctionCounter++}`,
        point: best.proj,
        kind: 'T',
        incident: [
          {
            wall_id: ep.wall.id,
            end: ep.end,
            direction: ep.dir,
            half_thickness_m: ep.halfThk,
          },
        ],
        through_wall_id: best.wall.id,
      }
      junctions.push(junction)
      const key = wallEndKey(ep.wall.id, ep.end)
      byWallEnd.set(key, junction)
      joinedKeys.add(key)
    }
  }

  // ── Gap-too-large diagnostics for remaining free-end pairs ──────────────
  for (let i = 0; i < endpoints.length; i++) {
    const a = endpoints[i]
    if (!isFree(a)) continue
    for (let j = i + 1; j < endpoints.length; j++) {
      const b = endpoints[j]
      if (b.wall.id === a.wall.id || !isFree(b)) continue
      const gap = dist2D(a.point, b.point)
      if (gap > JOIN_TOLERANCE_M && gap <= JOIN_TOLERANCE_LOOSE_M) {
        diagnostics.push({
          code: 'WALL_JOIN_GAP_LARGE',
          wall_ids: [a.wall.id, b.wall.id],
        })
      }
    }
  }

  const graph: WallJoinGraph = { junctions, byWallEnd, wallsById, diagnostics }

  // ── D9 pass: walls too short to host their own miters ───────────────────
  for (const wall of usable) {
    if (wall.polygon_override && wall.polygon_override.length > 0) continue
    if (miterFootprint(wall, graph).tooShort) {
      diagnostics.push({ code: 'WALL_TOO_SHORT_FOR_JOIN', wall_ids: [wall.id] })
    }
  }

  return graph
}

/** Arithmetic mean of a cluster's endpoint positions. */
function centroidOf(members: EndpointRecord[]): Vector3 {
  let x = 0
  let y = 0
  let z = 0
  for (const m of members) {
    x += m.point.x
    y += m.point.y
    z += m.point.z
  }
  const n = members.length
  return { x: x / n, y: y / n, z: z / n }
}

/** Build a junction node from a cluster of endpoint records. */
function makeJunction(
  id: string,
  point: Vector3,
  members: EndpointRecord[],
): WallJunction {
  const incident: WallEndRef[] = members
    .map(m => ({
      wall_id: m.wall.id,
      end: m.end,
      direction: m.dir,
      half_thickness_m: m.halfThk,
    }))
    .sort(
      (a, b) =>
        Math.atan2(a.direction.z, a.direction.x) -
        Math.atan2(b.direction.z, b.direction.x),
    )

  const kind: WallJunction['kind'] =
    incident.length >= 4 ? 'X' : incident.length === 3 ? 'T' : 'L'

  return { id, point, kind, incident }
}

// ─────────────────────────────────────────────────────────────────────────────
// computeMiteredWallFootprint
// ─────────────────────────────────────────────────────────────────────────────

/** Internal miter result — adds the D9 `tooShort` signal for the validator. */
interface InternalMiterResult extends MiterResult {
  tooShort: boolean
}

/**
 * Mitered floor footprint of a wall, with both ends adjusted for whatever
 * junctions they sit on. Always returns a 4-point CCW quad — except for
 * zero-length walls (D3), which yield `[]` like `polygonFromWallFootprint`.
 *
 * Robust by construction: any corner whose analytic miter is degenerate
 * (parallel edges D2, acute-angle spike D1) falls back to the plain
 * perpendicular cap. A wall too short to host its miters (D9) falls back
 * fully to its centerline footprint.
 */
export function computeMiteredWallFootprint(
  wall: WallJoinInput,
  graph: WallJoinGraph,
): MiterResult {
  const { footprint, miterDepth } = miterFootprint(wall, graph)
  return { footprint, miterDepth }
}

function miterFootprint(
  wall: WallJoinInput,
  graph: WallJoinGraph,
): InternalMiterResult {
  const base = polygonFromWallFootprint(wall)
  const noMiter: InternalMiterResult = {
    footprint: base,
    miterDepth: { start: 0, end: 0 },
    tooShort: false,
  }

  // Zero-length (D3) → []. Override-polygon walls (D6) → no miter.
  if (base.length < 4) return noMiter
  if (wall.polygon_override && wall.polygon_override.length > 0) return noMiter

  const corners: Vector3[] = base.map(p => ({ ...p }))
  const miterDepth = { start: 0, end: 0 }
  const dir = wallDirection(wall)
  const baseY = wall.base_height_m

  for (const end of ['start', 'end'] as const) {
    const junction = graph.byWallEnd.get(wallEndKey(wall.id, end))
    if (!junction) continue

    const arms = junctionArms(junction, graph.wallsById)
    if (arms.length < 2) continue

    const selfKey = wallEndKey(wall.id, end)
    const selfIndex = arms.findIndex(a => a.key === selfKey)
    if (selfIndex < 0) continue

    const self = arms[selfIndex]
    const prev = arms[(selfIndex - 1 + arms.length) % arms.length]
    const next = arms[(selfIndex + 1) % arms.length]
    const J = junction.point
    const selfPerp = perp2D(self.dir)

    // +perp corner: self's `+perp` edge ∩ prev arm's `-perp` edge.
    const plusCorner = miterCorner(
      { x: J.x + selfPerp.x * self.halfThk, y: baseY, z: J.z + selfPerp.z * self.halfThk },
      self.dir,
      prev,
      -1,
      J,
      Math.max(self.halfThk, prev.halfThk),
    )
    // -perp corner: self's `-perp` edge ∩ next arm's `+perp` edge.
    const minusCorner = miterCorner(
      { x: J.x - selfPerp.x * self.halfThk, y: baseY, z: J.z - selfPerp.z * self.halfThk },
      self.dir,
      next,
      +1,
      J,
      Math.max(self.halfThk, next.halfThk),
    )

    // Map arm-space (+perp / -perp) onto footprint vertex indices.
    //   start end: +perp → [0] outer_start · -perp → [3] inner_start
    //   end   end: +perp → [2] inner_end   · -perp → [1] outer_end
    const plusIndex = end === 'start' ? 0 : 2
    const minusIndex = end === 'start' ? 3 : 1
    if (plusCorner) corners[plusIndex] = { x: plusCorner.x, y: baseY, z: plusCorner.z }
    if (minusCorner) corners[minusIndex] = { x: minusCorner.x, y: baseY, z: minusCorner.z }

    const endpoint = endpointOf(wall, end)
    const dirInto = directionInto(wall, end)
    const depthOf = (c: Vector3 | null): number =>
      c === null
        ? 0
        : Math.max(0, dot2D({ x: c.x - endpoint.x, y: 0, z: c.z - endpoint.z }, dirInto))
    miterDepth[end] = Math.max(depthOf(plusCorner), depthOf(minusCorner))
  }

  // D9: a wall shorter than its combined miter depth produces a flipped /
  // self-intersecting quad. Detect via a non-positive longitudinal face and
  // fall back fully to the perpendicular footprint.
  const outerLen = dot2D({ x: corners[1].x - corners[0].x, y: 0, z: corners[1].z - corners[0].z }, dir)
  const innerLen = dot2D({ x: corners[2].x - corners[3].x, y: 0, z: corners[2].z - corners[3].z }, dir)
  if (outerLen <= EPSILON || innerLen <= EPSILON || signedArea2D(corners) <= EPSILON) {
    return { footprint: base, miterDepth: { start: 0, end: 0 }, tooShort: true }
  }

  return { footprint: corners, miterDepth, tooShort: false }
}

/**
 * One mitered corner: intersect this wall's longitudinal edge with the
 * facing edge of a neighbouring arm. Returns `null` (→ caller keeps the
 * perpendicular cap) when the intersection is degenerate (D2) or shoots past
 * the miter limit (D1).
 *
 * `neighbourSide` picks which of the neighbour's two edges faces this corner:
 * `-1` → its `-perp` edge, `+1` → its `+perp` edge.
 */
function miterCorner(
  selfEdgePoint: Vector3,
  selfDir: Vector3,
  neighbour: JunctionArm,
  neighbourSide: -1 | 1,
  junction: Vector3,
  maxHalfThk: number,
): Vector3 | null {
  const nPerp = perp2D(neighbour.dir)
  const neighbourEdgePoint: Vector3 = {
    x: junction.x + nPerp.x * neighbour.halfThk * neighbourSide,
    y: selfEdgePoint.y,
    z: junction.z + nPerp.z * neighbour.halfThk * neighbourSide,
  }
  const hit = intersectHalfLinesXZ(
    selfEdgePoint,
    selfDir,
    neighbourEdgePoint,
    neighbour.dir,
  )
  if (hit === null) return null
  if (dist2D(hit, junction) > maxHalfThk * MITER_LIMIT_FACTOR) return null
  return hit
}

// ─────────────────────────────────────────────────────────────────────────────
// computeWallFootprintOutline
// ─────────────────────────────────────────────────────────────────────────────

/** Shoelace area of a polygon-clipping ring. */
function ringArea(ring: Ring): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i]
    const [x1, z1] = ring[(i + 1) % ring.length]
    area += x0 * z1 - x1 * z0
  }
  return area / 2
}

/**
 * Union the mitered footprints of every wall into one closed outline — the
 * room's whole wall mass as a single boundary ring plus interior voids.
 *
 * Used by the floorplan (top-down) view and as the robust net behind the
 * walkable-area subtraction: even where the analytic miter is imperfect, the
 * boolean union of the wall quads is always a sound closed outline.
 *
 * Returns the largest-area polygon of the union (V1 = one room); other
 * disjoint pieces are discarded.
 */
export function computeWallFootprintOutline(
  walls: ReadonlyArray<WallJoinInput>,
  graph: WallJoinGraph,
): WallFootprintOutline {
  const polys: Ring[][] = []
  let baseY = 0
  let haveY = false

  for (const wall of walls) {
    const { footprint } = computeMiteredWallFootprint(wall, graph)
    if (footprint.length < 3) continue
    if (!haveY) {
      baseY = footprint[0].y
      haveY = true
    }
    polys.push([footprint.map(p => [p.x, p.z] as [number, number])])
  }

  if (polys.length === 0) return { outer: [], holes: [] }

  const merged: MultiPolygon = polygonClipping.union(polys[0], ...polys.slice(1))
  if (merged.length === 0) return { outer: [], holes: [] }

  // Pick the polygon with the largest outer ring (the room's wall mass).
  let best = merged[0]
  let bestArea = Math.abs(ringArea(merged[0][0]))
  for (let i = 1; i < merged.length; i++) {
    const area = Math.abs(ringArea(merged[i][0]))
    if (area > bestArea) {
      bestArea = area
      best = merged[i]
    }
  }

  const ringTo3D = (ring: Ring): Vector3[] =>
    ring.map(([x, z]) => ({ x, y: baseY, z }))

  const [outer, ...holes] = best
  return {
    outer: outer ? ringTo3D(outer) : [],
    holes: holes.map(ringTo3D),
  }
}
