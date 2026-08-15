/**
 * deriveCustomerToolCounts · count-badge mapping contract.
 *
 * Locks the kind→tool projection used by the CUSTOMER tool-bar badges. Unlike
 * the craftsman bar it folds outlet/switch/fusebox into one `electrical` chip
 * and routes floor/ceiling catalog assets (plus any non-gewerk wall asset) into
 * one `furniture` chip. 'wall' is an edit mode → never badged.
 */
import { describe, it, expect } from 'vitest'

import { deriveCustomerToolCounts } from '../../../src/components/spatial/deriveCustomerToolCounts'
import type { RoomScene } from '../../../src/lib/spatial/canonical/types/scene-graph'

// The helper only reads walls[].openings/.wall_mounted, floor.floor_mounted and
// ceiling.ceiling_mounted, so a structural partial cast keeps the fixture readable.
const scene = {
  walls: [
    {
      openings: [{ type: 'door' }, { type: 'window' }, { type: 'door' }, { type: 'opening' }],
      wall_mounted: [{ category: 'electrical_outlet' }, { category: 'light_switch' }],
    },
    {
      openings: [],
      wall_mounted: [
        { category: 'radiator' },
        { category: 'fuse_box' },
        { category: 'electrical_outlet' },
        { category: 'shelf' }, // non-gewerk wall catalog asset → furniture
      ],
    },
  ],
  floor: { floor_mounted: [{ category: 'bathtub' }, { category: 'sink' }] },
  ceiling: { ceiling_mounted: [{ category: 'ceiling_light' }] },
} as unknown as RoomScene

describe('deriveCustomerToolCounts', () => {
  it('folds outlet/switch/fusebox → electrical and floor/ceiling/non-gewerk-wall → furniture', () => {
    expect(deriveCustomerToolCounts(scene)).toEqual({
      door: { count: 2 },
      window: { count: 1 },
      heating: { count: 1 },
      electrical: { count: 4 }, // 2 outlets + 1 switch + 1 fusebox = 4 electrical
      furniture: { count: 4 }, // 1 wall shelf + 2 floor + 1 ceiling
    })
  })

  it("ignores the 'opening' opening type and never badges 'wall'", () => {
    const counts = deriveCustomerToolCounts(scene)
    expect(counts).not.toHaveProperty('wall')
    // 'opening' (neither door nor window) is not counted → exactly 2 doors.
    expect(counts.door).toEqual({ count: 2 })
  })

  it('returns an empty map for an empty scene', () => {
    const empty = {
      walls: [],
      floor: { floor_mounted: [] },
      ceiling: { ceiling_mounted: [] },
    } as unknown as RoomScene
    expect(deriveCustomerToolCounts(empty)).toEqual({})
  })
})
