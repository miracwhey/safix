/**
 * Tests for src/lib/spatial/canonical/geometry/walkable.ts
 *
 * Covers basic floor-only computation, wall subtraction, door cutouts,
 * column hole (R13 — column is an object, not a wall), and the empty-input
 * graceful-empty fallback.
 */
import { describe, it, expect } from 'vitest'

import {
  computeWalkableArea,
  walkablePolygonAreaM2,
  type WalkableComputeInput,
} from '../../../../../src/lib/spatial/canonical/geometry/walkable.ts'
import type {
  Floor,
  Wall,
  WallOpening,
} from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

function nowISO() {
  return new Date().toISOString()
}

const defaultNode = {
  source: 'manual' as const,
  confidence: 1,
  variant_id: 'base_roomplan',
  created_at: nowISO(),
  updated_at: nowISO(),
  children_ids: [],
  transform: {
    position: IDENTITY_VECTOR3,
    rotation: IDENTITY_QUATERNION,
    scale: ONE_VECTOR3,
  },
  parent_id: 'room',
}

function makeFloor(corners: Array<[number, number]>): Floor {
  return {
    ...defaultNode,
    id: 'floor',
    type: 'floor',
    polygon: corners.map(([x, z]) => ({ x, y: 0, z })),
    walkable_surface: true,
    floor_mounted: [],
  }
}

function makeWall(
  id: string,
  startXz: [number, number],
  endXz: [number, number],
  options: { thickness?: number; height?: number; isExterior?: boolean } = {},
): Wall {
  return {
    ...defaultNode,
    id,
    type: 'wall',
    start_point: { x: startXz[0], y: 0, z: startXz[1] },
    end_point: { x: endXz[0], y: 0, z: endXz[1] },
    height_m: options.height ?? 2.5,
    thickness_m: options.thickness ?? 0.2,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: options.isExterior ?? true,
    walkable_blocker: true,
    length_m: 0,
    normal: IDENTITY_VECTOR3,
  }
}

function makeColumn(id: string, center: [number, number], dimsXz: [number, number]): SpatialObject {
  return {
    ...defaultNode,
    id,
    type: 'object',
    category: 'column',
    dimensions: { width_m: dimsXz[0], depth_m: dimsXz[1], height_m: 2.5 },
    host: 'floor',
    host_id: 'floor',
    transform: {
      ...defaultNode.transform,
      position: { x: center[0], y: 0, z: center[1] },
    },
  }
}

function makeDoor(hostWall: Wall, opts: { offset: number; width: number }): WallOpening {
  return {
    ...defaultNode,
    id: `door_${hostWall.id}`,
    type: 'door',
    host_wall_id: hostWall.id,
    offset_along_wall_m: opts.offset,
    offset_from_floor_m: 0,
    width_m: opts.width,
    height_m: 2,
    is_walkable_portal: true,
  }
}

describe('computeWalkableArea · floor only', () => {
  it('returns the floor polygon when there are no walls / obstacles', () => {
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
      walls: [],
      objects: [],
    }
    const area = computeWalkableArea(input)
    expect(area.polygon.outer).toHaveLength(4)
    expect(area.polygon.holes).toHaveLength(0)
    expect(walkablePolygonAreaM2(area.polygon)).toBeCloseTo(12, 6)
  })

  it('returns empty when the floor polygon has fewer than 3 vertices', () => {
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([[0, 0]]),
      walls: [],
      objects: [],
    }
    const area = computeWalkableArea(input)
    expect(area.polygon.outer).toEqual([])
  })
})

describe('computeWalkableArea · with walls', () => {
  it('subtracts a wall footprint from the floor polygon', () => {
    // 4×3 m room with one wall along the south edge (z=0).
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
      walls: [makeWall('w_south', [0, 0], [4, 0])],
      objects: [],
    }
    const area = computeWalkableArea(input)
    // The wall extrudes a 0.2 m strip along z; half lives outside the floor,
    // the other half (the inner 0.1 m) is subtracted from the floor.
    const expectedArea = 4 * 3 - 4 * 0.1
    expect(walkablePolygonAreaM2(area.polygon)).toBeCloseTo(expectedArea, 3)
  })

  it('re-adds the floor-plane footprint of a door cutout', () => {
    const southWall = makeWall('w_south', [0, 0], [4, 0])
    const door = makeDoor(southWall, { offset: 1, width: 0.9 })
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
      walls: [southWall],
      objects: [],
      openings: [{ host_wall: southWall, opening: door }],
    }
    const noDoor = computeWalkableArea({ ...input, openings: undefined })
    const withDoor = computeWalkableArea(input)
    // Door re-opens 0.9 m × 0.1 m of walkable area along the wall thickness.
    // (Only the inner half of the wall thickness was subtracted, so the
    // re-added area is 0.9 × 0.1 = 0.09 m²; the outer half was never inside
    // the floor polygon to begin with.)
    const recovered = walkablePolygonAreaM2(withDoor.polygon) -
      walkablePolygonAreaM2(noDoor.polygon)
    expect(recovered).toBeGreaterThan(0.05)
  })
})

describe('computeWalkableArea · column hole (R13)', () => {
  it('produces a polygon WITH HOLE when a column sits in the middle of the room', () => {
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [6, 0],
        [6, 6],
        [0, 6],
      ]),
      walls: [],
      objects: [makeColumn('col', [3, 3], [0.4, 0.4])],
      clearance_buffer_m: 0,
    }
    const area = computeWalkableArea(input)
    // polygon-clipping may emit a redundant vertex along the outer ring;
    // we only require that it remains a valid quadrilateral-ish outer ring.
    expect(area.polygon.outer.length).toBeGreaterThanOrEqual(4)
    expect(area.polygon.holes.length).toBe(1)
    // Floor area minus column footprint (0.4 × 0.4 = 0.16 m²).
    expect(walkablePolygonAreaM2(area.polygon)).toBeCloseTo(6 * 6 - 0.16, 3)
  })

  it('includes the clearance buffer in the subtracted footprint', () => {
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [6, 0],
        [6, 6],
        [0, 6],
      ]),
      walls: [],
      objects: [makeColumn('col', [3, 3], [0.4, 0.4])],
      clearance_buffer_m: 0.2,
    }
    const area = computeWalkableArea(input)
    expect(area.polygon.holes.length).toBe(1)
    // Expected hole side = 0.4 + 2*0.2 = 0.8 → area 0.64.
    expect(walkablePolygonAreaM2(area.polygon)).toBeCloseTo(6 * 6 - 0.64, 3)
  })
})

describe('computeWalkableArea · obstacles + provenance', () => {
  it('records obstacles in the report regardless of where they came from', () => {
    const southWall = makeWall('w_south', [0, 0], [4, 0])
    const input: WalkableComputeInput = {
      room_id: 'room',
      floor: makeFloor([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
      walls: [southWall],
      objects: [makeColumn('col', [2, 1.5], [0.3, 0.3])],
    }
    const area = computeWalkableArea(input)
    expect(area.obstacles.some(o => o.source_type === 'wall')).toBe(true)
    expect(area.obstacles.some(o => o.source_type === 'object')).toBe(true)
    expect(area.obstacles.find(o => o.source_id === 'col')?.clearance_buffer_m).toBeGreaterThan(0)
  })
})
