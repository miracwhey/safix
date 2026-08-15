/**
 * Test helpers for canonical scene fixtures.
 *
 * Builds minimal RoomScene / Wall / Floor / etc. with sensible defaults,
 * accepting partial overrides. Used by the validator + override tests so
 * each test stays a few lines long.
 */

import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { Vector3 } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type {
  Ceiling,
  Floor,
  Wall,
  WallOpening,
} from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import type { Pin } from '../../../../../src/lib/spatial/canonical/types/annotations.ts'

const NOW = '2026-05-20T00:00:00.000Z'

const baseNode = {
  source: 'manual' as const,
  confidence: 1,
  variant_id: 'base_roomplan',
  created_at: NOW,
  updated_at: NOW,
  children_ids: [],
  transform: {
    position: IDENTITY_VECTOR3,
    rotation: IDENTITY_QUATERNION,
    scale: ONE_VECTOR3,
  },
  parent_id: 'room',
}

export function makeWall(overrides: Partial<Wall> = {}): Wall {
  return {
    ...baseNode,
    id: overrides.id ?? 'wall',
    type: 'wall',
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    thickness_m: 0.2,
    height_m: 2.5,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true,
    length_m: 4,
    normal: { x: 0, y: 0, z: -1 },
    material_id: 'plaster_white',
    ...overrides,
  }
}

export function makeFloor(corners: Array<[number, number]> = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
], overrides: Partial<Floor> = {}): Floor {
  return {
    ...baseNode,
    id: 'floor',
    type: 'floor',
    polygon: corners.map(([x, z]) => ({ x, y: 0, z })),
    walkable_surface: true,
    floor_mounted: [],
    ...overrides,
  }
}

export function makeCeiling(corners: Array<[number, number]> = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
], overrides: Partial<Ceiling> = {}): Ceiling {
  return {
    ...baseNode,
    id: 'ceiling',
    type: 'ceiling',
    polygon: corners.map(([x, z]) => ({ x, y: 2.5, z })),
    height_m: 2.5,
    ceiling_mounted: [],
    ...overrides,
  }
}

export function makeOpening(overrides: Partial<WallOpening> & { id: string; host_wall_id: string; type: WallOpening['type'] }): WallOpening {
  return {
    ...baseNode,
    type: overrides.type,
    offset_along_wall_m: 1,
    offset_from_floor_m: 0,
    width_m: 0.9,
    height_m: 2,
    is_walkable_portal: overrides.type !== 'window',
    ...overrides,
  }
}

export function makeObject(overrides: Partial<SpatialObject> & { id: string; category: SpatialObject['category']; host: SpatialObject['host']; host_id: string }): SpatialObject {
  return {
    ...baseNode,
    type: 'object',
    dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.8 },
    ...overrides,
  }
}

export function makePin(overrides: Partial<Pin> & { id: string; anchor_surface_id: string; anchor_surface_type: Pin['anchor_surface_type']; pin_type: Pin['pin_type'] }): Pin {
  return {
    ...baseNode,
    type: 'pin',
    anchor_uv: { u: 0.5, v: 0.5 },
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
    ...overrides,
  }
}

export function makeRoom(overrides: Partial<RoomScene> = {}): RoomScene {
  const walls: Wall[] = overrides.walls ?? [
    makeWall({ id: 'w_s', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } }),
    makeWall({ id: 'w_e', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 } }),
    makeWall({ id: 'w_n', start_point: { x: 4, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 3 } }),
    makeWall({ id: 'w_w', start_point: { x: 0, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 0 } }),
  ]
  return {
    ...baseNode,
    parent_id: 'building',
    id: 'room',
    type: 'room',
    category: 'bathroom',
    walls,
    floor: makeFloor(),
    ceiling: makeCeiling(),
    free_objects: [],
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: 2.5, z: 3 },
    computed_area_m2: 12,
    computed_volume_m3: 30,
    ...overrides,
  }
}

export function vec(x: number, y: number, z: number): Vector3 {
  return { x, y, z }
}
