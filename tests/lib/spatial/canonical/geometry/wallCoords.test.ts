/**
 * Tests for wallCoords.ts (V1.6.1 L0.1 worldToWallLocal helper).
 *
 * Covers the project-onto-wall-axis math + the clamp-for-object helper.
 * Pure unit tests — no three.js dependency.
 */
import { describe, it, expect } from 'vitest'
import {
  worldPointToWallLocalOffset,
  wallLengthMeters,
  clampOffsetForObject,
  findWallObjectAtOffset,
} from '../../../../../src/lib/spatial/canonical/geometry/wallCoords.ts'
import type { Wall, WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'

const NOW = '2026-05-28T00:00:00.000Z'

function makeWall(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  height = 2.5,
  baseHeight = 0,
): Wall {
  return {
    id: 'wall-test',
    type: 'wall',
    parent_id: 'room-test',
    children_ids: [],
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'roomplan',
    confidence: 0.9,
    variant_id: 'base_roomplan',
    created_at: NOW,
    updated_at: NOW,
    start_point: start,
    end_point: end,
    height_m: height,
    thickness_m: 0.15,
    base_height_m: baseHeight,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: false,
    walkable_blocker: true,
  } as Wall
}

describe('wallLengthMeters', () => {
  it('computes Euclidean distance in the XZ plane', () => {
    const wall = makeWall({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 })
    expect(wallLengthMeters(wall)).toBeCloseTo(5, 6)
  })

  it('returns 0 for a degenerate zero-length wall', () => {
    const wall = makeWall({ x: 2, y: 0, z: 2 }, { x: 2, y: 0, z: 2 })
    expect(wallLengthMeters(wall)).toBe(0)
  })
})

describe('worldPointToWallLocalOffset · axis-aligned wall (along +X)', () => {
  const wall = makeWall({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 2.5, 0)
  const wallLength = 4
  const wallHeight = 2.5

  it('projects a point at the wall start to (0, y)', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 0, y: 1.2, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_along_wall_m).toBeCloseTo(0, 6)
    expect(result.offset_from_floor_m).toBeCloseTo(1.2, 6)
  })

  it('projects a point at the wall midpoint to (length/2, y)', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 2, y: 1.5, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_along_wall_m).toBeCloseTo(2, 6)
    expect(result.offset_from_floor_m).toBeCloseTo(1.5, 6)
  })

  it('clamps a tap past the wall end to wallLength', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 6, y: 0.5, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_along_wall_m).toBe(wallLength)
  })

  it('clamps a tap before the wall start to 0', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: -1, y: 0.5, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_along_wall_m).toBe(0)
  })

  it('clamps a tap above the ceiling to wallHeight', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 2, y: 3.0, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_from_floor_m).toBe(wallHeight)
  })

  it('clamps a tap below the floor to 0', () => {
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 2, y: -0.5, z: 0 },
      wallLength,
      wallHeight,
    )
    expect(result.offset_from_floor_m).toBe(0)
  })
})

describe('worldPointToWallLocalOffset · diagonal wall', () => {
  it('correctly projects onto a diagonal axis (45° in XZ)', () => {
    // 3-4-5 triangle wall: start (0,0,0), end (3,0,4), length 5
    const wall = makeWall({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }, 2.5, 0)
    const wallLength = 5
    // Mid-point in world: (1.5, 1.2, 2)
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 1.5, y: 1.2, z: 2 },
      wallLength,
      2.5,
    )
    expect(result.offset_along_wall_m).toBeCloseTo(2.5, 6)
    expect(result.offset_from_floor_m).toBeCloseTo(1.2, 6)
  })

  it('respects base_height_m offset', () => {
    const wall = makeWall({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 2.5, 1.0)
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 2.5, y: 2.0, z: 0 },
      5,
      2.5,
    )
    // world-Y 2.0 minus base 1.0 = 1.0 above the wall base
    expect(result.offset_from_floor_m).toBeCloseTo(1.0, 6)
  })
})

describe('worldPointToWallLocalOffset · degenerate wall', () => {
  it('returns (0,0) for a zero-length wall without crashing', () => {
    const wall = makeWall({ x: 2, y: 0, z: 2 }, { x: 2, y: 0, z: 2 })
    const result = worldPointToWallLocalOffset(
      wall,
      { x: 2, y: 1.5, z: 2 },
      0,
      2.5,
    )
    expect(result.offset_along_wall_m).toBe(0)
    expect(result.offset_from_floor_m).toBe(0)
  })
})

describe('clampOffsetForObject', () => {
  it('returns desired offset when inside [0, wallLength - width]', () => {
    expect(clampOffsetForObject(2, 0.86, 4)).toBe(2)
  })

  it('clamps to 0 when desired offset would push left edge before wall start', () => {
    expect(clampOffsetForObject(-1, 0.86, 4)).toBe(0)
  })

  it('clamps to (wallLength - width) when desired offset would push right edge past wall end', () => {
    expect(clampOffsetForObject(4, 0.86, 4)).toBeCloseTo(4 - 0.86, 6)
  })

  it('snaps to 0 when object is wider than wall (validator blocks downstream)', () => {
    // 2m wall, 3m object — impossible to fit. clampOffsetForObject pins
    // left-edge to wall start; the position-validator (L0.6) blocks the
    // drop with an explicit reason so the user sees a clear toast instead
    // of a silently-misplaced object.
    expect(clampOffsetForObject(0, 3, 2)).toBe(0)
  })
})

describe('findWallObjectAtOffset', () => {
  const door: WallOpening = {
    id: 'door1',
    type: 'door',
    offset_along_wall_m: 1.0,
    width_m: 0.9,
    offset_from_floor_m: 0,
    height_m: 2.0,
  } as WallOpening
  const radiator: SpatialObject = {
    id: 'rad1',
    host: 'wall',
    offset_along_wall_m: 2.5,
    height_from_floor_m: 0.15,
    dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 },
  } as SpatialObject
  const wall = { ...makeWall({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }), openings: [door], wall_mounted: [radiator] }

  it('returns the opening when the point lies inside its rect', () => {
    expect(findWallObjectAtOffset(wall, { offset_along_wall_m: 1.5, offset_from_floor_m: 1.0 })).toEqual({
      kind: 'opening',
      id: 'door1',
    })
  })

  it('returns the wall_mounted object when the point lies inside its rect', () => {
    expect(findWallObjectAtOffset(wall, { offset_along_wall_m: 2.8, offset_from_floor_m: 1.0 })).toEqual({
      kind: 'wall_mounted',
      id: 'rad1',
    })
  })

  it('returns null when the point hits bare wall', () => {
    expect(findWallObjectAtOffset(wall, { offset_along_wall_m: 0.3, offset_from_floor_m: 1.0 })).toBeNull()
  })

  it('prefers the opening when an opening and wall_mounted overlap the point', () => {
    const overlap = {
      ...makeWall({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      openings: [{ ...door, offset_along_wall_m: 2.4, width_m: 0.9 }],
      wall_mounted: [radiator],
    }
    expect(findWallObjectAtOffset(overlap, { offset_along_wall_m: 2.7, offset_from_floor_m: 1.0 })?.kind).toBe(
      'opening',
    )
  })

  it('returns null for a bare wall (no openings, no wall_mounted)', () => {
    const bare = makeWall({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })
    expect(findWallObjectAtOffset(bare, { offset_along_wall_m: 2.0, offset_from_floor_m: 1.0 })).toBeNull()
  })
})
