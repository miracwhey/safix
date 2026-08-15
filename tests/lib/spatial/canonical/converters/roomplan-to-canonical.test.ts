/**
 * Tests for src/lib/spatial/canonical/converters/roomplan-to-canonical.ts
 *
 * Acceptance: a minimal RoomPlan-shape dump round-trips through the
 * converter and produces a valid canonical RoomScene. The test surface
 * focuses on the high-value paths (host-wall matching, confidence
 * mapping, default floor) — the full block-A bridge tests live in
 * Day 8 B14.
 */
import { describe, it, expect } from 'vitest'

import {
  convertRoomPlanToCanonical,
  type RoomPlanRoomDump,
} from '../../../../../src/lib/spatial/canonical/converters/roomplan-to-canonical.ts'

function basicDump(): RoomPlanRoomDump {
  return {
    identifier: 'room_001',
    captured_at: '2026-05-20T00:00:00.000Z',
    category: 'bathroom',
    walls: [
      {
        identifier: 'w_s',
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 0 },
        dimensions: { width_m: 4, height_m: 2.5 },
        confidence: 'high',
      },
      {
        identifier: 'w_e',
        start_point: { x: 4, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 3 },
        dimensions: { width_m: 3, height_m: 2.5 },
        confidence: 'high',
      },
      {
        identifier: 'w_n',
        start_point: { x: 4, y: 0, z: 3 },
        end_point: { x: 0, y: 0, z: 3 },
        dimensions: { width_m: 4, height_m: 2.5 },
        confidence: 'medium',
      },
      {
        identifier: 'w_w',
        start_point: { x: 0, y: 0, z: 3 },
        end_point: { x: 0, y: 0, z: 0 },
        dimensions: { width_m: 3, height_m: 2.5 },
        confidence: 'low',
      },
    ],
    doors: [
      {
        identifier: 'd_main',
        position: { x: 2, y: 0, z: -0.05 },
        dimensions: { width_m: 0.9, height_m: 2 },
        confidence: 'high',
        swing_direction: 'left',
      },
    ],
    windows: [
      {
        identifier: 'win_e',
        position: { x: 4.05, y: 0, z: 1.5 },
        dimensions: { width_m: 1.2, height_m: 0.8 },
        offset_from_floor_m: 0.9,
      },
    ],
    openings: [],
    objects: [
      {
        identifier: 'sink',
        category: 'sink',
        position: { x: 0.6, y: 0, z: 1.5 },
        dimensions: { width_m: 0.5, depth_m: 0.4, height_m: 0.85 },
      },
    ],
    floors: [
      {
        polygon: [
          { x: 0, y: 0, z: 0 },
          { x: 4, y: 0, z: 0 },
          { x: 4, y: 0, z: 3 },
          { x: 0, y: 0, z: 3 },
        ],
      },
    ],
  }
}

describe('convertRoomPlanToCanonical · structural', () => {
  it('produces a canonical room with 4 walls + floor + ceiling', () => {
    const { scene, warnings } = convertRoomPlanToCanonical(basicDump())
    expect(scene.walls).toHaveLength(4)
    expect(scene.floor.polygon).toHaveLength(4)
    expect(scene.ceiling.polygon).toHaveLength(4)
    expect(warnings).toEqual([])
  })

  it('matches the door to its south-wall host', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    const southWall = scene.walls.find(w => w.id === 'w_s')!
    expect(southWall.openings).toHaveLength(1)
    expect(southWall.openings[0].type).toBe('door')
  })

  it('attaches the window to its east-wall host', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    const eastWall = scene.walls.find(w => w.id === 'w_e')!
    expect(eastWall.openings.find(o => o.type === 'window')).toBeDefined()
  })

  it('maps RoomPlan confidence to numeric values', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    expect(scene.walls.find(w => w.id === 'w_s')?.confidence).toBeCloseTo(0.9, 6)
    expect(scene.walls.find(w => w.id === 'w_n')?.confidence).toBeCloseTo(0.6, 6)
    expect(scene.walls.find(w => w.id === 'w_w')?.confidence).toBeCloseTo(0.3, 6)
  })

  it('assigns the bathroom category', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    expect(scene.category).toBe('bathroom')
  })

  it('derives ceiling height from median wall height', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    expect(scene.ceiling.height_m).toBeCloseTo(2.5, 6)
  })

  it('computes bounds from wall endpoints', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    expect(scene.bounds_max.x).toBeCloseTo(4, 6)
    expect(scene.bounds_max.z).toBeCloseTo(3, 6)
  })

  it('treats sink as a floor-mounted object by default', () => {
    const { scene } = convertRoomPlanToCanonical(basicDump())
    expect(scene.free_objects.length + scene.floor.floor_mounted.length).toBeGreaterThan(0)
  })

  it('F12 — reads the measured wall depth_m as thickness when present', () => {
    const dump = basicDump()
    dump.walls[0].dimensions = { width_m: 4, height_m: 2.5, depth_m: 0.24 }
    const { scene } = convertRoomPlanToCanonical(dump)
    expect(scene.walls.find(w => w.id === 'w_s')?.thickness_m).toBeCloseTo(0.24, 6)
  })

  it('F12 — falls back to the 0.15 m default when depth_m is absent', () => {
    // basicDump()'s walls carry no depth_m.
    const { scene } = convertRoomPlanToCanonical(basicDump())
    for (const w of scene.walls) {
      expect(w.thickness_m).toBeCloseTo(0.15, 6)
    }
  })

  it('F12 — falls back to the default for a non-positive / non-finite depth_m', () => {
    const dump = basicDump()
    dump.walls[0].dimensions = { width_m: 4, height_m: 2.5, depth_m: 0 }
    dump.walls[1].dimensions = { width_m: 3, height_m: 2.5, depth_m: Number.NaN }
    const { scene } = convertRoomPlanToCanonical(dump)
    expect(scene.walls.find(w => w.id === 'w_s')?.thickness_m).toBeCloseTo(0.15, 6)
    expect(scene.walls.find(w => w.id === 'w_e')?.thickness_m).toBeCloseTo(0.15, 6)
  })
})
