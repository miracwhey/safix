/**
 * Tests for src/lib/spatial/canonical/geometry/wall-geometry.ts
 */
import { describe, it, expect } from 'vitest'

import {
  centerlineMidpoint,
  innerNormalCompute,
  lengthCompute,
  normalCompute,
  offsetAlongWall,
  polygonFromWall,
  polygonFromWallFootprint,
  projectPointOntoWallPlane,
  type WallGeometryInput,
} from '../../../../../src/lib/spatial/canonical/geometry/wall-geometry.ts'

const TOL = 1e-9

function approx(a: number, b: number, tol = TOL) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
}

function makeWall(overrides: Partial<WallGeometryInput> = {}): WallGeometryInput {
  return {
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    thickness_m: 0.2,
    height_m: 2.5,
    base_height_m: 0,
    ...overrides,
  }
}

describe('geometry/wall · length', () => {
  it('measures a 4 m wall correctly', () => {
    approx(lengthCompute(makeWall()), 4)
  })

  it('measures a diagonal wall using full XYZ distance', () => {
    const wall = makeWall({ end_point: { x: 3, y: 0, z: 4 } })
    approx(lengthCompute(wall), 5)
  })

  it('returns 0 for a degenerate wall', () => {
    const wall = makeWall({ end_point: { x: 0, y: 0, z: 0 } })
    approx(lengthCompute(wall), 0)
  })
})

describe('geometry/wall · normal', () => {
  it('points along +Z for an east-west wall walked west→east', () => {
    // walking +X (east), right side = -Z (south)? Right-hand rule with Y-up:
    // dir = (1,0,0), outward = (dz, 0, -dx) = (0, 0, -1). So outward is -Z.
    const n = normalCompute(makeWall())
    approx(n.x, 0)
    approx(n.z, -1)
  })

  it('inverts when traversing the same wall the other way', () => {
    const wall = makeWall({
      start_point: { x: 4, y: 0, z: 0 },
      end_point: { x: 0, y: 0, z: 0 },
    })
    const n = normalCompute(wall)
    approx(n.x, 0)
    approx(n.z, 1)
  })

  it('innerNormal is the negation of outwardNormal', () => {
    const w = makeWall()
    const outer = normalCompute(w)
    const inner = innerNormalCompute(w)
    approx(outer.x + inner.x, 0)
    approx(outer.z + inner.z, 0)
  })

  it('returns zero vector for a degenerate wall', () => {
    const n = normalCompute(makeWall({ end_point: { x: 0, y: 0, z: 0 } }))
    approx(n.x, 0)
    approx(n.y, 0)
    approx(n.z, 0)
  })
})

describe('geometry/wall · footprint polygon', () => {
  it('produces a 4-vertex CCW rectangle aligned with the centerline', () => {
    const w = makeWall()
    const poly = polygonFromWallFootprint(w)
    expect(poly).toHaveLength(4)
    // First two points should be on the outward side; last two on the inner side.
    const halfThickness = w.thickness_m / 2
    // Outward normal is (0, 0, -1) here, so outer face has z = -halfThickness.
    approx(poly[0].z, -halfThickness)
    approx(poly[1].z, -halfThickness)
    approx(poly[2].z, halfThickness)
    approx(poly[3].z, halfThickness)
  })

  it('extrudes vertically by height in polygonFromWall', () => {
    const w = makeWall()
    const poly = polygonFromWall(w)
    expect(poly).toHaveLength(8)
    // Top 4 vertices should be exactly height_m above the bottom 4.
    for (let i = 0; i < 4; i++) {
      approx(poly[i + 4].y - poly[i].y, w.height_m)
    }
  })

  it('returns [] for a degenerate wall', () => {
    expect(polygonFromWallFootprint(makeWall({ end_point: { x: 0, y: 0, z: 0 } }))).toEqual([])
    expect(polygonFromWall(makeWall({ end_point: { x: 0, y: 0, z: 0 } }))).toEqual([])
  })
})

describe('geometry/wall · projection', () => {
  it('projects a point onto the wall plane with correct signed distance', () => {
    // wall along +X with outward normal (0, 0, -1).
    // Probe sits 1 m along the outward normal → signed distance = +1 by
    // convention "positive on the outer side".
    const w = makeWall()
    const probe = { x: 2, y: 0, z: -1 }
    const { projected, signedDistance } = projectPointOntoWallPlane(w, probe)
    approx(signedDistance, 1)
    approx(projected.x, 2)
    approx(projected.z, 0)
  })

  it('returns zero distance when the point already lies on the centerline', () => {
    const w = makeWall()
    const probe = { x: 1.5, y: 0, z: 0 }
    const { signedDistance } = projectPointOntoWallPlane(w, probe)
    approx(signedDistance, 0)
  })

  it('computes the offset-along-wall for a point in front of the wall', () => {
    const w = makeWall()
    const probe = { x: 3, y: 0, z: 0.5 } // 3 m along the wall, 0.5 m perpendicular
    approx(offsetAlongWall(w, probe), 3)
  })

  it('midpoint is the geometric centre', () => {
    const m = centerlineMidpoint(makeWall())
    approx(m.x, 2)
    approx(m.y, 0)
    approx(m.z, 0)
  })
})
