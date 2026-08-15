/**
 * Tests for validator/rules/object-rules.ts
 */
import { describe, it, expect } from 'vitest'

import {
  checkObjectClearanceViolated,
  checkObjectFloating,
  checkObjectHostNotFound,
  checkObjectOutsideRoomBounds,
} from '../../../../../src/lib/spatial/canonical/validator/rules/object-rules.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import { makeObject, makeRoom } from '../__helpers__/sceneFactory.ts'

describe('object-rules · OBJECT_HOST_NOT_FOUND', () => {
  it('flags objects whose host wall does not exist', () => {
    const obj = makeObject({
      id: 'sink',
      category: 'sink',
      host: 'wall',
      host_id: 'nonexistent_wall',
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectHostNotFound(scene)).toHaveLength(1)
  })

  it('passes when host wall exists', () => {
    const obj = makeObject({
      id: 'sink',
      category: 'sink',
      host: 'wall',
      host_id: 'w_s',
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectHostNotFound(scene)).toEqual([])
  })

  it('passes when a counter-hosted object references an existing object', () => {
    const vanity = makeObject({ id: 'vanity', category: 'sink', host: 'free', host_id: 'vanity' })
    const soap = makeObject({ id: 'soap', category: 'sink', host: 'counter', host_id: 'vanity' })
    const scene = makeRoom({ free_objects: [vanity, soap] })
    expect(checkObjectHostNotFound(scene)).toEqual([])
  })

  it('flags a counter-hosted object whose host object is missing', () => {
    const soap = makeObject({ id: 'soap', category: 'sink', host: 'counter', host_id: 'ghost' })
    const scene = makeRoom({ free_objects: [soap] })
    expect(checkObjectHostNotFound(scene)).toHaveLength(1)
  })

  it('flags a counter-hosted object that hosts itself', () => {
    const obj = makeObject({ id: 'loop', category: 'sink', host: 'counter', host_id: 'loop' })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectHostNotFound(scene)).toHaveLength(1)
  })
})

describe('object-rules · OBJECT_OUTSIDE_ROOM_BOUNDS', () => {
  it('flags objects beyond the room AABB', () => {
    const obj = makeObject({
      id: 'far',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 100, y: 0, z: 100 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectOutsideRoomBounds(scene)).toHaveLength(1)
  })

  it('passes objects inside the AABB', () => {
    const obj = makeObject({
      id: 'inside',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 2, y: 0, z: 1.5 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectOutsideRoomBounds(scene)).toEqual([])
  })
})

describe('object-rules · OBJECT_FLOATING', () => {
  it('warns when a floor-mounted object hangs above the floor', () => {
    const obj = makeObject({
      id: 'wc',
      category: 'toilet',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 1, y: 0.4, z: 1 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectFloating(scene)).toHaveLength(1)
  })

  it('does not warn for objects sitting on the floor', () => {
    const obj = makeObject({
      id: 'wc',
      category: 'toilet',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 1, y: 0, z: 1 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    })
    const scene = makeRoom({ free_objects: [obj] })
    expect(checkObjectFloating(scene)).toEqual([])
  })
})

describe('object-rules · OBJECT_CLEARANCE_VIOLATED', () => {
  it('warns when two floor-mounted objects sit on top of each other', () => {
    const a = makeObject({
      id: 'a',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 1, y: 0, z: 1 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
      dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.8 },
    })
    const b = makeObject({
      id: 'b',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 1.1, y: 0, z: 1.1 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
      dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.8 },
    })
    const scene = makeRoom({ free_objects: [a, b] })
    expect(checkObjectClearanceViolated(scene)).toHaveLength(1)
  })

  it('does not warn for well-separated objects', () => {
    const a = makeObject({
      id: 'a',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 0.5, y: 0, z: 0.5 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
      dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.8 },
    })
    const b = makeObject({
      id: 'b',
      category: 'sofa',
      host: 'floor',
      host_id: 'floor',
      transform: { position: { x: 3, y: 0, z: 2.5 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
      dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.8 },
    })
    const scene = makeRoom({ free_objects: [a, b] })
    expect(checkObjectClearanceViolated(scene)).toEqual([])
  })
})
