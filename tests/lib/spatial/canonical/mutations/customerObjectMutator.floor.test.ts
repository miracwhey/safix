/**
 * Tests for the floor-mounted furniture mutators + builder (V1.6.1 Phase 1).
 *
 * Covers buildDefaultFloorObject + addFloorObjectToFloor / updateFloorObjectInFloor /
 * removeFloorObjectFromFloor: immutability, idempotency, floorId-guard.
 */
import { describe, it, expect } from 'vitest'
import {
  addFloorObjectToFloor,
  updateFloorObjectInFloor,
  removeFloorObjectFromFloor,
  buildDefaultFloorObject,
} from '../../../../../src/lib/spatial/canonical/mutations/customerObjectMutator.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'
import type { Floor } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'

const NOW = '2026-05-29T00:00:00.000Z'

function makeScene(): RoomScene {
  const floor = {
    id: 'floor-1',
    type: 'floor',
    parent_id: 'room-1',
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
    polygon: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 },
      { x: 0, y: 0, z: 4 },
    ],
    walkable_surface: true,
    floor_mounted: [],
  } as unknown as Floor

  return {
    id: 'room-1',
    type: 'room',
    category: 'living',
    parent_id: 'building-1',
    children_ids: [],
    transform: floor.transform,
    source: 'roomplan',
    confidence: 0.9,
    variant_id: 'base_roomplan',
    created_at: NOW,
    updated_at: NOW,
    walls: [],
    floor,
    ceiling: { id: 'ceiling-1', ceiling_mounted: [] },
    free_objects: [],
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: 2.5, z: 4 },
    computed_area_m2: 16,
    computed_volume_m3: 40,
  } as unknown as RoomScene
}

const sofaArgs = {
  id: 'sofa-1',
  floorId: 'floor-1',
  category: 'sofa' as const,
  assetId: 'furn-sofa-3seater-fabric-grey',
  dimensions: { width_m: 2.1, depth_m: 0.92, height_m: 0.85 },
  variantId: 'customer_corrections',
  generatedAt: NOW,
  tapX: 2,
  tapZ: 2,
}

describe('buildDefaultFloorObject', () => {
  it('builds a floor-hosted object at the tap point with catalog dims', () => {
    const obj = buildDefaultFloorObject(sofaArgs)
    expect(obj.host).toBe('floor')
    expect(obj.host_id).toBe('floor-1')
    expect(obj.parent_id).toBe('floor-1')
    expect(obj.asset_id).toBe('furn-sofa-3seater-fabric-grey')
    expect(obj.category).toBe('sofa')
    expect(obj.transform.position).toEqual({ x: 2, y: 0, z: 2 })
    expect(obj.dimensions).toEqual({ width_m: 2.1, depth_m: 0.92, height_m: 0.85 })
    expect(obj.rotation_around_y_deg).toBe(0)
  })

  it('falls back to the floor origin without a tap point', () => {
    const obj = buildDefaultFloorObject({ ...sofaArgs, tapX: undefined, tapZ: undefined })
    expect(obj.transform.position).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('addFloorObjectToFloor', () => {
  it('appends immutably and does not mutate the input scene', () => {
    const scene = makeScene()
    const obj = buildDefaultFloorObject(sofaArgs)
    const next = addFloorObjectToFloor(scene, { floorId: 'floor-1', object: obj })
    expect(next).not.toBe(scene)
    expect(scene.floor.floor_mounted).toHaveLength(0)
    expect(next.floor.floor_mounted).toHaveLength(1)
    expect(next.floor.floor_mounted[0].id).toBe('sofa-1')
  })

  it('is idempotent on id (double-tap safe)', () => {
    const scene = makeScene()
    const obj = buildDefaultFloorObject(sofaArgs)
    const once = addFloorObjectToFloor(scene, { floorId: 'floor-1', object: obj })
    const twice = addFloorObjectToFloor(once, { floorId: 'floor-1', object: obj })
    expect(twice.floor.floor_mounted).toHaveLength(1)
    expect(twice).toBe(once)
  })

  it('no-ops when floorId does not match', () => {
    const scene = makeScene()
    const obj = buildDefaultFloorObject(sofaArgs)
    const next = addFloorObjectToFloor(scene, { floorId: 'other-floor', object: obj })
    expect(next).toBe(scene)
  })
})

describe('updateFloorObjectInFloor', () => {
  it('patches transform immutably', () => {
    const scene = addFloorObjectToFloor(makeScene(), {
      floorId: 'floor-1',
      object: buildDefaultFloorObject(sofaArgs),
    })
    const next = updateFloorObjectInFloor(scene, {
      floorId: 'floor-1',
      objectId: 'sofa-1',
      patch: { rotation_around_y_deg: 90 },
    })
    expect(next).not.toBe(scene)
    expect(scene.floor.floor_mounted[0].rotation_around_y_deg).toBe(0)
    expect(next.floor.floor_mounted[0].rotation_around_y_deg).toBe(90)
  })

  it('no-ops for an unknown objectId', () => {
    const scene = addFloorObjectToFloor(makeScene(), {
      floorId: 'floor-1',
      object: buildDefaultFloorObject(sofaArgs),
    })
    const next = updateFloorObjectInFloor(scene, {
      floorId: 'floor-1',
      objectId: 'ghost',
      patch: { rotation_around_y_deg: 90 },
    })
    expect(next).toBe(scene)
  })
})

describe('removeFloorObjectFromFloor', () => {
  it('removes immutably', () => {
    const scene = addFloorObjectToFloor(makeScene(), {
      floorId: 'floor-1',
      object: buildDefaultFloorObject(sofaArgs),
    })
    const next = removeFloorObjectFromFloor(scene, { floorId: 'floor-1', objectId: 'sofa-1' })
    expect(next.floor.floor_mounted).toHaveLength(0)
    expect(scene.floor.floor_mounted).toHaveLength(1)
  })

  it('no-ops when the object is absent', () => {
    const scene = makeScene()
    const next = removeFloorObjectFromFloor(scene, { floorId: 'floor-1', objectId: 'ghost' })
    expect(next).toBe(scene)
  })
})
