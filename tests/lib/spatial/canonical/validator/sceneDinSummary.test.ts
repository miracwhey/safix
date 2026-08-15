/**
 * Tests for canonical/validator/sceneDinSummary.ts — the provider-facing,
 * scene-wide DIN/VDE sweep + DIN→position mapping.
 *
 * Covers:
 *   - evaluateSceneDin: opening rules (door near corner / low window sill),
 *     wall-mounted rules (outlet off DIN height), dedup of the mirrored
 *     radiator↔electrical proximity warning, empty-scene → [].
 *   - dinWarningKey: order-independent identity (the mirror-pair collapse key).
 *   - dinWarningToBomDraft: trade-actionable description + unit + unpriced.
 *
 * Geometry/object inputs are minimal partial literals cast to the canonical
 * types — the validators only read the asserted fields.
 */

import { describe, it, expect } from 'vitest'

import {
  evaluateSceneDin,
  dinWarningKey,
  dinWarningToBomDraft,
} from '../../../../../src/lib/spatial/canonical/validator/sceneDinSummary.ts'
import type { DinWarning } from '../../../../../src/lib/spatial/canonical/validator/wallObjectDinValidator.ts'
import type { Wall, WallOpening, WallOpeningType } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject, ObjectCategory } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import type { RoomScene, RoomCategory } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function opening(o: {
  id: string
  type: WallOpeningType
  along?: number
  floor?: number
  width?: number
  height?: number
}): WallOpening {
  return {
    id: o.id,
    type: o.type,
    offset_along_wall_m: o.along ?? 1,
    offset_from_floor_m: o.floor ?? 0,
    width_m: o.width ?? 0.9,
    height_m: o.height ?? 2.0,
    is_walkable_portal: o.type === 'door' || o.type === 'opening',
  } as unknown as WallOpening
}

function mounted(o: {
  id: string
  category: ObjectCategory
  offset?: number
  fromFloor?: number
  width?: number
  height?: number
}): SpatialObject {
  return {
    id: o.id,
    host: 'wall',
    category: o.category,
    offset_along_wall_m: o.offset ?? 1,
    height_from_floor_m: o.fromFloor ?? 0.3,
    dimensions: { width_m: o.width ?? 0.08, height_m: o.height ?? 0.08, depth_m: 0.05 },
  } as unknown as SpatialObject
}

function wall(o: { id?: string; openings?: WallOpening[]; mounted?: SpatialObject[] }): Wall {
  return {
    id: o.id ?? 'w1',
    length_m: 4,
    height_m: 2.5,
    openings: o.openings ?? [],
    wall_mounted: o.mounted ?? [],
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
  } as unknown as Wall
}

function scene(walls: Wall[], category: RoomCategory = 'living'): RoomScene {
  return { id: 'r', type: 'room', category, walls } as unknown as RoomScene
}

const codes = (ws: DinWarning[]) => ws.map((w) => w.code)

// ─── evaluateSceneDin ────────────────────────────────────────────────────────

describe('evaluateSceneDin', () => {
  it('returns [] for a scene with no walls', () => {
    expect(evaluateSceneDin(scene([]))).toEqual([])
  })

  it('flags a door placed within 20 cm of a wall corner', () => {
    const s = scene([wall({ openings: [opening({ id: 'd1', type: 'door', along: 0.05 })] })])
    expect(codes(evaluateSceneDin(s))).toContain('DIN_DOOR_NEAR_CORNER')
  })

  it('flags a window sill below 80 cm', () => {
    const s = scene([wall({ openings: [opening({ id: 'win1', type: 'window', floor: 0.5, height: 1.2 })] })])
    expect(codes(evaluateSceneDin(s))).toContain('DIN_WINDOW_SILL_LOW')
  })

  it('flags an outlet outside both DIN height bands', () => {
    // 0.6 m is neither 0.30 m (±0.15) nor 1.10 m (±0.15) → off-band
    const s = scene([wall({ mounted: [mounted({ id: 'o1', category: 'electrical_outlet', fromFloor: 0.6 })] })])
    expect(codes(evaluateSceneDin(s))).toContain('DIN_OUTLET_HEIGHT')
  })

  it('does NOT flag an outlet sitting on a DIN band', () => {
    const s = scene([wall({ mounted: [mounted({ id: 'o1', category: 'electrical_outlet', fromFloor: 0.3 })] })])
    expect(codes(evaluateSceneDin(s))).not.toContain('DIN_OUTLET_HEIGHT')
  })

  it('reports the radiator↔electrical proximity warning exactly once (mirror dedup)', () => {
    // radiator [1.0, 1.6], outlet [1.7, 1.78] → 0.1 m gap < 0.5 m. Both objects
    // fire DIN_OUTLET_NEAR_HEATING; the dedup must collapse the mirror pair.
    const s = scene([
      wall({
        mounted: [
          mounted({ id: 'rad', category: 'radiator', offset: 1.0, fromFloor: 0.3, width: 0.6, height: 0.6 }),
          mounted({ id: 'out', category: 'electrical_outlet', offset: 1.7, fromFloor: 0.3 }),
        ],
      }),
    ])
    const nearHeating = evaluateSceneDin(s).filter((w) => w.code === 'DIN_OUTLET_NEAR_HEATING')
    expect(nearHeating).toHaveLength(1)
  })

  it('adds the bathroom VDE reminder only for bathroom scenes', () => {
    const electrical = [mounted({ id: 'o1', category: 'electrical_outlet', fromFloor: 0.3 })]
    expect(codes(evaluateSceneDin(scene([wall({ mounted: electrical })], 'bathroom')))).toContain(
      'DIN_BATHROOM_ZONE',
    )
    expect(codes(evaluateSceneDin(scene([wall({ mounted: electrical })], 'living')))).not.toContain(
      'DIN_BATHROOM_ZONE',
    )
  })
})

// ─── dinWarningKey ───────────────────────────────────────────────────────────

describe('dinWarningKey', () => {
  it('is identical regardless of affectedIds order', () => {
    const a = { code: 'DIN_OUTLET_NEAR_HEATING', affectedIds: ['out', 'rad', 'w1'] } as DinWarning
    const b = { code: 'DIN_OUTLET_NEAR_HEATING', affectedIds: ['rad', 'w1', 'out'] } as DinWarning
    expect(dinWarningKey(a)).toBe(dinWarningKey(b))
  })

  it('differs across codes', () => {
    const a = { code: 'DIN_OUTLET_HEIGHT', affectedIds: ['o', 'w'] } as DinWarning
    const b = { code: 'DIN_SWITCH_HEIGHT', affectedIds: ['o', 'w'] } as DinWarning
    expect(dinWarningKey(a)).not.toBe(dinWarningKey(b))
  })
})

// ─── dinWarningToBomDraft ────────────────────────────────────────────────────

describe('dinWarningToBomDraft', () => {
  it('maps an outlet-height warning to a trade-actionable, unpriced position', () => {
    const draft = dinWarningToBomDraft({ code: 'DIN_OUTLET_HEIGHT' } as DinWarning)
    expect(draft.description).toBe('Steckdosen auf Normhöhe versetzen')
    expect(draft.unit).toBe('pcs')
    expect(draft.quantity).toBe(1)
    expect(draft.unitPriceCents).toBe(0)
    expect(draft.category).toBe('Sonstiges')
  })

  it('provides a template for every DIN code', () => {
    const allCodes: DinWarning['code'][] = [
      'DIN_DOOR_NEAR_CORNER',
      'DIN_WINDOW_SILL_LOW',
      'DIN_RADIATOR_NOT_UNDER_WINDOW',
      'DIN_SWITCH_HEIGHT',
      'DIN_OUTLET_HEIGHT',
      'DIN_OUTLET_NEAR_HEATING',
      'DIN_BATHROOM_ZONE',
    ]
    for (const code of allCodes) {
      const draft = dinWarningToBomDraft({ code } as DinWarning)
      expect(draft.description.length).toBeGreaterThan(0)
      expect(draft.unit).toBe('pcs')
    }
  })
})
