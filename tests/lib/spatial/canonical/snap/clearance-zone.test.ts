/**
 * Tests for canonical/snap/clearance-zone.ts — the Block-2.8 clearance-zone
 * derivation helper.
 */
import { describe, it, expect } from 'vitest'

import {
  deriveClearanceZone,
  clearanceZoneHasExtent,
  FALLBACK_CLEARANCE,
} from '../../../../../src/lib/spatial/canonical/snap/clearance-zone.ts'
import type { SnapRule } from '../../../../../src/lib/spatial/canonical/types/asset.ts'

describe('deriveClearanceZone', () => {
  it('uses a category default for a known fixture (WC has 0.6 m front)', () => {
    const zone = deriveClearanceZone('toilet')
    expect(zone.front_m).toBeCloseTo(0.6, 6)
  })

  it('falls back to FALLBACK_CLEARANCE for an unmapped category', () => {
    const zone = deriveClearanceZone('plant')
    expect(zone.front_m).toBe(FALLBACK_CLEARANCE.front_m)
  })

  it('an explicit per-asset clearance wins over the category default', () => {
    const explicit = { front_m: 1.2, sides_m: 0.4, above_m: 0.1 }
    expect(deriveClearanceZone('toilet', explicit)).toEqual(explicit)
  })

  it('raises the front clearance to the snap-rule object minimum when larger', () => {
    const rule: SnapRule = {
      target_host: 'floor',
      align_to_normal: false,
      min_distance_to_other_objects_m: 1.0,
    }
    const zone = deriveClearanceZone('toilet', undefined, rule)
    expect(zone.front_m).toBeCloseTo(1.0, 6)
  })

  it('keeps the larger of category default and snap-rule minimum', () => {
    const rule: SnapRule = {
      target_host: 'floor',
      align_to_normal: false,
      min_distance_to_other_objects_m: 0.1,
    }
    // toilet front default is 0.6; the 0.1 minimum must not lower it.
    expect(deriveClearanceZone('toilet', undefined, rule).front_m).toBeCloseTo(0.6, 6)
  })
})

describe('clearanceZoneHasExtent', () => {
  it('is true for a fixture with front clearance', () => {
    expect(clearanceZoneHasExtent(deriveClearanceZone('toilet'))).toBe(true)
  })

  it('is false for a fully-zero zone', () => {
    expect(clearanceZoneHasExtent({ front_m: 0, sides_m: 0, above_m: 0 })).toBe(false)
  })
})
