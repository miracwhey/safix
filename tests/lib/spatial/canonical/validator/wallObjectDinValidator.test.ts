/**
 * wallObjectDinValidator — Phase-L1 DIN/VDE soft-warn contract.
 *
 * Every rule is a soft-warn (never blocks — that is objectPositionValidator's
 * job). These lock the per-rule firing conditions + the DIN auto-snap pull.
 */
import { describe, expect, it } from 'vitest'

import {
  evaluateWallObjectDin,
  snapWallObjectVerticalToDin,
  summarizeDinWarnings,
  type DinWarningCode,
} from '../../../../../src/lib/spatial/canonical/validator/wallObjectDinValidator.ts'
import { makeObject, makeOpening, makeWall } from '../__helpers__/sceneFactory.ts'
import type { Wall, WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'

const WALL_LEN = 4

function wallWith(openings: WallOpening[] = [], wallMounted: SpatialObject[] = []): Wall {
  return makeWall({
    id: 'w',
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: WALL_LEN, y: 0, z: 0 },
    height_m: 2.5,
    openings,
    wall_mounted: wallMounted,
  })
}

function codes(warnings: { code: DinWarningCode }[]): DinWarningCode[] {
  return warnings.map((w) => w.code)
}

const radiator = (over: Partial<SpatialObject> = {}) =>
  makeObject({
    id: 'R',
    category: 'radiator',
    host: 'wall',
    host_id: 'w',
    offset_along_wall_m: 1.0,
    height_from_floor_m: 0.15,
    dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 1.6 },
    ...over,
  })

const outlet = (over: Partial<SpatialObject> = {}) =>
  makeObject({
    id: 'O',
    category: 'electrical_outlet',
    host: 'wall',
    host_id: 'w',
    offset_along_wall_m: 1.0,
    height_from_floor_m: 0.3,
    dimensions: { width_m: 0.08, depth_m: 0.022, height_m: 0.08 },
    ...over,
  })

const lightSwitch = (over: Partial<SpatialObject> = {}) =>
  makeObject({
    id: 'S',
    category: 'light_switch',
    host: 'wall',
    host_id: 'w',
    offset_along_wall_m: 1.0,
    height_from_floor_m: 1.05,
    dimensions: { width_m: 0.08, depth_m: 0.022, height_m: 0.08 },
    ...over,
  })

describe('evaluateWallObjectDin · openings', () => {
  it('warns when a door sits within 20 cm of a corner', () => {
    const door = makeOpening({ id: 'A', host_wall_id: 'w', type: 'door', offset_along_wall_m: 0.05, width_m: 0.8 })
    const w = evaluateWallObjectDin({ wall: wallWith([door]), wallLengthM: WALL_LEN, candidate: { kind: 'opening', opening: door }, roomCategory: 'living' })
    expect(codes(w)).toContain('DIN_DOOR_NEAR_CORNER')
  })

  it('does not warn for a centered door', () => {
    const door = makeOpening({ id: 'A', host_wall_id: 'w', type: 'door', offset_along_wall_m: 1.6, width_m: 0.8 })
    const w = evaluateWallObjectDin({ wall: wallWith([door]), wallLengthM: WALL_LEN, candidate: { kind: 'opening', opening: door }, roomCategory: 'living' })
    expect(codes(w)).not.toContain('DIN_DOOR_NEAR_CORNER')
  })

  it('warns for a low window sill (< 80 cm) but not for a normal one', () => {
    const low = makeOpening({ id: 'B', host_wall_id: 'w', type: 'window', offset_along_wall_m: 2.0, width_m: 0.8, offset_from_floor_m: 0.5, height_m: 1.0 })
    const ok = makeOpening({ id: 'B', host_wall_id: 'w', type: 'window', offset_along_wall_m: 2.0, width_m: 0.8, offset_from_floor_m: 0.9, height_m: 1.0 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([low]), wallLengthM: WALL_LEN, candidate: { kind: 'opening', opening: low }, roomCategory: 'living' }))).toContain('DIN_WINDOW_SILL_LOW')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([ok]), wallLengthM: WALL_LEN, candidate: { kind: 'opening', opening: ok }, roomCategory: 'living' }))).not.toContain('DIN_WINDOW_SILL_LOW')
  })
})

describe('evaluateWallObjectDin · heights', () => {
  it('warns when a light switch height is off the DIN band, not when on it', () => {
    const off = lightSwitch({ height_from_floor_m: 1.5 })
    const on = lightSwitch({ height_from_floor_m: 1.05 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [off]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: off }, roomCategory: 'living' }))).toContain('DIN_SWITCH_HEIGHT')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [on]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: on }, roomCategory: 'living' }))).not.toContain('DIN_SWITCH_HEIGHT')
  })

  it('accepts an outlet at either DIN band (30 cm / 110 cm) and warns in between', () => {
    const low = outlet({ height_from_floor_m: 0.3 })
    const high = outlet({ height_from_floor_m: 1.1 })
    const mid = outlet({ height_from_floor_m: 0.65 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [low]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: low }, roomCategory: 'living' }))).not.toContain('DIN_OUTLET_HEIGHT')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [high]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: high }, roomCategory: 'living' }))).not.toContain('DIN_OUTLET_HEIGHT')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [mid]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: mid }, roomCategory: 'living' }))).toContain('DIN_OUTLET_HEIGHT')
  })
})

describe('evaluateWallObjectDin · cross-object', () => {
  it('warns when a radiator is NOT under a window, not when it is', () => {
    const rad = radiator({ offset_along_wall_m: 1.0 })
    const window = makeOpening({ id: 'B', host_wall_id: 'w', type: 'window', offset_along_wall_m: 0.9, width_m: 1.0, offset_from_floor_m: 0.9, height_m: 1.0 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [rad]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: rad }, roomCategory: 'living' }))).toContain('DIN_RADIATOR_NOT_UNDER_WINDOW')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([window], [rad]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: rad }, roomCategory: 'living' }))).not.toContain('DIN_RADIATOR_NOT_UNDER_WINDOW')
  })

  it('warns (VDE 0100-520) when an outlet sits within 50 cm of a radiator', () => {
    const rad = radiator({ id: 'R', offset_along_wall_m: 1.0 })
    const near = outlet({ id: 'O', offset_along_wall_m: 1.2, height_from_floor_m: 0.3 })
    const far = outlet({ id: 'O', offset_along_wall_m: 3.5, height_from_floor_m: 0.3 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [rad, near]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: near }, excludeId: 'O', roomCategory: 'living' }))).toContain('DIN_OUTLET_NEAR_HEATING')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [rad, far]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: far }, excludeId: 'O', roomCategory: 'living' }))).not.toContain('DIN_OUTLET_NEAR_HEATING')
  })
})

describe('evaluateWallObjectDin · bathroom zone', () => {
  it('fires VDE 0100-701 only for electrical in a bathroom', () => {
    const o = outlet({ height_from_floor_m: 0.3, offset_along_wall_m: 3.0 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [o]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: o }, roomCategory: 'bathroom' }))).toContain('DIN_BATHROOM_ZONE')
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [o]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: o }, roomCategory: 'living' }))).not.toContain('DIN_BATHROOM_ZONE')
    // A radiator in a bathroom is not electrical → no zone reminder.
    const rad = radiator({ offset_along_wall_m: 3.0 })
    expect(codes(evaluateWallObjectDin({ wall: wallWith([], [rad]), wallLengthM: WALL_LEN, candidate: { kind: 'wall_mounted', object: rad }, roomCategory: 'bathroom' }))).not.toContain('DIN_BATHROOM_ZONE')
  })
})

describe('snapWallObjectVerticalToDin', () => {
  it('pulls a switch toward 1.05 m only within range', () => {
    expect(snapWallObjectVerticalToDin('light_switch', 1.02)).toBeCloseTo(1.05)
    expect(snapWallObjectVerticalToDin('light_switch', 1.3)).toBeCloseTo(1.3)
  })

  it('pulls an outlet toward the nearest of 0.30 / 1.10 m', () => {
    expect(snapWallObjectVerticalToDin('electrical_outlet', 0.33)).toBeCloseTo(0.3)
    expect(snapWallObjectVerticalToDin('electrical_outlet', 1.05)).toBeCloseTo(1.1)
    expect(snapWallObjectVerticalToDin('electrical_outlet', 0.6)).toBeCloseTo(0.6)
  })

  it('leaves non-snapping categories unchanged', () => {
    expect(snapWallObjectVerticalToDin('radiator', 0.5)).toBeCloseTo(0.5)
  })
})

describe('summarizeDinWarnings', () => {
  it('returns empty for no warnings and a "+N" suffix for many', () => {
    expect(summarizeDinWarnings([])).toBe('')
    const w = evaluateWallObjectDin({
      wall: wallWith([], [outlet({ height_from_floor_m: 0.65, offset_along_wall_m: 3.0 })]),
      wallLengthM: WALL_LEN,
      candidate: { kind: 'wall_mounted', object: outlet({ height_from_floor_m: 0.65, offset_along_wall_m: 3.0 }) },
      roomCategory: 'bathroom',
    })
    expect(w.length).toBeGreaterThanOrEqual(2) // outlet-height + bathroom-zone
    expect(summarizeDinWarnings(w)).toContain('+')
  })
})
