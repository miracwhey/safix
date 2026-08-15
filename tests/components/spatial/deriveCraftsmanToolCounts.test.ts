/**
 * deriveCraftsmanToolCounts · count-badge mapping contract.
 *
 * Locks the kind→tool projection used by the tool-bar badges so it stays in
 * sync with the placement builders (openings.type / wall_mounted.category /
 * floor_mounted.category) without needing a device to notice a drift.
 */
import { describe, it, expect } from 'vitest'

import { deriveCraftsmanToolCounts } from '../../../src/components/spatial/deriveCraftsmanToolCounts'
import type { RoomScene } from '../../../src/lib/spatial/canonical/types/scene-graph'

// The helper only reads walls[].openings/.wall_mounted and floor.floor_mounted,
// so a structural partial cast is sufficient and keeps the fixture readable.
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
      ],
    },
  ],
  floor: {
    floor_mounted: [{ category: 'bathtub' }, { category: 'sink' }, { category: 'sink' }],
  },
} as unknown as RoomScene

describe('deriveCraftsmanToolCounts', () => {
  it('counts openings / wall-mounted / floor-mounted per tool', () => {
    expect(deriveCraftsmanToolCounts(scene)).toEqual({
      door: { count: 2 },
      window: { count: 1 },
      outlet: { count: 2 },
      switch: { count: 1 },
      radiator: { count: 1 },
      fusebox: { count: 1 },
      bathtub: { count: 1 },
      sink: { count: 2 },
    })
  })

  it("ignores the 'opening' opening type and material (no countable object)", () => {
    const counts = deriveCraftsmanToolCounts(scene)
    // 'opening' (neither door nor window) and any toilet/material are absent.
    expect(counts).not.toHaveProperty('toilet')
    expect(counts).not.toHaveProperty('material')
  })

  it('returns an empty map for an empty scene', () => {
    const empty = { walls: [], floor: { floor_mounted: [] } } as unknown as RoomScene
    expect(deriveCraftsmanToolCounts(empty)).toEqual({})
  })
})
