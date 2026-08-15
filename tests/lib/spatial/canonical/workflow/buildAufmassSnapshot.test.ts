/**
 * Tests for canonical/workflow/buildAufmassSnapshot.ts.
 *
 * The snapshot must mirror the BoM figures exactly (net wall area + breakdown,
 * skirting length, room metrics) and carry a normalised floor-plan ring so the
 * Offer-PDF can render it without re-loading the scene.
 */

import { describe, it, expect } from 'vitest'

import { buildAufmassSnapshot } from '../../../../../src/lib/spatial/canonical/workflow/buildAufmassSnapshot.ts'
import type { Wall, WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { Vector3 } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'

function v(x: number, z: number): Vector3 {
  return { x, y: 0, z } as Vector3
}

function op(width_m: number, height_m: number, isPortal = false): WallOpening {
  return { width_m, height_m, is_walkable_portal: isPortal } as unknown as WallOpening
}

function wall(length_m: number, openings: WallOpening[], name: string): Wall {
  return {
    id: `w-${name}`,
    name,
    length_m,
    height_m: 2.5,
    openings,
    wall_mounted: [],
    start_point: v(0, 0),
    end_point: v(length_m, 0),
  } as unknown as Wall
}

function makeScene(): RoomScene {
  return {
    id: 'room',
    type: 'room',
    category: 'living',
    walls: [wall(4, [op(0.9, 2.1, true)], 'Nord'), wall(4, [], 'Ost')],
    floor: { id: 'floor', polygon: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)] },
    ceiling: { height_m: 2.5 },
    free_objects: [],
    computed_area_m2: 16,
    computed_volume_m3: 40,
    bounds_min: v(0, 0),
    bounds_max: v(4, 4),
  } as unknown as RoomScene
}

describe('buildAufmassSnapshot', () => {
  it('captures room metrics + a closed floor-plan ring', () => {
    const snap = buildAufmassSnapshot(makeScene())
    expect(snap.areaM2).toBe(16)
    expect(snap.volumeM3).toBe(40)
    expect(snap.ceilingHeightM).toBe(2.5)
    expect(snap.wallCount).toBe(2)
    expect(snap.perimeterM).toBe(16)
    expect(snap.floorPolygon).toHaveLength(4)
    // normalised into 0–100 space
    for (const p of snap.floorPolygon) {
      expect(p.xPct).toBeGreaterThanOrEqual(0)
      expect(p.xPct).toBeLessThanOrEqual(100)
    }
  })

  it('emits floor + skirting + per-wall measurements with the net breakdown', () => {
    const snap = buildAufmassSnapshot(makeScene())
    const floor = snap.measurements.find((m) => m.kind === 'floor')
    expect(floor).toMatchObject({ unit: 'm2', value: 16 })

    const skirting = snap.measurements.find((m) => m.kind === 'skirting')
    expect(skirting).toMatchObject({ unit: 'lfm', value: 15.1 }) // 16 − 0.9 door

    const walls = snap.measurements.filter((m) => m.kind === 'wall')
    expect(walls).toHaveLength(2)
    const nord = walls.find((m) => m.label === 'Nord')
    // gross 4×2.5 = 10; opening 0.9×2.1 = 1.89; net 8.11
    expect(nord).toMatchObject({ value: 8.11, grossM2: 10, openingsM2: 1.89 })
  })
})
