/**
 * Tests for canonical/workflow/bomAutoItems.ts — pure geometry → BoM logic.
 *
 * Covers the Block-1 quantity-correctness work:
 *   - computeWallSurfaceArea: gross − openings, clamp ≥ 0
 *   - polygonPerimeterM: closed-ring edge sum (XZ-plane), degenerate guard
 *   - computeFloorPerimeterForBom: perimeter − walkable-portal widths (skirting)
 *   - generateAutoItems: wall item bills NET + carries areaBreakdown; a skirting
 *     (Sockelleiste · lfm) item is emitted with a non-colliding nodeId.
 *
 * Geometry inputs are built as minimal partial literals cast to the canonical
 * types — these are pure math functions that only read the fields asserted on.
 */

import { describe, it, expect } from 'vitest'

import {
  computeWallSurfaceArea,
  polygonPerimeterM,
  computeFloorPerimeterForBom,
  generateAutoItems,
} from '../../../../../src/lib/spatial/canonical/workflow/bomAutoItems.ts'
import type { Wall, WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { Vector3 } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function v(x: number, z: number): Vector3 {
  return { x, y: 0, z } as Vector3
}

function op(width_m: number, height_m: number, isPortal = false): WallOpening {
  return { width_m, height_m, is_walkable_portal: isPortal } as unknown as WallOpening
}

function wall(over: { length_m: number; height_m: number; openings: WallOpening[]; id?: string; name?: string }): Wall {
  return {
    id: over.id ?? 'w1',
    name: over.name ?? 'Wand 1',
    length_m: over.length_m,
    height_m: over.height_m,
    openings: over.openings,
    wall_mounted: [],
    start_point: v(0, 0),
    end_point: v(over.length_m, 0),
  } as unknown as Wall
}

// ─── computeWallSurfaceArea ──────────────────────────────────────────────────

describe('computeWallSurfaceArea', () => {
  it('returns gross when the wall has no openings', () => {
    const w = wall({ length_m: 5, height_m: 2.5, openings: [] })
    expect(computeWallSurfaceArea(w)).toEqual({ grossM2: 12.5, openingsM2: 0, netM2: 12.5 })
  })

  it('subtracts door + window opening areas from gross', () => {
    // gross = 5 × 2.5 = 12.5; openings = 1×2.1 + 1.2×1.2 = 2.1 + 1.44 = 3.54
    const w = wall({
      length_m: 5,
      height_m: 2.5,
      openings: [op(1, 2.1, true), op(1.2, 1.2)],
    })
    expect(computeWallSurfaceArea(w)).toEqual({ grossM2: 12.5, openingsM2: 3.54, netM2: 8.96 })
  })

  it('clamps net to 0 when openings exceed the wall area', () => {
    // gross = 1 × 2 = 2; opening 3×3 = 9 → net clamps to 0 (never negative)
    const w = wall({ length_m: 1, height_m: 2, openings: [op(3, 3)] })
    const area = computeWallSurfaceArea(w)
    expect(area.grossM2).toBe(2)
    expect(area.netM2).toBe(0)
  })
})

// ─── polygonPerimeterM ───────────────────────────────────────────────────────

describe('polygonPerimeterM', () => {
  it('sums the closed-ring edge lengths of a 4×4 square', () => {
    expect(polygonPerimeterM([v(0, 0), v(4, 0), v(4, 4), v(0, 4)])).toBe(16)
  })

  it('ignores the Y axis (XZ-plane projection)', () => {
    const ring = [
      { x: 0, y: 3, z: 0 },
      { x: 4, y: 9, z: 0 },
      { x: 4, y: 1, z: 4 },
      { x: 0, y: 7, z: 4 },
    ] as Vector3[]
    expect(polygonPerimeterM(ring)).toBe(16)
  })

  it('returns 0 for a degenerate (<2-vertex) polygon', () => {
    expect(polygonPerimeterM([v(1, 1)])).toBe(0)
    expect(polygonPerimeterM([])).toBe(0)
  })
})

// ─── computeFloorPerimeterForBom ─────────────────────────────────────────────

describe('computeFloorPerimeterForBom', () => {
  const square = [v(0, 0), v(4, 0), v(4, 4), v(0, 4)]

  it('subtracts walkable-portal widths from the perimeter', () => {
    // perimeter 16; one door 0.9 wide (walkable) → skirting 15.1
    const walls = [wall({ length_m: 4, height_m: 2.5, openings: [op(0.9, 2.1, true)] })]
    expect(computeFloorPerimeterForBom(square, walls)).toEqual({
      perimeterM: 16,
      doorWidthsM: 0.9,
      skirtingM: 15.1,
    })
  })

  it('does NOT subtract windows (non-walkable openings keep their skirting)', () => {
    const walls = [wall({ length_m: 4, height_m: 2.5, openings: [op(1.2, 1.2, false)] })]
    const result = computeFloorPerimeterForBom(square, walls)
    expect(result.doorWidthsM).toBe(0)
    expect(result.skirtingM).toBe(16)
  })
})

// ─── generateAutoItems ───────────────────────────────────────────────────────

function makeScene(): RoomScene {
  return {
    id: 'room',
    type: 'room',
    category: 'living',
    walls: [wall({ length_m: 4, height_m: 2.5, openings: [op(0.9, 2.1, true)] })],
    floor: { id: 'floor', polygon: [v(0, 0), v(4, 0), v(4, 4), v(0, 4)] },
    free_objects: [],
    computed_area_m2: 16,
    computed_volume_m3: 40,
    bounds_min: v(0, 0),
    bounds_max: v(4, 4),
  } as unknown as RoomScene
}

describe('generateAutoItems', () => {
  it('bills the wall NET area and carries the gross/openings/net breakdown', () => {
    const items = generateAutoItems(makeScene())
    const wallItem = items.find((i) => i.category === 'Wand')
    expect(wallItem).toBeDefined()
    // gross = 4 × 2.5 = 10; opening 0.9 × 2.1 = 1.89; net = 8.11
    expect(wallItem!.quantity).toBe(8.11)
    expect(wallItem!.areaBreakdown).toEqual({ grossM2: 10, openingsM2: 1.89, netM2: 8.11 })
  })

  it('emits a Sockelleiste (lfm) item with a non-colliding nodeId', () => {
    const items = generateAutoItems(makeScene())
    const skirting = items.find((i) => i.description === 'Sockelleiste')
    expect(skirting).toBeDefined()
    expect(skirting!.unit).toBe('lfm')
    // perimeter 16 − door 0.9 = 15.1
    expect(skirting!.quantity).toBe(15.1)
    // nodeId must NOT equal the floor item's nodeId (reconcile map would collide)
    const floorItem = items.find((i) => i.description === 'Bodenfläche')
    expect(skirting!.nodeId).not.toBe(floorItem!.nodeId)
    expect(skirting!.nodeId).toBe('floor:skirting')
  })

  it('keeps net === gross when a wall has no openings', () => {
    const scene = makeScene()
    ;(scene.walls[0] as unknown as { openings: WallOpening[] }).openings = []
    const wallItem = generateAutoItems(scene).find((i) => i.category === 'Wand')
    expect(wallItem!.quantity).toBe(10)
    expect(wallItem!.areaBreakdown).toEqual({ grossM2: 10, openingsM2: 0, netM2: 10 })
  })
})
