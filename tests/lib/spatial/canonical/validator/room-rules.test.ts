/**
 * Tests for validator/rules/room-rules.ts
 */
import { describe, it, expect } from 'vitest'

import {
  checkFloorSelfIntersecting,
  checkRoomBoundsTooSmall,
  checkRoomHasNoDoors,
  checkRoomNoCeiling,
  checkRoomNoFloor,
  checkRoomNoWalls,
  checkRoomNoWindows,
} from '../../../../../src/lib/spatial/canonical/validator/rules/room-rules.ts'
import { makeOpening, makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

describe('room-rules · ROOM_NO_FLOOR / NO_WALLS', () => {
  it('flags rooms without a floor polygon', () => {
    const scene = makeRoom({ floor: { ...makeRoom().floor, polygon: [] } })
    expect(checkRoomNoFloor(scene)).toHaveLength(1)
  })

  it('flags rooms with fewer than three walls', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1' })] })
    expect(checkRoomNoWalls(scene)).toHaveLength(1)
  })
})

describe('room-rules · ROOM_BOUNDS_TOO_SMALL', () => {
  it('flags rooms below 1 m²', () => {
    const scene = makeRoom({ computed_area_m2: 0.4 })
    expect(checkRoomBoundsTooSmall(scene)).toHaveLength(1)
  })

  it('does not flag rooms above the threshold', () => {
    const scene = makeRoom({ computed_area_m2: 12 })
    expect(checkRoomBoundsTooSmall(scene)).toEqual([])
  })
})

describe('room-rules · ROOM_HAS_NO_DOORS', () => {
  it('warns when no door / opening is present', () => {
    const scene = makeRoom()
    expect(checkRoomHasNoDoors(scene)).toHaveLength(1)
  })

  it('passes when at least one door is present', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door' })
    const wallWithDoor = { ...makeWall({ id: 'w_s' }), openings: [door] }
    const scene = makeRoom({ walls: [wallWithDoor, makeWall({ id: 'w2' }), makeWall({ id: 'w3' }), makeWall({ id: 'w4' })] })
    expect(checkRoomHasNoDoors(scene)).toEqual([])
  })
})

describe('room-rules · ROOM_NO_CEILING / NO_WINDOWS', () => {
  it('hints when ceiling polygon is empty', () => {
    const scene = makeRoom({ ceiling: { ...makeRoom().ceiling, polygon: [] } })
    expect(checkRoomNoCeiling(scene)).toHaveLength(1)
    expect(checkRoomNoCeiling(scene)[0].severity).toBe('hint')
  })

  it('hints when no window is present', () => {
    const scene = makeRoom()
    expect(checkRoomNoWindows(scene)).toHaveLength(1)
  })
})

describe('room-rules · FLOOR_SELF_INTERSECTING', () => {
  it('flags a bow-tie polygon', () => {
    const bowtie = makeRoom({
      floor: {
        ...makeRoom().floor,
        polygon: [
          { x: 0, y: 0, z: 0 },
          { x: 4, y: 0, z: 0 },
          { x: 0, y: 0, z: 4 },
          { x: 4, y: 0, z: 4 },
        ],
      },
    })
    expect(checkFloorSelfIntersecting(bowtie)).toHaveLength(1)
  })

  it('does not flag a regular convex polygon', () => {
    expect(checkFloorSelfIntersecting(makeRoom())).toEqual([])
  })
})
