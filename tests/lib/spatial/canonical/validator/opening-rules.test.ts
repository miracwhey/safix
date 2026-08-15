/**
 * Tests for validator/rules/opening-rules.ts
 */
import { describe, it, expect } from 'vitest'

import {
  checkDoorHostWallAmbiguous,
  checkDoorHostWallNotFound,
  checkDoorOutsideWallBounds,
  checkWindowAboveCeiling,
  checkWindowBelowFloor,
  checkWindowOutsideWallBounds,
} from '../../../../../src/lib/spatial/canonical/validator/rules/opening-rules.ts'
import { makeOpening, makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

describe('opening-rules · DOOR_HOST_WALL_NOT_FOUND', () => {
  it('emits an error when host_wall_id is unknown', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'ghost', type: 'door' })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    const issues = checkDoorHostWallNotFound(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('DOOR_HOST_WALL_NOT_FOUND')
  })

  it('passes when host_wall_id is one of the room walls', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w1', type: 'door' })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkDoorHostWallNotFound(scene)).toEqual([])
  })
})

describe('opening-rules · DOOR_OUTSIDE_WALL_BOUNDS', () => {
  it('flags doors that extend beyond the wall length', () => {
    const door = makeOpening({
      id: 'd1',
      host_wall_id: 'w1',
      type: 'door',
      offset_along_wall_m: 3.5,
      width_m: 1.2, // overflow: 3.5 + 1.2 = 4.7 > wall length 4
    })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkDoorOutsideWallBounds(scene)).toHaveLength(1)
  })

  it('passes doors that fit', () => {
    const door = makeOpening({
      id: 'd1',
      host_wall_id: 'w1',
      type: 'door',
      offset_along_wall_m: 1.5,
      width_m: 0.9,
    })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkDoorOutsideWallBounds(scene)).toEqual([])
  })
})

describe('opening-rules · WINDOW_OUTSIDE_WALL_BOUNDS', () => {
  it('flags windows that extend beyond the wall length', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_along_wall_m: 3.5,
      width_m: 1.5,
    })
    const wall = makeWall({ id: 'w1', openings: [win] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowOutsideWallBounds(scene)).toHaveLength(1)
  })

  it('does not flag windows that fit', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_along_wall_m: 1,
      width_m: 0.8,
    })
    const wall = makeWall({ id: 'w1', openings: [win] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowOutsideWallBounds(scene)).toEqual([])
  })
})

describe('opening-rules · WINDOW_BELOW_FLOOR', () => {
  it('flags windows with negative floor offset', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_from_floor_m: -0.1,
    })
    const wall = makeWall({ id: 'w1', openings: [win] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowBelowFloor(scene)).toHaveLength(1)
  })

  it('does not flag windows above the floor', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_from_floor_m: 0.8,
    })
    const wall = makeWall({ id: 'w1', openings: [win] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowBelowFloor(scene)).toEqual([])
  })
})

describe('opening-rules · WINDOW_ABOVE_CEILING', () => {
  it('flags windows whose top exceeds wall height', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_from_floor_m: 2,
      height_m: 1, // top at 3 > wall height 2.5
    })
    const wall = makeWall({ id: 'w1', openings: [win], height_m: 2.5 })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowAboveCeiling(scene)).toHaveLength(1)
  })

  it('does not flag windows that fit vertically', () => {
    const win = makeOpening({
      id: 'win1',
      host_wall_id: 'w1',
      type: 'window',
      offset_from_floor_m: 0.8,
      height_m: 1.2,
    })
    const wall = makeWall({ id: 'w1', openings: [win], height_m: 2.5 })
    const scene = makeRoom({ walls: [wall] })
    expect(checkWindowAboveCeiling(scene)).toEqual([])
  })
})

describe('opening-rules · DOOR_HOST_WALL_AMBIGUOUS (H17 audit-fix)', () => {
  it('emits a warning when host_wall_confidence is below 1.0', () => {
    const door = makeOpening({
      id: 'd1',
      host_wall_id: 'w1',
      type: 'door',
      host_wall_confidence: 0.5,
    })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    const issues = checkDoorHostWallAmbiguous(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('DOOR_HOST_WALL_AMBIGUOUS')
    expect(issues[0].severity).toBe('warning')
  })

  it('stays silent when host_wall_confidence is 1.0', () => {
    const door = makeOpening({
      id: 'd1',
      host_wall_id: 'w1',
      type: 'door',
      host_wall_confidence: 1.0,
    })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkDoorHostWallAmbiguous(scene)).toEqual([])
  })

  it('stays silent when host_wall_confidence is undefined (bridge did not annotate)', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w1', type: 'door' })
    const wall = makeWall({ id: 'w1', openings: [door] })
    const scene = makeRoom({ walls: [wall] })
    expect(checkDoorHostWallAmbiguous(scene)).toEqual([])
  })
})
