/**
 * Tests for src/lib/spatial/canonical/geometry/wall-profile.ts
 * + the generic `extrudeProfile` primitive it builds on.
 */
import { describe, it, expect } from 'vitest'

import {
  SKIRTING_HEIGHT_M,
  WALL_EDGE_BEVEL_M,
  buildSkirtingPath,
  buildWallProfile,
  extrudeWallProfile,
} from '../../../../../src/lib/spatial/canonical/geometry/wall-profile.ts'
import {
  buildWallJoinGraph,
  computeWallFootprintOutline,
  type WallJoinInput,
} from '../../../../../src/lib/spatial/canonical/geometry/wall-joins.ts'
import {
  computeMeshBounds,
  extrudeProfile,
  triangleCount,
} from '../../../../../src/lib/spatial/canonical/geometry/procedural-primitives.ts'
import type { Vector3 } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

const TOL = 1e-6

function approx(a: number, b: number, tol = TOL): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
}

function makeWall(
  id: string,
  start: [number, number],
  end: [number, number],
  overrides: Partial<WallJoinInput> = {},
): WallJoinInput {
  return {
    id,
    start_point: { x: start[0], y: 0, z: start[1] },
    end_point: { x: end[0], y: 0, z: end[1] },
    thickness_m: 0.2,
    height_m: 2.5,
    base_height_m: 0,
    ...overrides,
  }
}

/** Closed CCW square room of 4 walls. */
function squareRoom(): WallJoinInput[] {
  return [
    makeWall('w0', [0, 0], [4, 0]),
    makeWall('w1', [4, 0], [4, 4]),
    makeWall('w2', [4, 4], [0, 4]),
    makeWall('w3', [0, 4], [0, 0]),
  ]
}

function signedArea(ring: Vector3[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area += a.x * b.z - b.x * a.z
  }
  return area / 2
}

// ─────────────────────────────────────────────────────────────────────────────
// extrudeProfile primitive
// ─────────────────────────────────────────────────────────────────────────────

describe('procedural · extrudeProfile', () => {
  const square: Vector3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
  ]

  it('extrudes a square into a watertight prism', () => {
    const mesh = extrudeProfile(square, 2)
    // 4 bottom + 4 top + 4 edges × 4 = 24 vertices.
    expect(mesh.positions).toHaveLength(24 * 3)
    // 2 bottom + 2 top + 4 edges × 2 = 12 triangles.
    expect(triangleCount(mesh)).toBe(12)
  })

  it('places the prism between y and y + height', () => {
    const mesh = extrudeProfile(square, 2)
    const b = computeMeshBounds(mesh)
    approx(b.min.y, 0)
    approx(b.max.y, 2)
    approx(b.min.x, 0)
    approx(b.max.x, 1)
  })

  it('returns an empty mesh for a degenerate ring', () => {
    expect(extrudeProfile([{ x: 0, y: 0, z: 0 }], 2).positions).toHaveLength(0)
  })

  it('all normals are unit length', () => {
    const mesh = extrudeProfile(square, 2)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      approx(
        Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]),
        1,
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildWallProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-profile · buildWallProfile', () => {
  it('without bevel → 4-point mitered footprint', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const spec = buildWallProfile(walls[0], graph, { bevel_m: 0 })
    expect(spec.footprint).toHaveLength(4)
    expect(spec.bevel_m).toBe(0)
    expect(spec.height_m).toBe(2.5)
    expect(spec.openings).toEqual([])
  })

  it('with bevel → 8-point footprint (2-segment chamfer per outer corner)', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const spec = buildWallProfile(walls[0], graph, { bevel_m: WALL_EDGE_BEVEL_M })
    expect(spec.footprint).toHaveLength(8)
    expect(spec.bevel_m).toBeCloseTo(WALL_EDGE_BEVEL_M, 9)
    // Footprint stays CCW + finite.
    expect(signedArea(spec.footprint)).toBeGreaterThan(0)
    expect(spec.footprint.every(p => Number.isFinite(p.x) && Number.isFinite(p.z))).toBe(true)
  })

  it('clamps an oversized bevel to half the wall thickness', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const spec = buildWallProfile(walls[0], graph, { bevel_m: 5 })
    expect(spec.bevel_m).toBeLessThanOrEqual(walls[0].thickness_m / 2)
    expect(spec.bevel_m).toBeGreaterThan(0)
  })

  it('zero-length wall → empty footprint spec', () => {
    const zero = makeWall('zero', [1, 1], [1, 1])
    const graph = buildWallJoinGraph([zero])
    const spec = buildWallProfile(zero, graph)
    expect(spec.footprint).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extrudeWallProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-profile · extrudeWallProfile', () => {
  it('extrudes the wall body to the full height', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const spec = buildWallProfile(walls[0], graph)
    const mesh = extrudeWallProfile(spec)
    const b = computeMeshBounds(mesh)
    approx(b.max.y - b.min.y, 2.5)
    expect(mesh.positions.length).toBeGreaterThan(0)
  })

  it('empty spec → empty mesh', () => {
    const zero = makeWall('zero', [1, 1], [1, 1])
    const graph = buildWallJoinGraph([zero])
    const mesh = extrudeWallProfile(buildWallProfile(zero, graph))
    expect(mesh.positions).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildSkirtingPath
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-profile · buildSkirtingPath', () => {
  it('one mitered segment per wall in a closed room', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const segments = buildSkirtingPath(walls, graph)
    expect(segments).toHaveLength(4)
    for (const seg of segments) {
      expect(seg.path).toHaveLength(2)
      expect(seg.profile.length).toBeGreaterThanOrEqual(3)
      expect(seg.profile.some(p => p.y >= SKIRTING_HEIGHT_M - 1e-9)).toBe(true)
    }
  })

  it('adjacent skirting runs meet at the shared mitered corner', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const segments = buildSkirtingPath(walls, graph)
    // w0's inner_end == w1's inner_start (same mitered corner point).
    const w0 = segments.find(s => s.wall_id === 'w0')!
    const w1 = segments.find(s => s.wall_id === 'w1')!
    approx(w0.path[1].x, w1.path[0].x)
    approx(w0.path[1].z, w1.path[0].z)
  })

  it('skips zero-length and override walls', () => {
    const walls: WallJoinInput[] = [
      makeWall('w0', [0, 0], [4, 0]),
      makeWall('zero', [9, 9], [9, 9]),
      makeWall('override', [0, 0], [0, 4], {
        polygon_override: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 4 },
          { x: 0, y: 3, z: 2 },
        ],
      }),
    ]
    const graph = buildWallJoinGraph(walls)
    const segments = buildSkirtingPath(walls, graph)
    expect(segments.map(s => s.wall_id)).toEqual(['w0'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeWallFootprintOutline
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · computeWallFootprintOutline', () => {
  it('closed room → one outline with an interior void', () => {
    const walls = squareRoom()
    const graph = buildWallJoinGraph(walls)
    const outline = computeWallFootprintOutline(walls, graph)
    expect(outline.outer.length).toBeGreaterThanOrEqual(4)
    // A picture-frame of walls leaves the room cavity as a hole.
    expect(outline.holes.length).toBeGreaterThanOrEqual(1)
    // Outer ring spans the full 4×4 room footprint (± half thickness).
    const xs = outline.outer.map(p => p.x)
    approx(Math.min(...xs), -0.1)
    approx(Math.max(...xs), 4.1)
  })

  it('no walls → empty outline', () => {
    const graph = buildWallJoinGraph([])
    expect(computeWallFootprintOutline([], graph)).toEqual({ outer: [], holes: [] })
  })
})
