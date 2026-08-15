/**
 * Footprint-first floor/ceiling re-derivation.
 *
 * Proves the Lane-2.5 latent bug is fixed: AddWallCommand / DeleteWallCommand
 * now re-derive floor + ceiling polygons + room metrics from the wall ring on
 * every edit (via `rebuildFloorCeilingFromWalls`), so the empty-canvas floor
 * stays empty until the walls close a single loop, then populates — and re-opens
 * when a wall is removed. Previously the polygon never closed (the preset comment
 * claimed AddWall patched it; it did not).
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import {
  AddWallCommand,
  DeleteWallCommand,
} from '../../../../../src/lib/spatial/canonical/commands/index.ts'
import {
  buildEmptyCanvasPreset,
  buildEmptyRoom2x2Preset,
} from '../../../../../src/lib/spatial/canonical/presets/presetEmptyRoom.ts'
import {
  inferFloorPolygonFromWalls,
  rebuildFloorCeilingFromWalls,
} from '../../../../../src/lib/spatial/canonical/geometry/footprint.ts'

const ROOM = 'room_1'
const VARIANT = 'customer_corrections'
const T = '2026-06-04T00:00:00.000Z'

function ctx() {
  return useCanonicalSceneStore.getState()
}

/** A 4×3 m rectangle as a CCW chain of shared-endpoint segments. */
const RECT = [
  { id: 'w1', start: { x: 0, y: 0, z: 0 }, end: { x: 4, y: 0, z: 0 } },
  { id: 'w2', start: { x: 4, y: 0, z: 0 }, end: { x: 4, y: 0, z: 3 } },
  { id: 'w3', start: { x: 4, y: 0, z: 3 }, end: { x: 0, y: 0, z: 3 } },
  { id: 'w4', start: { x: 0, y: 0, z: 3 }, end: { x: 0, y: 0, z: 0 } },
]

function addWall(w: (typeof RECT)[number]) {
  new AddWallCommand({
    wallId: w.id,
    roomId: ROOM,
    start: w.start,
    end: w.end,
    heightM: 2.5,
    thicknessM: 0.15,
    variantId: VARIANT,
    createdAt: T,
  }).do(ctx())
}

beforeEach(() => {
  ctx().setScene(buildEmptyCanvasPreset({ roomNodeId: ROOM, createdAt: T }))
  ctx().setOverrides([])
})

describe('footprint-first floor/ceiling re-derivation (AddWall / DeleteWall)', () => {
  it('empty canvas starts with zero walls + an empty floor polygon', () => {
    expect(ctx().scene?.walls).toHaveLength(0)
    expect(ctx().scene?.floor.polygon).toEqual([])
    expect(ctx().scene?.computed_area_m2).toBe(0)
  })

  it('floor stays empty while the ring is open, then populates when it closes', () => {
    addWall(RECT[0])
    addWall(RECT[1])
    addWall(RECT[2]) // 3 of 4 — chain is open
    expect(ctx().scene?.floor.polygon).toEqual([])
    expect(ctx().scene?.computed_area_m2).toBe(0)

    addWall(RECT[3]) // ring closes
    expect(ctx().scene?.floor.polygon).toHaveLength(4)
    expect(ctx().scene?.ceiling.polygon).toHaveLength(4)
    expect(ctx().scene?.computed_area_m2).toBeCloseTo(12, 6)
    expect(ctx().scene?.computed_volume_m3).toBeCloseTo(12 * 2.5, 6)
    expect(ctx().scene?.bounds_max).toMatchObject({ x: 4, y: 2.5, z: 3 })
  })

  it('deleting a wall re-opens the ring (floor empties); undo re-closes it', () => {
    RECT.forEach(addWall)
    expect(ctx().scene?.floor.polygon).toHaveLength(4)

    const del = new DeleteWallCommand({ wallId: 'w2', roomId: ROOM, variantId: VARIANT })
    del.do(ctx())
    expect(ctx().scene?.walls).toHaveLength(3)
    expect(ctx().scene?.floor.polygon).toEqual([])
    expect(ctx().scene?.computed_area_m2).toBe(0)

    del.undo(ctx())
    expect(ctx().scene?.walls).toHaveLength(4)
    expect(ctx().scene?.floor.polygon).toHaveLength(4)
    expect(ctx().scene?.computed_area_m2).toBeCloseTo(12, 6)
  })
})

describe('rebuildFloorCeilingFromWalls + inferFloorPolygonFromWalls (pure)', () => {
  it('is idempotent on the closed 2×2 preset', () => {
    const scene = buildEmptyRoom2x2Preset({
      roomNodeId: ROOM,
      footprintMeters: { widthM: 2, depthM: 2 },
      createdAt: T,
    })
    const rebuilt = rebuildFloorCeilingFromWalls(scene)
    expect(rebuilt.floor.polygon).toHaveLength(4)
    expect(rebuilt.ceiling.polygon).toHaveLength(4)
    expect(rebuilt.computed_area_m2).toBeCloseTo(4, 6)
    expect(rebuilt.computed_volume_m3).toBeCloseTo(4 * 2.5, 6)
  })

  it('returns an empty polygon for an open chain (< closed ring)', () => {
    const scene = buildEmptyRoom2x2Preset({
      roomNodeId: ROOM,
      footprintMeters: { widthM: 2, depthM: 2 },
      createdAt: T,
    })
    expect(inferFloorPolygonFromWalls(scene.walls.slice(0, 2))).toEqual([])
    expect(inferFloorPolygonFromWalls([])).toEqual([])
  })
})
