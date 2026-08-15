/**
 * customerWallObjectOrchestrator — drag-along-wall move contract.
 *
 * Mirrors the furniture orchestrator's tests: absolute move → clamp into wall →
 * re-validate against the OTHER objects on the wall. The `excludeId` in the
 * validator is the load-bearing detail — without it a dragged object overlaps
 * itself and every move is rejected. These lock that contract.
 */
import { describe, expect, it } from 'vitest'

import {
  moveWallMountedObject,
  moveWallObjectToWall,
  moveWallOpening,
} from '../../../../../src/lib/spatial/canonical/workflow/customerWallObjectOrchestrator.ts'
import { makeObject, makeOpening, makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'
import type { WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'

function sceneWith(openings: WallOpening[] = [], wallMounted: SpatialObject[] = []) {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w',
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 0 },
        height_m: 2.5,
        openings,
        wall_mounted: wallMounted,
      }),
    ],
  })
}

const doorA = makeOpening({
  id: 'A',
  host_wall_id: 'w',
  type: 'door',
  offset_along_wall_m: 0.2,
  width_m: 0.8,
  offset_from_floor_m: 0,
  height_m: 2,
})
const windowB = makeOpening({
  id: 'B',
  host_wall_id: 'w',
  type: 'window',
  offset_along_wall_m: 2.0,
  width_m: 0.8,
  offset_from_floor_m: 0.9,
  height_m: 1.0,
})

describe('moveWallOpening', () => {
  it('moves an opening to an absolute offset (single object → no self-overlap)', () => {
    const r = moveWallOpening({
      scene: sceneWith([doorA]),
      wallId: 'w',
      openingId: 'A',
      offsetAlongWallM: 1.0,
      offsetFromFloorM: 0,
    })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      expect(r.scene.walls[0].openings[0].offset_along_wall_m).toBeCloseTo(1.0)
    }
  })

  it('clamps a drag past the wall end to (wallLength - width) instead of rejecting', () => {
    const r = moveWallOpening({
      scene: sceneWith([doorA]),
      wallId: 'w',
      openingId: 'A',
      offsetAlongWallM: 10,
      offsetFromFloorM: 0,
    })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      expect(r.scene.walls[0].openings[0].offset_along_wall_m).toBeCloseTo(4 - 0.8)
    }
  })

  it('rejects a move that overlaps another opening (caller holds last pose)', () => {
    const r = moveWallOpening({
      scene: sceneWith([doorA, windowB]),
      wallId: 'w',
      openingId: 'A',
      offsetAlongWallM: 2.0, // onto windowB (2.0–2.8)
      offsetFromFloorM: 0,
    })
    expect(r.kind).toBe('rejected')
    expect(r).not.toHaveProperty('scene')
  })

  it('moves a window vertically (offsetFromFloor)', () => {
    const r = moveWallOpening({
      scene: sceneWith([windowB]),
      wallId: 'w',
      openingId: 'B',
      offsetAlongWallM: windowB.offset_along_wall_m,
      offsetFromFloorM: 0.5,
    })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      expect(r.scene.walls[0].openings[0].offset_from_floor_m).toBeCloseTo(0.5)
    }
  })

  it('returns missing when the wall or opening is gone', () => {
    expect(moveWallOpening({ scene: sceneWith([doorA]), wallId: 'ghost', openingId: 'A', offsetAlongWallM: 1, offsetFromFloorM: 0 }).kind).toBe('missing')
    expect(moveWallOpening({ scene: sceneWith([doorA]), wallId: 'w', openingId: 'ghost', offsetAlongWallM: 1, offsetFromFloorM: 0 }).kind).toBe('missing')
  })
})

const radiatorR = makeObject({
  id: 'R',
  category: 'radiator',
  host: 'wall',
  host_id: 'w',
  offset_along_wall_m: 1.0,
  height_from_floor_m: 0.15,
  dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 },
})
const radiatorS = makeObject({
  id: 'S',
  category: 'radiator',
  host: 'wall',
  host_id: 'w',
  offset_along_wall_m: 2.0,
  height_from_floor_m: 0.15,
  dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 },
})

describe('moveWallMountedObject', () => {
  it('moves a wall-mounted object to an absolute offset (single → no self-overlap)', () => {
    const r = moveWallMountedObject({
      scene: sceneWith([], [radiatorR]),
      wallId: 'w',
      objectId: 'R',
      offsetAlongWallM: 2.5,
      offsetFromFloorM: 0.15,
    })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      expect(r.scene.walls[0].wall_mounted[0].offset_along_wall_m).toBeCloseTo(2.5)
    }
  })

  it('rejects a move that overlaps another wall-mounted object', () => {
    const r = moveWallMountedObject({
      scene: sceneWith([], [radiatorR, radiatorS]),
      wallId: 'w',
      objectId: 'R',
      offsetAlongWallM: 2.0, // onto radiatorS (2.0–2.6)
      offsetFromFloorM: 0.15,
    })
    expect(r.kind).toBe('rejected')
  })

  it('returns missing when the object is gone', () => {
    expect(moveWallMountedObject({ scene: sceneWith([], [radiatorR]), wallId: 'w', objectId: 'ghost', offsetAlongWallM: 2, offsetFromFloorM: 0.15 }).kind).toBe('missing')
  })
})

// ── Cross-wall move (re-host opening / wall_mounted onto another wall) ────────
function twoWallScene(openings: WallOpening[] = [], wallMounted: SpatialObject[] = []) {
  return makeRoom({
    category: 'living',
    walls: [
      makeWall({ id: 'wA', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 }, height_m: 2.5, openings, wall_mounted: wallMounted }),
      makeWall({ id: 'wB', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 }, height_m: 2.5 }),
    ],
  })
}

describe('moveWallObjectToWall', () => {
  it('re-hosts an opening from wall A to wall B', () => {
    const door = makeOpening({ id: 'D', host_wall_id: 'wA', type: 'door', offset_along_wall_m: 0.5, width_m: 0.8, offset_from_floor_m: 0, height_m: 2 })
    const r = moveWallObjectToWall({ scene: twoWallScene([door]), objectId: 'D', isOpening: true, fromWallId: 'wA', toWallId: 'wB', offsetAlongWallM: 1.0, offsetFromFloorM: 0 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      const wA = r.scene.walls.find((w) => w.id === 'wA')!
      const wB = r.scene.walls.find((w) => w.id === 'wB')!
      expect(wA.openings).toHaveLength(0)
      expect(wB.openings).toHaveLength(1)
      expect(wB.openings[0].host_wall_id).toBe('wB')
      expect(wB.openings[0].parent_id).toBe('wB')
      expect(wB.openings[0].offset_along_wall_m).toBeCloseTo(1.0)
    }
  })

  it('re-hosts a wall-mounted object from wall A to wall B', () => {
    const rad = makeObject({ id: 'R', category: 'radiator', host: 'wall', host_id: 'wA', offset_along_wall_m: 1.0, height_from_floor_m: 0.15, dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 } })
    const r = moveWallObjectToWall({ scene: twoWallScene([], [rad]), objectId: 'R', isOpening: false, fromWallId: 'wA', toWallId: 'wB', offsetAlongWallM: 1.0, offsetFromFloorM: 0.15 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      const wA = r.scene.walls.find((w) => w.id === 'wA')!
      const wB = r.scene.walls.find((w) => w.id === 'wB')!
      expect(wA.wall_mounted).toHaveLength(0)
      expect(wB.wall_mounted).toHaveLength(1)
      expect(wB.wall_mounted[0].host_id).toBe('wB')
      expect(wB.wall_mounted[0].offset_along_wall_m).toBeCloseTo(1.0)
    }
  })

  it('rejects a cross-wall move that overlaps an existing object on the target wall — nothing moves', () => {
    const movingRad = makeObject({ id: 'R', category: 'radiator', host: 'wall', host_id: 'wA', offset_along_wall_m: 1.0, height_from_floor_m: 0.15, dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 } })
    const blockerOnB = makeObject({ id: 'B', category: 'radiator', host: 'wall', host_id: 'wB', offset_along_wall_m: 1.0, height_from_floor_m: 0.15, dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 } })
    const scene = makeRoom({
      category: 'living',
      walls: [
        makeWall({ id: 'wA', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 }, height_m: 2.5, wall_mounted: [movingRad] }),
        makeWall({ id: 'wB', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 }, height_m: 2.5, wall_mounted: [blockerOnB] }),
      ],
    })
    const r = moveWallObjectToWall({ scene, objectId: 'R', isOpening: false, fromWallId: 'wA', toWallId: 'wB', offsetAlongWallM: 1.0, offsetFromFloorM: 0.15 })
    expect(r.kind).toBe('rejected')
    expect(r).not.toHaveProperty('scene')
  })

  it('returns missing when a wall or the object is gone', () => {
    const rad = makeObject({ id: 'R', category: 'radiator', host: 'wall', host_id: 'wA', offset_along_wall_m: 1.0, height_from_floor_m: 0.15, dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 } })
    expect(moveWallObjectToWall({ scene: twoWallScene([], [rad]), objectId: 'R', isOpening: false, fromWallId: 'wA', toWallId: 'ghost', offsetAlongWallM: 1, offsetFromFloorM: 0.15 }).kind).toBe('missing')
    expect(moveWallObjectToWall({ scene: twoWallScene([], [rad]), objectId: 'ghost', isOpening: false, fromWallId: 'wA', toWallId: 'wB', offsetAlongWallM: 1, offsetFromFloorM: 0.15 }).kind).toBe('missing')
  })
})
