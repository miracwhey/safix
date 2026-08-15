/**
 * Tests for objectPositionValidator.ts (V1.6.1 L0.6 hard-bounds validator).
 */
import { describe, it, expect } from 'vitest'
import {
  aabbForOpening,
  aabbForWallMounted,
  aabbOverlaps,
  validateObjectPosition,
  floorFootprintCorners,
  pointInPolygon,
  validateFloorObjectPosition,
  clampFloorObjectIntoRoom,
} from '../../../../../src/lib/spatial/canonical/validator/objectPositionValidator.ts'
import type { Wall, WallOpening, Floor } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'

const NOW = '2026-05-28T00:00:00.000Z'

const baseNode = {
  parent_id: 'wall-1',
  children_ids: [] as string[],
  transform: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  },
  source: 'manual' as const,
  confidence: 1,
  variant_id: 'customer_corrections' as const,
  created_at: NOW,
  updated_at: NOW,
}

function makeOpening(
  id: string,
  offset: number,
  width: number,
  fromFloor = 0,
  height = 2,
): WallOpening {
  return {
    id,
    type: 'door',
    ...baseNode,
    host_wall_id: 'wall-1',
    offset_along_wall_m: offset,
    offset_from_floor_m: fromFloor,
    width_m: width,
    height_m: height,
    is_walkable_portal: true,
  } as WallOpening
}

function makeWallMounted(
  id: string,
  offset: number,
  width: number,
  fromFloor: number,
  height: number,
): SpatialObject {
  return {
    id,
    type: 'object',
    ...baseNode,
    category: 'radiator',
    asset_id: 'arch-radiator-panel-typ22',
    dimensions: { width_m: width, depth_m: 0.08, height_m: height },
    host: 'wall',
    host_id: 'wall-1',
    offset_along_wall_m: offset,
    height_from_floor_m: fromFloor,
    depth_from_wall_m: 0.08,
  } as SpatialObject
}

function makeWall(
  openings: WallOpening[] = [],
  wallMounted: SpatialObject[] = [],
): Wall {
  return {
    id: 'wall-1',
    type: 'wall',
    parent_id: 'room-1',
    children_ids: [],
    transform: baseNode.transform,
    source: 'roomplan',
    confidence: 0.9,
    variant_id: 'base_roomplan',
    created_at: NOW,
    updated_at: NOW,
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    height_m: 2.5,
    thickness_m: 0.15,
    base_height_m: 0,
    openings,
    wall_mounted: wallMounted,
    is_exterior_wall: false,
    walkable_blocker: true,
  } as Wall
}

describe('aabb helpers', () => {
  it('aabbForOpening uses left-edge offset convention', () => {
    const o = makeOpening('o-1', 1, 0.86, 0, 1.985)
    const aabb = aabbForOpening(o)
    expect(aabb.left).toBeCloseTo(1, 6)
    expect(aabb.right).toBeCloseTo(1.86, 6)
    expect(aabb.bottom).toBeCloseTo(0, 6)
    expect(aabb.top).toBeCloseTo(1.985, 6)
  })

  it('aabbForWallMounted returns null for non-wall host', () => {
    const o = makeWallMounted('o-2', 1, 0.6, 0.15, 0.5)
    o.host = 'floor'
    expect(aabbForWallMounted(o)).toBeNull()
  })

  it('aabbForWallMounted uses left-edge + height-from-floor', () => {
    const o = makeWallMounted('o-2', 1, 0.6, 0.15, 0.5)
    const aabb = aabbForWallMounted(o)!
    expect(aabb.left).toBeCloseTo(1, 6)
    expect(aabb.right).toBeCloseTo(1.6, 6)
    expect(aabb.bottom).toBeCloseTo(0.15, 6)
    expect(aabb.top).toBeCloseTo(0.65, 6)
  })

  it('aabbOverlaps treats touching edges as non-overlap', () => {
    expect(
      aabbOverlaps(
        { left: 0, right: 1, bottom: 0, top: 1 },
        { left: 1, right: 2, bottom: 0, top: 1 },
      ),
    ).toBe(false)
    expect(
      aabbOverlaps(
        { left: 0, right: 1, bottom: 0, top: 1 },
        { left: 0.5, right: 1.5, bottom: 0.5, top: 1.5 },
      ),
    ).toBe(true)
  })
})

describe('validateObjectPosition', () => {
  it('passes for a valid centered candidate on an empty wall', () => {
    const wall = makeWall()
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1.5, right: 2.5, bottom: 0.15, top: 0.75 },
    })
    expect(result.ok).toBe(true)
  })

  it('blocks floor_breach when bottom < 0', () => {
    const wall = makeWall()
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1, right: 1.86, bottom: -0.1, top: 1.985 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('floor_breach')
  })

  it('blocks ceiling_breach when top > wallHeight', () => {
    const wall = makeWall()
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1, right: 2, bottom: 0.5, top: 3.0 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('ceiling_breach')
  })

  it('blocks out_of_wall when left < 0', () => {
    const wall = makeWall()
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: -0.1, right: 0.5, bottom: 0, top: 1 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('out_of_wall')
  })

  it('blocks out_of_wall when right > wallLength', () => {
    const wall = makeWall()
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 3.5, right: 4.5, bottom: 0, top: 1 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('out_of_wall')
  })

  it('blocks aabb_overlap with existing opening', () => {
    const wall = makeWall([makeOpening('door-1', 1, 0.86, 0, 1.985)])
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1.5, right: 2.5, bottom: 0, top: 1.5 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('aabb_overlap')
      expect(result.conflictingId).toBe('door-1')
    }
  })

  it('blocks aabb_overlap with existing wall-mounted object', () => {
    const wall = makeWall([], [makeWallMounted('rad-1', 1, 0.6, 0.15, 0.5)])
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1.2, right: 1.4, bottom: 0.2, top: 0.6 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('aabb_overlap')
      expect(result.conflictingId).toBe('rad-1')
    }
  })

  it('passes when candidate is right next to an opening (touching edges)', () => {
    const wall = makeWall([makeOpening('door-1', 1, 0.86, 0, 1.985)])
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      // candidate's left edge meets door's right edge exactly
      candidate: { left: 1.86, right: 2.86, bottom: 0, top: 1.985 },
    })
    expect(result.ok).toBe(true)
  })

  it('respects excludeId so an edited object does not overlap with itself', () => {
    const wall = makeWall([makeOpening('door-1', 1, 0.86, 0, 1.985)])
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      candidate: { left: 1, right: 1.86, bottom: 0, top: 1.985 },
      excludeId: 'door-1',
    })
    expect(result.ok).toBe(true)
  })

  it('reports floor_breach before any other reason (canonical order)', () => {
    const wall = makeWall([makeOpening('door-1', 1, 0.86, 0, 1.985)])
    const result = validateObjectPosition({
      wall,
      wallLengthM: 4,
      // simultaneously below floor AND overlapping AND above ceiling
      candidate: { left: 1.2, right: 1.4, bottom: -0.5, top: 3.0 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('floor_breach')
  })
})

// ── Floor-mounted furniture (Phase 1) ────────────────────────────────────────

/** 4×4 m square room, CCW, origin at corner. */
function makeFloor(polygon?: Vector3Like[]): Floor {
  return {
    id: 'floor-1',
    type: 'floor',
    parent_id: 'room-1',
    children_ids: [],
    transform: baseNode.transform,
    source: 'roomplan',
    confidence: 0.9,
    variant_id: 'base_roomplan',
    created_at: NOW,
    updated_at: NOW,
    polygon: (polygon ?? [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 },
      { x: 0, y: 0, z: 4 },
    ]) as Floor['polygon'],
    walkable_surface: true,
    floor_mounted: [],
  } as Floor
}

interface Vector3Like {
  x: number
  y: number
  z: number
}

function makeFloorObject(
  id: string,
  x: number,
  z: number,
  width = 2.0,
  depth = 0.9,
  rotationDeg = 0,
  scale = 1,
): SpatialObject {
  return {
    id,
    type: 'object',
    parent_id: 'floor-1',
    children_ids: [],
    transform: {
      position: { x, y: 0, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: scale, y: scale, z: scale },
    },
    source: 'manual',
    confidence: 1,
    variant_id: 'customer_corrections',
    created_at: NOW,
    updated_at: NOW,
    category: 'sofa',
    asset_id: 'furn-sofa-3seater-fabric-grey',
    dimensions: { width_m: width, depth_m: depth, height_m: 0.85 },
    host: 'floor',
    host_id: 'floor-1',
    rotation_around_y_deg: rotationDeg,
  } as SpatialObject
}

describe('floorFootprintCorners', () => {
  it('returns axis-aligned corners at rotation 0', () => {
    const o = makeFloorObject('sofa-1', 2, 2, 2.0, 1.0, 0)
    const c = floorFootprintCorners(o)
    expect(c).toHaveLength(4)
    expect(Math.min(...c.map((p) => p.x))).toBeCloseTo(1, 6)
    expect(Math.max(...c.map((p) => p.x))).toBeCloseTo(3, 6)
    expect(Math.min(...c.map((p) => p.z))).toBeCloseTo(1.5, 6)
    expect(Math.max(...c.map((p) => p.z))).toBeCloseTo(2.5, 6)
  })

  it('applies scale to the footprint', () => {
    const o = makeFloorObject('sofa-1', 2, 2, 2.0, 1.0, 0, 2)
    const c = floorFootprintCorners(o)
    expect(Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x))).toBeCloseTo(4, 6)
  })

  it('rotates the footprint 90° (width/depth swap in bounds)', () => {
    const o = makeFloorObject('sofa-1', 2, 2, 2.0, 1.0, 90)
    const c = floorFootprintCorners(o)
    // after 90° the X-extent becomes the depth (1.0) and Z-extent the width (2.0)
    expect(Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x))).toBeCloseTo(1, 6)
    expect(Math.max(...c.map((p) => p.z)) - Math.min(...c.map((p) => p.z))).toBeCloseTo(2, 6)
  })
})

describe('pointInPolygon', () => {
  const square: Vector3Like[] = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 4 },
    { x: 0, y: 0, z: 4 },
  ]
  it('detects interior point', () => {
    expect(pointInPolygon({ x: 2, z: 2 }, square as Floor['polygon'])).toBe(true)
  })
  it('detects exterior point', () => {
    expect(pointInPolygon({ x: 5, z: 2 }, square as Floor['polygon'])).toBe(false)
  })
})

describe('validateFloorObjectPosition', () => {
  it('passes when the whole footprint is inside the room', () => {
    const floor = makeFloor()
    const obj = makeFloorObject('sofa-1', 2, 2, 2.0, 0.9)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(true)
  })

  it('blocks out_of_floor when a corner crosses the wall', () => {
    const floor = makeFloor()
    // centered at x=3.8 → right edge at 4.8 > room width 4
    const obj = makeFloorObject('sofa-1', 3.8, 2, 2.0, 0.9)
    const result = validateFloorObjectPosition({ floor, object: obj })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('out_of_floor')
  })

  it('blocks out_of_floor when scaled up beyond the room', () => {
    const floor = makeFloor()
    const obj = makeFloorObject('sofa-1', 2, 2, 2.0, 0.9, 0, 2.5)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(false)
  })

  it('does not block on a degenerate floor (<3 vertices)', () => {
    const floor = makeFloor([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ])
    const obj = makeFloorObject('sofa-1', 10, 10, 2.0, 0.9)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(true)
  })
})

// Block 8: the validator CLAIMS concave/L-room support (point-in-polygon) but
// the suite above is all 4×4 squares — RoomPlan scans are rarely rectangles.
// These lock the concave path: a footprint corner crossing into the L's notch
// must be rejected even though it sits inside the room's bounding box (a naive
// bbox check would pass it).
describe('validateFloorObjectPosition — concave / L-shaped room', () => {
  // L-room: full bottom strip (z 0–2) + left column (x 0–2, z 2–4). The
  // top-right quadrant (x 2–4, z 2–4) is the NOTCH — outside the polygon.
  const lShape: Vector3Like[] = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 2 },
    { x: 2, y: 0, z: 2 },
    { x: 2, y: 0, z: 4 },
    { x: 0, y: 0, z: 4 },
  ]

  it('passes inside the bottom strip', () => {
    const floor = makeFloor(lShape)
    const obj = makeFloorObject('o', 1, 1, 0.6, 0.6)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(true)
  })

  it('passes inside the left column', () => {
    const floor = makeFloor(lShape)
    const obj = makeFloorObject('o', 1, 3, 0.6, 0.6)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(true)
  })

  it('rejects an object fully inside the notch (inside the bbox, outside the polygon)', () => {
    const floor = makeFloor(lShape)
    const obj = makeFloorObject('o', 3, 3, 0.6, 0.6)
    const result = validateFloorObjectPosition({ floor, object: obj })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('out_of_floor')
  })

  it('rejects an object whose corner pokes into the concave notch', () => {
    const floor = makeFloor(lShape)
    // centre (1.8,1.8) with 0.8×0.8 → far corner (2.2,2.2) lands in the notch
    const obj = makeFloorObject('o', 1.8, 1.8, 0.8, 0.8)
    expect(validateFloorObjectPosition({ floor, object: obj }).ok).toBe(false)
  })
})

describe('validateFloorObjectPosition — rotation-aware bounds', () => {
  it('an object that fits axis-aligned is rejected once rotated so a corner crosses the wall', () => {
    const floor = makeFloor()
    // 2.0×0.5 near the back wall: axis-aligned z-extent [3.25,3.75] fits …
    expect(validateFloorObjectPosition({ floor, object: makeFloorObject('o', 2, 3.5, 2.0, 0.5, 0) }).ok).toBe(true)
    // … rotated 45° the diagonal half-extent (~1.03) pushes a corner past z=4.
    expect(validateFloorObjectPosition({ floor, object: makeFloorObject('o', 2, 3.5, 2.0, 0.5, 45) }).ok).toBe(false)
  })
})

describe('clampFloorObjectIntoRoom', () => {
  const lShape: Vector3Like[] = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 2 },
    { x: 2, y: 0, z: 2 },
    { x: 2, y: 0, z: 4 },
    { x: 0, y: 0, z: 4 },
  ]

  it('returns the centre unchanged when the footprint is already inside', () => {
    const floor = makeFloor()
    const obj = makeFloorObject('o', 2, 2, 2.0, 0.9)
    expect(clampFloorObjectIntoRoom(floor, obj)).toEqual({ x: 2, z: 2 })
  })

  it('clamps an out-of-room centre to the nearest inside position', () => {
    const floor = makeFloor() // 4×4
    // sofa 2.0×0.9 → extX 1.0, extZ 0.45. Tap far outside at (5, 2).
    const obj = makeFloorObject('o', 5, 2, 2.0, 0.9)
    const fit = clampFloorObjectIntoRoom(floor, obj)
    expect(fit).not.toBeNull()
    expect(fit!.x).toBeCloseTo(3) // 4 - extX
    expect(fit!.z).toBeCloseTo(2)
    // the clamped pose validates fully inside
    const moved = makeFloorObject('o', fit!.x, fit!.z, 2.0, 0.9)
    expect(validateFloorObjectPosition({ floor, object: moved }).ok).toBe(true)
  })

  it('returns null when the object is larger than the room', () => {
    const floor = makeFloor() // 4×4
    const obj = makeFloorObject('o', 2, 2, 5.0, 5.0)
    expect(clampFloorObjectIntoRoom(floor, obj)).toBeNull()
  })

  it('a concave-room clamp is always valid or null — never an out-of-floor pose', () => {
    const floor = makeFloor(lShape)
    // Solvable: a tap past the left strip's outer wall box-clamps back into it.
    const solvable = clampFloorObjectIntoRoom(floor, makeFloorObject('o', 1, 9, 0.6, 0.6))
    expect(solvable).not.toBeNull()
    if (solvable) {
      const moved = makeFloorObject('o', solvable.x, solvable.z, 0.6, 0.6)
      expect(validateFloorObjectPosition({ floor, object: moved }).ok).toBe(true)
    }
    // A deep-notch tap may be unreachable by the cheap fallback → null is
    // acceptable; the invariant is it MUST NOT return an out-of-floor position.
    const notch = clampFloorObjectIntoRoom(floor, makeFloorObject('o', 3, 3, 0.6, 0.6))
    if (notch) {
      const moved = makeFloorObject('o', notch.x, notch.z, 0.6, 0.6)
      expect(validateFloorObjectPosition({ floor, object: moved }).ok).toBe(true)
    }
  })

  it('degenerate floor (<3 verts) returns the centre unchanged', () => {
    const floor = makeFloor([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])
    const obj = makeFloorObject('o', 9, 9, 2.0, 0.9)
    expect(clampFloorObjectIntoRoom(floor, obj)).toEqual({ x: 9, z: 9 })
  })
})
