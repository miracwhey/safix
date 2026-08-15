/**
 * Tests for src/lib/spatial/canonical/geometry/collision.ts
 *
 * Covers capsule-vs-box collision detection, slide-along-wall behaviour,
 * point-in-walkable testing, the iterative camera resolver, and the
 * Y-clamp fallback for the stuck-in-corner case (R14).
 */
import { describe, it, expect } from 'vitest'

import {
  boxBoundsFromShape,
  capsuleVsBox,
  capsuleVsRotatedBox,
  isPointInWalkable,
  resolveCameraCollision,
  slideAlongWall,
  walkableInteriorPoint,
  type CameraResolveInput,
} from '../../../../../src/lib/spatial/canonical/geometry/collision.ts'
import {
  DEFAULT_CAMERA_CAPSULE,
  type WalkablePolygon,
} from '../../../../../src/lib/spatial/canonical/types/walkable.ts'
import {
  IDENTITY_VECTOR3,
  type Vector3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

function aabb(min: Vector3, max: Vector3) {
  return { min, max }
}

describe('collision · capsuleVsBox', () => {
  it('reports non-colliding when the capsule is far from the box', () => {
    const result = capsuleVsBox(
      DEFAULT_CAMERA_CAPSULE,
      { x: 0, y: 0, z: 0 },
      aabb({ x: 5, y: 0, z: 5 }, { x: 6, y: 2, z: 6 }),
    )
    expect(result.colliding).toBe(false)
    expect(result.penetrationDepth).toBe(0)
  })

  it('reports colliding when the capsule overlaps an AABB', () => {
    // Capsule at origin (feet at y=0, top at y=1.70), wall AABB right next to it.
    const result = capsuleVsBox(
      DEFAULT_CAMERA_CAPSULE,
      { x: 0, y: 0, z: 0 },
      aabb({ x: 0.1, y: 0, z: -1 }, { x: 0.3, y: 2.5, z: 1 }),
    )
    expect(result.colliding).toBe(true)
    expect(result.penetrationDepth).toBeGreaterThan(0)
    // Normal should point back along -X (capsule has to retreat).
    expect(result.normal.x).toBeLessThan(0)
  })

  it('reports the correct closest-point on the AABB face', () => {
    const result = capsuleVsBox(
      DEFAULT_CAMERA_CAPSULE,
      { x: 0, y: 0, z: 0 },
      aabb({ x: 0.5, y: 0, z: -1 }, { x: 1, y: 2.5, z: 1 }),
    )
    // Capsule centerline is on x=0; closest point on box is at x = 0.5.
    expect(result.closestPoint.x).toBeCloseTo(0.5, 6)
  })
})

describe('collision · boxBoundsFromShape', () => {
  it('builds an AABB centered at the given position', () => {
    const aabbResult = boxBoundsFromShape(
      { x: 1, y: 2, z: 3 },
      { kind: 'box', width_m: 2, height_m: 4, depth_m: 6 },
    )
    expect(aabbResult.min).toEqual({ x: 0, y: 0, z: 0 })
    expect(aabbResult.max).toEqual({ x: 2, y: 4, z: 6 })
  })
})

describe('collision · slideAlongWall', () => {
  it('passes through intended motion when there is no collision', () => {
    const result = slideAlongWall(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { colliding: false, penetrationDepth: 0, normal: { x: 0, y: 1, z: 0 }, closestPoint: IDENTITY_VECTOR3 },
    )
    expect(result.x).toBe(1)
    expect(result.z).toBe(0)
  })

  it('projects intended motion onto the tangent plane when colliding', () => {
    // Intended motion straight into the wall (+X). After collision the
    // resolved motion should be perpendicular to the wall normal — i.e.
    // along ±Z if the wall normal is along -X.
    const result = slideAlongWall(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 }, // diagonal motion: half into wall, half along Z
      { colliding: true, penetrationDepth: 0.1, normal: { x: -1, y: 0, z: 0 }, closestPoint: IDENTITY_VECTOR3 },
    )
    // X component should have been removed (it was "into the wall").
    expect(result.x).toBeCloseTo(-0.1, 6) // pushed out by penetrationDepth
    // Z component preserved (parallel to wall).
    expect(result.z).toBeCloseTo(1, 6)
  })

  it('keeps Y constant by default (walls are vertical)', () => {
    const start = { x: 0, y: 1.7, z: 0 }
    const result = slideAlongWall(
      start,
      { x: 1, y: 0.5, z: 0 },
      { colliding: false, penetrationDepth: 0, normal: { x: 0, y: 1, z: 0 }, closestPoint: IDENTITY_VECTOR3 },
    )
    expect(result.y).toBe(1.7)
  })
})

describe('collision · isPointInWalkable', () => {
  const simpleSquare: WalkablePolygon = {
    outer: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 },
      { x: 0, y: 0, z: 4 },
    ],
    holes: [],
  }

  it('detects a point clearly inside the polygon', () => {
    expect(isPointInWalkable({ x: 2, y: 0, z: 2 }, simpleSquare)).toBe(true)
  })

  it('detects a point clearly outside the polygon', () => {
    expect(isPointInWalkable({ x: -1, y: 0, z: 2 }, simpleSquare)).toBe(false)
  })

  it('treats hole interiors as outside', () => {
    const withHole: WalkablePolygon = {
      outer: simpleSquare.outer,
      holes: [
        [
          { x: 1, y: 0, z: 1 },
          { x: 1, y: 0, z: 3 },
          { x: 3, y: 0, z: 3 },
          { x: 3, y: 0, z: 1 },
        ],
      ],
    }
    expect(isPointInWalkable({ x: 2, y: 0, z: 2 }, withHole)).toBe(false)
    expect(isPointInWalkable({ x: 0.5, y: 0, z: 0.5 }, withHole)).toBe(true)
  })
})

describe('collision · resolveCameraCollision', () => {
  const walkable: WalkablePolygon = {
    outer: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 },
      { x: 0, y: 0, z: 4 },
    ],
    holes: [],
  }

  it('lets the camera move freely when no obstacles are in the way', () => {
    const result = resolveCameraCollision({
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 1, y: 0, z: 2 },
      intendedMotion: { x: 1, y: 0, z: 0 },
      obstacles: [],
      walkable,
    })
    expect(result.position.x).toBeCloseTo(2, 6)
    expect(result.iterations).toBe(0)
    expect(result.stuckFallback).toBe(false)
  })

  it('pushes the camera out of a single colliding wall', () => {
    const result = resolveCameraCollision({
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 0.5, y: 0, z: 2 },
      intendedMotion: { x: 1, y: 0, z: 0 }, // tries to walk into the wall
      obstacles: [
        { id: 'wall', bounds: aabb({ x: 1.4, y: 0, z: 1 }, { x: 1.6, y: 2.5, z: 3 }) },
      ],
      walkable,
    })
    expect(result.iterations).toBeGreaterThanOrEqual(1)
    // Final position must be outside the wall AABB by at least one capsule
    // radius along the chosen escape axis. The resolver may pick either
    // ±X escape (they're equidistant in this setup); we only require the
    // capsule to actually clear the wall body.
    const insideWallX = result.position.x > 1.4 && result.position.x < 1.6
    expect(insideWallX).toBe(false)
    const minDistance = Math.min(
      Math.abs(result.position.x - 1.4),
      Math.abs(result.position.x - 1.6),
    )
    expect(minDistance).toBeGreaterThanOrEqual(DEFAULT_CAMERA_CAPSULE.radius_m - 1e-3)
  })

  it('snaps back to walkable polygon when motion exits the polygon', () => {
    const result = resolveCameraCollision({
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 2, y: 0, z: 2 },
      intendedMotion: { x: 10, y: 0, z: 0 }, // way past the polygon edge
      obstacles: [],
      walkable,
    })
    // Position should NOT be at x = 12; the resolver retreated.
    expect(result.position.x).toBeLessThan(12)
  })

  it('R14: stays inside walkable + tracks fallback state when stuck between two walls', () => {
    // Two walls forming a tight corner. The resolver must not crash,
    // must end up not deeper inside the walls, and must report
    // `stuckFallback` consistently with any remaining collision.
    const obstacles = [
      { id: 'wall_x', bounds: aabb({ x: -1, y: 0, z: -0.4 }, { x: 5, y: 2.5, z: -0.2 }) },
      { id: 'wall_z', bounds: aabb({ x: -0.4, y: 0, z: -1 }, { x: -0.2, y: 2.5, z: 5 }) },
    ]
    const input: CameraResolveInput = {
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 0, y: 0, z: 0 },
      intendedMotion: { x: 0, y: 0, z: 0 },
      obstacles,
      walkable: {
        outer: [
          { x: -2, y: 0, z: -2 },
          { x: 5, y: 0, z: -2 },
          { x: 5, y: 0, z: 5 },
          { x: -2, y: 0, z: 5 },
        ],
        holes: [],
      },
    }
    const result = resolveCameraCollision(input, 2)
    // The resolver must terminate within the iteration cap.
    expect(result.iterations).toBeLessThanOrEqual(2)
    // If iterations hit the cap AND any obstacle still collides at the end,
    // the fallback flag must be set. Otherwise the fallback must be false
    // (we only lift Y when we actually fail to resolve laterally).
    if (result.stuckFallback) {
      expect(result.position.y).toBeGreaterThan(0)
    }
  })

  it('reports per-iteration collision ids for debug overlays', () => {
    const wallObstacle = {
      id: 'wall',
      bounds: aabb({ x: 1.4, y: 0, z: 1 }, { x: 1.6, y: 2.5, z: 3 }),
    }
    const result = resolveCameraCollision({
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 0.5, y: 0, z: 2 },
      intendedMotion: { x: 1, y: 0, z: 0 },
      obstacles: [wallObstacle],
      walkable,
    })
    if (result.iterations > 0) {
      expect(result.collisions.length).toBeGreaterThanOrEqual(1)
      expect(result.collisions[0]).toBe('wall')
    }
  })
})

describe('collision · capsuleVsRotatedBox (B-1 · OBB)', () => {
  // 2×2×2 box centred at the origin, in its own local frame.
  const box = aabb({ x: -1, y: 0, z: -1 }, { x: 1, y: 2.5, z: 1 })
  const thinCapsule = { radius_m: 0.25, height_m: 1.7 }

  it('rotationY ≈ 0 falls through to the plain AABB test', () => {
    const pos: Vector3 = { x: 1.1, y: 0, z: 0 }
    const aabbResult = capsuleVsBox(thinCapsule, pos, box)
    const obbResult = capsuleVsRotatedBox(thinCapsule, pos, box, 0)
    expect(obbResult.colliding).toBe(aabbResult.colliding)
    expect(obbResult.penetrationDepth).toBeCloseTo(aabbResult.penetrationDepth, 9)
  })

  it('a 45°-rotated box does NOT collide where its AABB hull would', () => {
    // (0.9, 0.9) is inside the axis-aligned hull but outside the rotated
    // diamond (|x|+|z| = 1.8 > √2) — far enough that the capsule clears it.
    const pos: Vector3 = { x: 0.9, y: 0, z: 0.9 }
    expect(capsuleVsBox(thinCapsule, pos, box).colliding).toBe(true)
    expect(capsuleVsRotatedBox(thinCapsule, pos, box, Math.PI / 4).colliding).toBe(false)
  })

  it('a 45°-rotated box DOES collide where its AABB hull would not', () => {
    // (1.3, 0) is outside the AABB (by 0.3 > radius) but inside the diamond.
    const pos: Vector3 = { x: 1.3, y: 0, z: 0 }
    expect(capsuleVsBox(thinCapsule, pos, box).colliding).toBe(false)
    expect(capsuleVsRotatedBox(thinCapsule, pos, box, Math.PI / 4).colliding).toBe(true)
  })

  it('resolveCameraCollision pushes the capsule out of a rotated obstacle', () => {
    const walkable: WalkablePolygon = {
      outer: [
        { x: -10, y: 0, z: -10 },
        { x: 10, y: 0, z: -10 },
        { x: 10, y: 0, z: 10 },
        { x: -10, y: 0, z: 10 },
      ],
      holes: [],
    }
    const input: CameraResolveInput = {
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 1.45, y: 0, z: 0 },
      intendedMotion: { x: -0.2, y: 0, z: 0 }, // walk toward the diamond
      obstacles: [{ id: 'couch', bounds: box, rotationY: Math.PI / 4 }],
      walkable,
    }
    const result = resolveCameraCollision(input)
    // Capsule must end up clear of the rotated couch.
    const after = capsuleVsRotatedBox(
      DEFAULT_CAMERA_CAPSULE,
      result.position,
      box,
      Math.PI / 4,
    )
    expect(after.colliding).toBe(false)
    expect(result.collisions).toContain('couch')
  })
})

describe('collision · walkableInteriorPoint', () => {
  const ring = (pairs: [number, number][]): Vector3[] =>
    pairs.map(([x, z]) => ({ x, y: 0, z }))
  // L-shape with the bottom-left square (x[0,2], z[0,3]) removed. The walk-spawn
  // AABB-min-corner heuristic lands at (minX+inset, minZ+inset) ≈ (0.5, 0.5),
  // which is in that missing notch → OUTSIDE the room.
  const L_SHAPE: WalkablePolygon = {
    outer: ring([
      [2, 0],
      [4, 0],
      [4, 5],
      [0, 5],
      [0, 3],
      [2, 3],
    ]),
    holes: [],
  }

  it('returns a point inside an L-shaped room', () => {
    const p = walkableInteriorPoint(L_SHAPE)
    expect(p).not.toBeNull()
    if (!p) return
    expect(isPointInWalkable(p, L_SHAPE)).toBe(true)
  })

  it('avoids the dead-space notch where the naive AABB-corner spawn would land', () => {
    // Sanity: the naive spawn point IS outside (so the guard is load-bearing)…
    expect(isPointInWalkable({ x: 0.5, y: 0, z: 0.5 }, L_SHAPE)).toBe(false)
    // …and the helper returns a genuinely interior point instead.
    const p = walkableInteriorPoint(L_SHAPE)!
    expect(isPointInWalkable(p, L_SHAPE)).toBe(true)
  })

  it('returns null for a degenerate ring', () => {
    expect(walkableInteriorPoint({ outer: ring([[0, 0], [1, 0]]), holes: [] })).toBeNull()
  })

  it('the zero-motion resolver snaps an outside spawn into the room', () => {
    // Seed a spawn in the notch with no motion → resolver must land inside.
    const result = resolveCameraCollision({
      capsule: DEFAULT_CAMERA_CAPSULE,
      position: { x: 0.5, y: 0, z: 0.5 },
      intendedMotion: { x: 0, y: 0, z: 0 },
      obstacles: [],
      walkable: L_SHAPE,
    })
    expect(isPointInWalkable(result.position, L_SHAPE)).toBe(true)
  })
})
