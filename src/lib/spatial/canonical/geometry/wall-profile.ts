/**
 * Spatial · Canonical · Geometry · Wall Profile
 *
 * Turns a parametric wall + its {@link WallJoinGraph} into the 2D/3D inputs a
 * renderer needs to draw a wall with clean mitered corners, a micro-bevel on
 * the visible vertical edges, and a procedural skirting board.
 *
 * Model (binding · `spatial-zwischen-latte-corners-edges-design.md` §2.3, §3,
 * §4.5): a wall body is its MITERED FOOTPRINT QUAD (XZ floor plane) extruded
 * straight up by `height_m`. That single loft is correct for L/T/X corners
 * and any wall angle — no per-corner special case. Door / window cut-outs
 * are layered on top later (`wallProfileWithOpenings`, A-2 / CSG, A-3); this
 * module produces the opening-free profile + the skirting path.
 *
 * The footprint's two OUTER corners (the freely visible vertical wall edges)
 * carry an optional 1.5 mm micro-bevel — a Mobile anti-aliasing trick that
 * turns a flickering specular edge into a stable highlight (§3.1). Inner
 * corners stay sharp.
 *
 * All functions are pure: no three.js, no DOM, no side-effects.
 */

import { EPSILON, type Vector3 } from '../types/primitives.ts'
import { extrudeProfile, type ProceduralMesh } from './procedural-primitives.ts'
import { lengthCompute } from './wall-geometry.ts'
import {
  computeMiteredWallFootprint,
  type WallJoinGraph,
  type WallJoinInput,
} from './wall-joins.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Micro-bevel on the visible vertical wall edges, in meters (§3.1). */
export const WALL_EDGE_BEVEL_M = 0.0015
/** Bevel chamfer resolution — 2 segments → 3 points per outer corner. */
export const WALL_EDGE_BEVEL_SEGMENTS = 2

/** Skirting board height up the wall, in meters (§3.2). */
export const SKIRTING_HEIGHT_M = 0.06
/** Skirting board depth out from the wall face, in meters (§3.2). */
export const SKIRTING_DEPTH_M = 0.015

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A door / window / unframed opening expressed in wall-local coordinates,
 * ready to be punched into a {@link WallProfileSpec}. Filled by Strang 1
 * (`wallProfileWithOpenings`, A-2); empty on the bare Strang-2 profile.
 */
export interface WallProfileOpening {
  /** Distance from the wall's `start_point` to the opening's left edge. */
  offset_along_wall_m: number
  /** Distance from the floor plane to the opening's bottom edge. */
  offset_from_floor_m: number
  width_m: number
  height_m: number
  kind: 'door' | 'window' | 'opening'
}

/**
 * Everything a renderer needs to build one wall mesh.
 *
 * `footprint` is the mitered floor quad (CCW, 4 points — or 8 once the outer
 * corners are bevelled). Extruding it up by `height_m` yields the wall body.
 */
export interface WallProfileSpec {
  wall_id: string
  /** Mitered footprint outline on the floor plane (XZ), CCW. */
  footprint: Vector3[]
  /** Micro-bevel actually applied to the outer corners (0 = sharp). */
  bevel_m: number
  /** Vertical extrusion height. */
  height_m: number
  /** Floor-plane Y of the footprint. */
  base_height_m: number
  /** Opening cut-outs · empty until Strang 1 fills them. */
  openings: WallProfileOpening[]
}

/** A 2D point in a cross-section frame (X across, Y up). */
export interface ProfilePoint {
  x: number
  y: number
}

/**
 * One run of skirting board along a wall's inner face. `path` is the wall's
 * mitered inner edge (already meeting its neighbours' skirting at corners);
 * `profile` is the board's cross-section, swept along `path` by the renderer.
 */
export interface SkirtingSegment {
  wall_id: string
  /** Inner-face edge of the mitered footprint · `[inner_start, inner_end]`. */
  path: [Vector3, Vector3]
  /** Cross-section · X = depth out from the wall, Y = up from the floor. */
  profile: ProfilePoint[]
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWallProfile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the opening-free {@link WallProfileSpec} for a wall: its mitered
 * footprint (from {@link computeMiteredWallFootprint}) with an optional
 * micro-bevel on the two outer corners.
 *
 * Zero-length walls (D3) and override-polygon walls yield a spec with an
 * empty `footprint` — the renderer falls back to its own handling.
 */
export function buildWallProfile(
  wall: WallJoinInput,
  graph: WallJoinGraph,
  opts?: { bevel_m?: number; bevel_segments?: number },
): WallProfileSpec {
  const { footprint } = computeMiteredWallFootprint(wall, graph)
  const requestedBevel = opts?.bevel_m ?? WALL_EDGE_BEVEL_M
  const segments = Math.max(1, opts?.bevel_segments ?? WALL_EDGE_BEVEL_SEGMENTS)

  if (footprint.length < 4) {
    return {
      wall_id: wall.id,
      footprint: [],
      bevel_m: 0,
      height_m: wall.height_m,
      base_height_m: wall.base_height_m,
      openings: [],
    }
  }

  // Clamp the bevel so it can never eat past half the wall thickness.
  const maxBevel = wall.thickness_m / 2 - EPSILON
  const bevel = Math.min(Math.max(0, requestedBevel), Math.max(0, maxBevel))

  const beveled = bevel > EPSILON ? bevelOuterCorners(footprint, bevel, segments) : footprint

  return {
    wall_id: wall.id,
    footprint: beveled,
    bevel_m: beveled === footprint ? 0 : bevel,
    height_m: wall.height_m,
    base_height_m: wall.base_height_m,
    openings: [],
  }
}

/**
 * Chamfer the two OUTER corners of a 4-point mitered footprint quad
 * `[outer_start, outer_end, inner_end, inner_start]`. Each outer corner is
 * replaced by a `segments`-segment quadratic-Bezier chamfer (control point at
 * the original corner), so a 4-point quad becomes an 8-point ring at the
 * default 2-segment resolution. Inner corners stay sharp (§3.1).
 */
function bevelOuterCorners(
  quad: Vector3[],
  bevel: number,
  segments: number,
): Vector3[] {
  const outerStart = chamferCorner(quad[3], quad[0], quad[1], bevel, segments)
  const outerEnd = chamferCorner(quad[0], quad[1], quad[2], bevel, segments)
  // Keep CCW order: ...outer_start chamfer, outer_end chamfer, inner_end, inner_start.
  return [...outerStart, ...outerEnd, quad[2], quad[3]]
}

/**
 * Quadratic-Bezier chamfer of corner `c` between neighbours `prev` and
 * `next`. Returns `segments + 1` points; falls back to the sharp corner when
 * an adjacent edge is too short to host the bevel.
 */
function chamferCorner(
  prev: Vector3,
  c: Vector3,
  next: Vector3,
  bevel: number,
  segments: number,
): Vector3[] {
  const toPrev = unit(prev.x - c.x, prev.z - c.z)
  const toNext = unit(next.x - c.x, next.z - c.z)
  const prevLen = Math.hypot(prev.x - c.x, prev.z - c.z)
  const nextLen = Math.hypot(next.x - c.x, next.z - c.z)
  const d = Math.min(bevel, prevLen / 2, nextLen / 2)
  if (d <= EPSILON) return [{ ...c }]

  const insetPrev: Vector3 = { x: c.x + toPrev.x * d, y: c.y, z: c.z + toPrev.z * d }
  const insetNext: Vector3 = { x: c.x + toNext.x * d, y: c.y, z: c.z + toNext.z * d }

  const points: Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const mt = 1 - t
    // B(t) = (1-t)²·insetPrev + 2(1-t)t·c + t²·insetNext
    points.push({
      x: mt * mt * insetPrev.x + 2 * mt * t * c.x + t * t * insetNext.x,
      y: c.y,
      z: mt * mt * insetPrev.z + 2 * mt * t * c.z + t * t * insetNext.z,
    })
  }
  return points
}

function unit(x: number, z: number): Vector3 {
  const len = Math.hypot(x, z)
  if (len < EPSILON) return { x: 0, y: 0, z: 0 }
  return { x: x / len, y: 0, z: z / len }
}

// ─────────────────────────────────────────────────────────────────────────────
// extrudeWallProfile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrude a {@link WallProfileSpec} into the wall body mesh — the footprint
 * lofted straight up by `height_m`. Opening cut-outs are NOT applied here
 * (CSG / face tessellation handle those downstream); a wall with no openings
 * is fully described by this mesh.
 *
 * Returns an empty mesh for a spec with no footprint (zero-length / override
 * wall).
 */
export function extrudeWallProfile(spec: WallProfileSpec): ProceduralMesh {
  if (spec.footprint.length < 3) {
    return { positions: [], normals: [], uvs: [], indices: [] }
  }
  return extrudeProfile(spec.footprint, spec.height_m)
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSkirtingPath
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-section of the skirting board — X = depth out from the wall face,
 * Y = up from the floor. A simple board with a chamfered top edge.
 */
function skirtingProfile(): ProfilePoint[] {
  // Top chamfer = a quarter of the board height.
  const chamfer = SKIRTING_HEIGHT_M / 4
  return [
    { x: 0, y: 0 },
    { x: SKIRTING_DEPTH_M, y: 0 },
    { x: SKIRTING_DEPTH_M, y: SKIRTING_HEIGHT_M - chamfer },
    { x: 0, y: SKIRTING_HEIGHT_M },
  ]
}

/**
 * Build the skirting-board run for every wall in the room.
 *
 * Each run follows the wall's mitered INNER edge — so adjacent walls' runs
 * already meet cleanly at the corners (the miter graph does the work, there
 * is no second miter solver, §3.2 / R8). Zero-length and override walls are
 * skipped.
 */
export function buildSkirtingPath(
  walls: ReadonlyArray<WallJoinInput>,
  graph: WallJoinGraph,
): SkirtingSegment[] {
  const profile = skirtingProfile()
  const segments: SkirtingSegment[] = []

  for (const wall of walls) {
    if (lengthCompute(wall) < EPSILON) continue
    if (wall.polygon_override && wall.polygon_override.length > 0) continue
    const { footprint } = computeMiteredWallFootprint(wall, graph)
    if (footprint.length < 4) continue
    // Footprint order: [0] outer_start [1] outer_end [2] inner_end [3] inner_start.
    segments.push({
      wall_id: wall.id,
      path: [{ ...footprint[3] }, { ...footprint[2] }],
      profile,
    })
  }

  return segments
}
