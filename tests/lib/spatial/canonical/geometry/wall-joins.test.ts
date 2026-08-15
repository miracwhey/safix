/**
 * Tests for src/lib/spatial/canonical/geometry/wall-joins.ts
 *
 * Covers the corner-join core: the cyclic angle-bisector miter, the
 * three-stage scan-tolerance gap-closing, and every degenerate case
 * D1-D12 from `spatial-zwischen-latte-corners-edges-design.md` §2.6.
 */
import { describe, it, expect } from 'vitest'

import {
  ANGLE_EPSILON,
  buildWallJoinGraph,
  computeMiteredWallFootprint,
  intersectHalfLinesXZ,
  type WallJoinInput,
} from '../../../../../src/lib/spatial/canonical/geometry/wall-joins.ts'
import { polygonFromWallFootprint } from '../../../../../src/lib/spatial/canonical/geometry/wall-geometry.ts'
import type { Vector3 } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

const TOL = 1e-6

function approx(a: number, b: number, tol = TOL): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
}

function approxPoint(p: Vector3, x: number, z: number, tol = TOL): void {
  approx(p.x, x, tol)
  approx(p.z, z, tol)
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

/** Shoelace signed area on XZ — positive when CCW from above. */
function signedArea(ring: Vector3[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area += a.x * b.z - b.x * a.z
  }
  return area / 2
}

function allFinite(ring: Vector3[]): boolean {
  return ring.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
}

// ─────────────────────────────────────────────────────────────────────────────
// intersectHalfLinesXZ
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · intersectHalfLinesXZ', () => {
  it('intersects two perpendicular lines', () => {
    const hit = intersectHalfLinesXZ(
      { x: 0, y: 0, z: 5 }, { x: 1, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 1 },
    )
    expect(hit).not.toBeNull()
    approxPoint(hit as Vector3, 3, 5)
  })

  it('returns null for parallel lines (D2)', () => {
    const hit = intersectHalfLinesXZ(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
    )
    expect(hit).toBeNull()
  })

  it('returns null for collinear lines (D2 · ~180°)', () => {
    const hit = intersectHalfLinesXZ(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 }, { x: -1, y: 0, z: ANGLE_EPSILON / 10 },
    )
    expect(hit).toBeNull()
  })

  it('copies y from the first support point', () => {
    const hit = intersectHalfLinesXZ(
      { x: 0, y: 1.7, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: -3 }, { x: 0, y: 0, z: 1 },
    )
    approx((hit as Vector3).y, 1.7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L-junction miter
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · L-junction miter', () => {
  it('90° equal thickness → corner exactly on the diagonal', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [0, 4])
    const graph = buildWallJoinGraph([a, b])

    expect(graph.junctions).toHaveLength(1)
    expect(graph.junctions[0].kind).toBe('L')

    const fp = computeMiteredWallFootprint(a, graph).footprint
    expect(fp).toHaveLength(4)
    // [0] outer_start mitered out, [3] inner_start pulled in.
    approxPoint(fp[0], -0.1, -0.1)
    approxPoint(fp[3], 0.1, 0.1)
    // Free end stays a square cap.
    approxPoint(fp[1], 4, -0.1)
    approxPoint(fp[2], 4, 0.1)
  })

  it('both walls share the mitered diagonal edge', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [0, 4])
    const graph = buildWallJoinGraph([a, b])
    const fa = computeMiteredWallFootprint(a, graph).footprint
    const fb = computeMiteredWallFootprint(b, graph).footprint
    // a's outer_start == b's inner_start; a's inner_start == b's outer_start.
    approxPoint(fa[0], fb[3].x, fb[3].z)
    approxPoint(fa[3], fb[0].x, fb[0].z)
  })

  it('90° UNEQUAL thickness → asymmetric miter (step on the outer face)', () => {
    const a = makeWall('a', [0, 0], [4, 0], { thickness_m: 0.1 })
    const b = makeWall('b', [0, 0], [0, 4], { thickness_m: 0.2 })
    const graph = buildWallJoinGraph([a, b])
    const fp = computeMiteredWallFootprint(a, graph).footprint
    // a's outer face reaches b's outer face line at x = -0.1 (b's half).
    approxPoint(fp[0], -0.1, -0.05)
    approxPoint(fp[3], 0.1, 0.05)
  })

  it('45° acute angle → long miter, still within the limit', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [4, 4]) // 45°
    const graph = buildWallJoinGraph([a, b])
    const fp = computeMiteredWallFootprint(a, graph).footprint
    expect(fp).toHaveLength(4)
    expect(allFinite(fp)).toBe(true)
    expect(signedArea(fp)).toBeGreaterThan(0)
  })

  it('135° obtuse angle → shallow miter', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [-4, 4]) // 135°
    const graph = buildWallJoinGraph([a, b])
    const fp = computeMiteredWallFootprint(a, graph).footprint
    expect(fp).toHaveLength(4)
    expect(allFinite(fp)).toBe(true)
    expect(signedArea(fp)).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-junction & X-junction
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · T-junction (D11)', () => {
  it('stem end caps flush against the through-wall face', () => {
    const through = makeWall('through', [-2, 2], [2, 2])
    const stem = makeWall('stem', [0, 0], [0, 1.9]) // ends 0.1 m short of z=2
    const graph = buildWallJoinGraph([through, stem])

    const t = graph.junctions.find(j => j.kind === 'T')
    expect(t).toBeDefined()
    expect(t?.through_wall_id).toBe('through')

    const fp = computeMiteredWallFootprint(stem, graph).footprint
    // stem's end corners ([1] outer_end, [2] inner_end) sit on z = 1.9
    // (through-wall near face: centerline z=2 minus half thickness 0.1).
    approx(fp[1].z, 1.9)
    approx(fp[2].z, 1.9)
  })

  it('through-wall itself is not mitered', () => {
    const through = makeWall('through', [-2, 2], [2, 2])
    const stem = makeWall('stem', [0, 0], [0, 1.9])
    const graph = buildWallJoinGraph([through, stem])
    const fp = computeMiteredWallFootprint(through, graph).footprint
    // Identical to the plain centerline footprint — no end touched.
    const plain = polygonFromWallFootprint(through)
    fp.forEach((p, i) => approxPoint(p, plain[i].x, plain[i].z))
  })
})

describe('wall-joins · X-junction (D10)', () => {
  it('4 axis-aligned walls → one X junction, clean perpendicular caps', () => {
    const east = makeWall('east', [0, 0], [4, 0])
    const west = makeWall('west', [0, 0], [-4, 0])
    const north = makeWall('north', [0, 0], [0, 4])
    const south = makeWall('south', [0, 0], [0, -4])
    const graph = buildWallJoinGraph([east, west, north, south])

    expect(graph.junctions).toHaveLength(1)
    expect(graph.junctions[0].kind).toBe('X')
    expect(graph.junctions[0].incident).toHaveLength(4)

    // East wall's start cap is a straight vertical line at x = 0.1.
    const fp = computeMiteredWallFootprint(east, graph).footprint
    approx(fp[0].x, 0.1)
    approx(fp[3].x, 0.1)
    expect(signedArea(fp)).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scan tolerance — clustering, gap closing, T-inference
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · scan tolerance', () => {
  it('4 cm gap → one shared junction cluster', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0.04, 0], [0.04, 4]) // 4 cm off
    const graph = buildWallJoinGraph([a, b])
    expect(graph.junctions).toHaveLength(1)
    expect(graph.junctions[0].incident).toHaveLength(2)
    // Junction sits at the centroid of the two endpoints.
    approx(graph.junctions[0].point.x, 0.02)
  })

  it('8 cm gap with a small angle error → still joined', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0.08, 0.02], [0.3, 4])
    const graph = buildWallJoinGraph([a, b])
    expect(graph.junctions).toHaveLength(1)
  })

  it('20 cm gap in a straight run → NOT joined, WALL_JOIN_GAP_LARGE', () => {
    // Two collinear segments — centerline extension cannot resolve a unique
    // crossing, so the loose-band gap stays open and is flagged.
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [4.2, 0], [8, 0])
    const graph = buildWallJoinGraph([a, b])
    expect(graph.junctions).toHaveLength(0)
    expect(graph.diagnostics.some(d => d.code === 'WALL_JOIN_GAP_LARGE')).toBe(true)
  })

  it('near-miss in the loose band → centerline-extension join', () => {
    // a ends at x=3.8, b starts at x=4.0 on the same centerline-cross point.
    const a = makeWall('a', [0, 0], [3.8, 0])
    const b = makeWall('b', [4.0, 0], [4.0, 4])
    const graph = buildWallJoinGraph([a, b])
    expect(graph.junctions).toHaveLength(1)
    expect(graph.byWallEnd.has('a|end')).toBe(true)
    expect(graph.byWallEnd.has('b|start')).toBe(true)
  })

  it('endpoint 5 cm off a foreign centerline → inferred T-junction', () => {
    const through = makeWall('through', [-3, 2], [3, 2])
    const stem = makeWall('stem', [0, 0], [0, 1.95]) // 5 cm short of z=2
    const graph = buildWallJoinGraph([through, stem])
    const t = graph.junctions.find(j => j.kind === 'T')
    expect(t).toBeDefined()
    expect(t?.through_wall_id).toBe('through')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Degenerate cases D1-D12
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · degenerate cases', () => {
  it('D1 · 8° spike → miter clamped, footprint stays finite + CCW', () => {
    const rad = (8 * Math.PI) / 180
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [4 * Math.cos(rad), 4 * Math.sin(rad)])
    const graph = buildWallJoinGraph([a, b])
    const fp = computeMiteredWallFootprint(a, graph).footprint
    expect(fp).toHaveLength(4)
    expect(allFinite(fp)).toBe(true)
    expect(signedArea(fp)).toBeGreaterThan(0)
  })

  it('D3 · zero-length wall → excluded from the graph, empty footprint', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const zero = makeWall('zero', [0, 0], [0, 0])
    const graph = buildWallJoinGraph([a, zero])
    expect(computeMiteredWallFootprint(zero, graph).footprint).toEqual([])
  })

  it('D4 · zero-length wall at a real cluster does not break the junction', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [0, 4])
    const zero = makeWall('zero', [0, 0], [0, 0])
    const graph = buildWallJoinGraph([a, b, zero])
    expect(graph.junctions).toHaveLength(1)
    expect(graph.junctions[0].incident).toHaveLength(2)
  })

  it('D5 · endpoint equidistant to two clusters → WALL_JOIN_AMBIGUOUS, not joined', () => {
    // Two separate junctions, then a wall whose end is exactly between them.
    const a = makeWall('a', [0, 0], [0, 4])
    const b = makeWall('b', [0, 0], [-4, 0])
    const c = makeWall('c', [0.2, 0], [0.2, 4])
    const d = makeWall('d', [0.2, 0], [4, 0])
    // e's start is at x=0.1 — equidistant (0.1) to the cluster at x=0 and x=0.2.
    const e = makeWall('e', [0.1, -0.0001], [0.1, -4])
    const graph = buildWallJoinGraph([a, b, c, d, e])
    expect(graph.diagnostics.some(x => x.code === 'WALL_JOIN_AMBIGUOUS')).toBe(true)
  })

  it('D6 · polygon_override wall → miter skipped, no throw', () => {
    const a = makeWall('a', [0, 0], [4, 0], {
      polygon_override: [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 4, y: 3, z: 0 },
      ],
    })
    const b = makeWall('b', [0, 0], [0, 4])
    const graph = buildWallJoinGraph([a, b])
    expect(() => computeMiteredWallFootprint(a, graph)).not.toThrow()
    const fp = computeMiteredWallFootprint(a, graph).footprint
    // Override wall keeps its plain centerline footprint.
    const plain = polygonFromWallFootprint(a)
    fp.forEach((p, i) => approxPoint(p, plain[i].x, plain[i].z))
  })

  it('D8 · open wall run → free ends keep square caps, no crash', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const graph = buildWallJoinGraph([a])
    expect(graph.junctions).toHaveLength(0)
    const fp = computeMiteredWallFootprint(a, graph).footprint
    fp.forEach((p, i) => approxPoint(p, polygonFromWallFootprint(a)[i].x, polygonFromWallFootprint(a)[i].z))
  })

  it('D9 · wall too short for its miters → WALL_TOO_SHORT_FOR_JOIN, safe footprint', () => {
    // 5 cm wall between two perpendicular walls — miters would self-cross.
    const m = makeWall('m', [1, 0], [1.05, 0], { thickness_m: 0.3 })
    const p = makeWall('p', [1, 0], [1, -3], { thickness_m: 0.3 })
    const q = makeWall('q', [1.05, 0], [1.05, -3], { thickness_m: 0.3 })
    const graph = buildWallJoinGraph([m, p, q])
    expect(graph.diagnostics.some(d => d.code === 'WALL_TOO_SHORT_FOR_JOIN')).toBe(true)
    const fp = computeMiteredWallFootprint(m, graph).footprint
    expect(fp).toHaveLength(4)
    expect(allFinite(fp)).toBe(true)
    // Falls back to the plain footprint — never a self-intersecting quad.
    expect(signedArea(fp)).toBeGreaterThan(0)
  })

  it('D12 · duplicate walls → WALL_DUPLICATE_SUSPECTED', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const dup = makeWall('dup', [4, 0], [0, 0]) // same centerline, reversed
    const graph = buildWallJoinGraph([a, dup])
    expect(graph.diagnostics.some(d => d.code === 'WALL_DUPLICATE_SUSPECTED')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariants & regression
// ─────────────────────────────────────────────────────────────────────────────

describe('wall-joins · invariants', () => {
  it('mitered footprint is always 4 points, CCW and finite for a closed room', () => {
    // Square room, 4 walls, CCW.
    const walls = [
      makeWall('w0', [0, 0], [4, 0]),
      makeWall('w1', [4, 0], [4, 4]),
      makeWall('w2', [4, 4], [0, 4]),
      makeWall('w3', [0, 4], [0, 0]),
    ]
    const graph = buildWallJoinGraph(walls)
    expect(graph.junctions).toHaveLength(4)
    for (const w of walls) {
      const fp = computeMiteredWallFootprint(w, graph).footprint
      expect(fp).toHaveLength(4)
      expect(allFinite(fp)).toBe(true)
      expect(signedArea(fp)).toBeGreaterThan(0)
    }
  })

  it('miterDepth is reported per end and non-negative', () => {
    const a = makeWall('a', [0, 0], [4, 0])
    const b = makeWall('b', [0, 0], [0, 4])
    const graph = buildWallJoinGraph([a, b])
    const { miterDepth } = computeMiteredWallFootprint(a, graph)
    expect(miterDepth.start).toBeGreaterThan(0)
    expect(miterDepth.end).toBe(0) // free end
  })

  it('regression · a free wall with no neighbours == polygonFromWallFootprint', () => {
    const a = makeWall('a', [1, 1], [5, 3])
    const graph = buildWallJoinGraph([a])
    const fp = computeMiteredWallFootprint(a, graph).footprint
    const plain = polygonFromWallFootprint(a)
    fp.forEach((p, i) => {
      approx(p.x, plain[i].x)
      approx(p.z, plain[i].z)
    })
  })

  it('graph build is deterministic', () => {
    const walls = [
      makeWall('w0', [0, 0], [4, 0]),
      makeWall('w1', [4, 0], [4, 4]),
      makeWall('w2', [4, 4], [0, 4]),
      makeWall('w3', [0, 4], [0, 0]),
    ]
    const g1 = buildWallJoinGraph(walls)
    const g2 = buildWallJoinGraph(walls)
    expect(g1.junctions.map(j => j.id)).toEqual(g2.junctions.map(j => j.id))
    expect(g1.junctions.map(j => j.point.x)).toEqual(g2.junctions.map(j => j.point.x))
  })
})
