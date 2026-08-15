/**
 * Tests for canonical/workflow/bomModel.ts — pure BoM logic.
 *
 * Covers:
 *   - computeBomTotals: empty list, single item, multi-item sum, VAT rounding
 *   - nextPosition: empty list, non-empty list, gap in positions
 *   - addManualItem: auto-assigns position + source='manual', immutability
 *   - updateItem: patches matching id, ignores unknown id, preserves id
 *   - removeItem: removes matching id, ignores unknown id, preserves positions
 */

import { describe, it, expect } from 'vitest'

import {
  computeBomTotals,
  effectiveQuantity,
  nextPosition,
  addManualItem,
  updateItem,
  removeItem,
  reconcileAutoItems,
  type BomItem,
} from '../../../../../src/lib/spatial/canonical/workflow/bomModel.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<BomItem> & { id: string }): BomItem {
  return {
    position: 1,
    description: 'Test',
    category: 'Test',
    quantity: 1,
    unit: 'pcs',
    unitPriceCents: 0,
    source: 'manual',
    ...overrides,
  }
}

// ─── computeBomTotals ─────────────────────────────────────────────────────────

describe('computeBomTotals', () => {
  it('returns zeros for empty list', () => {
    expect(computeBomTotals([], 19)).toEqual({ netCents: 0, vatCents: 0, grossCents: 0 })
  })

  it('computes totals for a single item', () => {
    const items = [makeItem({ id: 'a', quantity: 10, unit: 'm2', unitPriceCents: 4000 })]
    // 10 × 4000 = 40 000 net; VAT = round(40000 × 0.19) = 7600; gross = 47600
    expect(computeBomTotals(items, 19)).toEqual({
      netCents: 40000,
      vatCents: 7600,
      grossCents: 47600,
    })
  })

  it('sums multiple items correctly', () => {
    const items = [
      makeItem({ id: 'a', quantity: 22, unit: 'm2', unitPriceCents: 4000 }),  // 88 000
      makeItem({ id: 'b', quantity: 1,  unit: 'pcs', unitPriceCents: 45000 }), // 45 000
    ]
    // net = 133 000; vat = round(133000 × 0.19) = 25270; gross = 158270
    expect(computeBomTotals(items, 19)).toEqual({
      netCents: 133000,
      vatCents: 25270,
      grossCents: 158270,
    })
  })

  it('rounds VAT correctly for fractional cent results', () => {
    // 1 € net → VAT = round(100 × 0.19) = 19; gross = 119
    const items = [makeItem({ id: 'a', quantity: 1, unit: 'pcs', unitPriceCents: 100 })]
    expect(computeBomTotals(items, 19)).toEqual({ netCents: 100, vatCents: 19, grossCents: 119 })
  })

  it('rounds VAT half-up for .5 cent case', () => {
    // net = 1050 → VAT = round(1050 × 0.19) = round(199.5) = 200; gross = 1250
    const items = [makeItem({ id: 'a', quantity: 1, unit: 'pcs', unitPriceCents: 1050 })]
    const result = computeBomTotals(items, 19)
    expect(result.vatCents).toBe(Math.round(1050 * 0.19))
    expect(result.grossCents).toBe(result.netCents + result.vatCents)
  })

  it('handles zero unit price (not yet priced)', () => {
    const items = [makeItem({ id: 'a', quantity: 5, unit: 'm2', unitPriceCents: 0 })]
    expect(computeBomTotals(items, 19)).toEqual({ netCents: 0, vatCents: 0, grossCents: 0 })
  })

  it('bills the manual quantityOverride instead of the geometry quantity', () => {
    // geometry net = 10 m², but the craftsman overrode to gross 12 m².
    const items = [
      makeItem({ id: 'a', quantity: 10, quantityOverride: 12, unit: 'm2', unitPriceCents: 4000 }),
    ]
    // 12 × 4000 = 48 000 net; VAT = round(48000 × 0.19) = 9120; gross = 57120
    expect(computeBomTotals(items, 19)).toEqual({
      netCents: 48000,
      vatCents: 9120,
      grossCents: 57120,
    })
  })

  it('handles fractional quantities with integer cents', () => {
    // 7.8 m² × 6000 ct = 46 800 ct; VAT = round(46800 × 0.19) = 8892; gross = 55692
    const items = [makeItem({ id: 'a', quantity: 7.8, unit: 'm2', unitPriceCents: 6000 })]
    const result = computeBomTotals(items, 19)
    expect(result.netCents).toBe(46800)
    expect(result.grossCents).toBe(result.netCents + result.vatCents)
  })

  it('works with different VAT rates', () => {
    const items = [makeItem({ id: 'a', quantity: 1, unit: 'pcs', unitPriceCents: 10000 })]
    // 7% VAT
    const { netCents, vatCents, grossCents } = computeBomTotals(items, 7)
    expect(netCents).toBe(10000)
    expect(vatCents).toBe(700)
    expect(grossCents).toBe(10700)
  })
})

// ─── effectiveQuantity ────────────────────────────────────────────────────────

describe('effectiveQuantity', () => {
  it('returns the geometry quantity when no override is set', () => {
    expect(effectiveQuantity(makeItem({ id: 'a', quantity: 9.5 }))).toBe(9.5)
  })

  it('returns the override when set', () => {
    expect(effectiveQuantity(makeItem({ id: 'a', quantity: 9.5, quantityOverride: 12 }))).toBe(12)
  })

  it('treats an override of 0 as the billed quantity (not a fallthrough)', () => {
    expect(effectiveQuantity(makeItem({ id: 'a', quantity: 9.5, quantityOverride: 0 }))).toBe(0)
  })
})

// ─── nextPosition ─────────────────────────────────────────────────────────────

describe('nextPosition', () => {
  it('returns 1 for empty list', () => {
    expect(nextPosition([])).toBe(1)
  })

  it('returns max+1 for non-empty list', () => {
    const items = [
      makeItem({ id: 'a', position: 1 }),
      makeItem({ id: 'b', position: 2 }),
      makeItem({ id: 'c', position: 3 }),
    ]
    expect(nextPosition(items)).toBe(4)
  })

  it('does not fill gaps — always max+1', () => {
    // positions 1 and 3 present (2 is deleted); next should be 4
    const items = [
      makeItem({ id: 'a', position: 1 }),
      makeItem({ id: 'c', position: 3 }),
    ]
    expect(nextPosition(items)).toBe(4)
  })
})

// ─── addManualItem ────────────────────────────────────────────────────────────

describe('addManualItem', () => {
  it('assigns source=manual and auto-increments position', () => {
    const existing = [makeItem({ id: 'a', position: 1 })]
    const result = addManualItem(existing, {
      id: 'b',
      description: 'Anfahrt',
      category: 'Sonstiges',
      quantity: 1,
      unit: 'pcs',
      unitPriceCents: 5000,
    })
    expect(result).toHaveLength(2)
    const added = result[1]
    expect(added.source).toBe('manual')
    expect(added.position).toBe(2)
    expect(added.id).toBe('b')
  })

  it('does not mutate the original array', () => {
    const existing = [makeItem({ id: 'a', position: 1 })]
    const result = addManualItem(existing, {
      id: 'b',
      description: 'X',
      category: 'X',
      quantity: 1,
      unit: 'pcs',
      unitPriceCents: 0,
    })
    expect(existing).toHaveLength(1)
    expect(result).toHaveLength(2)
  })

  it('adds to empty list with position 1', () => {
    const result = addManualItem([], {
      id: 'x',
      description: 'Y',
      category: 'Y',
      quantity: 2,
      unit: 'h',
      unitPriceCents: 8000,
    })
    expect(result).toHaveLength(1)
    expect(result[0].position).toBe(1)
    expect(result[0].source).toBe('manual')
  })
})

// ─── updateItem ───────────────────────────────────────────────────────────────

describe('updateItem', () => {
  it('patches the matching item', () => {
    const items = [
      makeItem({ id: 'a', unitPriceCents: 0 }),
      makeItem({ id: 'b', unitPriceCents: 1000 }),
    ]
    const result = updateItem(items, 'a', { unitPriceCents: 4000 })
    expect(result[0].unitPriceCents).toBe(4000)
    expect(result[1].unitPriceCents).toBe(1000)
  })

  it('does not change id even when patch includes id', () => {
    const items = [makeItem({ id: 'a' })]
    const result = updateItem(items, 'a', { id: 'hacked' } as Partial<BomItem>)
    expect(result[0].id).toBe('a')
  })

  it('returns list unchanged when id is not found', () => {
    const items = [makeItem({ id: 'a' })]
    const result = updateItem(items, 'zzz', { unitPriceCents: 9999 })
    expect(result).toHaveLength(1)
    expect(result[0].unitPriceCents).toBe(0)
  })

  it('does not mutate the original array', () => {
    const items = [makeItem({ id: 'a', unitPriceCents: 0 })]
    updateItem(items, 'a', { unitPriceCents: 999 })
    expect(items[0].unitPriceCents).toBe(0)
  })
})

// ─── removeItem ───────────────────────────────────────────────────────────────

describe('removeItem', () => {
  it('removes the matching item', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })]
    const result = removeItem(items, 'a')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b')
  })

  it('returns list unchanged when id is not found', () => {
    const items = [makeItem({ id: 'a' })]
    const result = removeItem(items, 'zzz')
    expect(result).toHaveLength(1)
  })

  it('does not re-number remaining positions', () => {
    // positions 1, 2, 3 — remove 2 → remaining have positions 1 and 3
    const items = [
      makeItem({ id: 'a', position: 1 }),
      makeItem({ id: 'b', position: 2 }),
      makeItem({ id: 'c', position: 3 }),
    ]
    const result = removeItem(items, 'b')
    expect(result.map((i) => i.position)).toEqual([1, 3])
  })

  it('does not mutate the original array', () => {
    const items = [makeItem({ id: 'a' })]
    removeItem(items, 'a')
    expect(items).toHaveLength(1)
  })
})

describe('reconcileAutoItems', () => {
  /** A geometry-fresh auto item (price 0, geometry-derived description). */
  function freshAuto(nodeId: string, quantity: number): BomItem {
    return makeItem({
      id: `auto-${nodeId}`,
      description: `Fläche ${nodeId}`,
      quantity,
      unit: 'm2',
      unitPriceCents: 0,
      source: 'auto',
      nodeId,
    })
  }

  it('preserves an entered price across a regeneration', () => {
    const existing = [
      makeItem({ id: 'auto-w1', source: 'auto', nodeId: 'w1', unitPriceCents: 5000 }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w1', 12)])
    expect(result[0].unitPriceCents).toBe(5000)
  })

  it('updates the quantity from fresh geometry', () => {
    const existing = [
      makeItem({ id: 'auto-w1', source: 'auto', nodeId: 'w1', quantity: 10, unitPriceCents: 5000 }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w1', 14)])
    expect(result[0].quantity).toBe(14)
  })

  it('preserves an edited description', () => {
    const existing = [
      makeItem({
        id: 'auto-w1',
        source: 'auto',
        nodeId: 'w1',
        description: 'Eigene Bezeichnung',
      }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w1', 9)])
    expect(result[0].description).toBe('Eigene Bezeichnung')
  })

  it('keeps manual items and never collides positions with auto items', () => {
    const existing = [
      makeItem({ id: 'auto-w1', source: 'auto', nodeId: 'w1', position: 1 }),
      makeItem({ id: 'm1', source: 'manual', position: 2, description: 'Anfahrt' }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w1', 9), freshAuto('w2', 4)])
    const manual = result.filter((i) => i.source === 'manual')
    expect(manual).toHaveLength(1)
    expect(manual[0].description).toBe('Anfahrt')
    const positions = result.map((i) => i.position)
    expect(new Set(positions).size).toBe(positions.length) // all unique
  })

  it('adds a newly scanned node and drops a removed one', () => {
    const existing = [
      makeItem({ id: 'auto-w1', source: 'auto', nodeId: 'w1', unitPriceCents: 3000 }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w2', 7)])
    expect(result.map((i) => i.nodeId)).toEqual(['w2'])
    // The new node starts unpriced — no stale price leaked from w1.
    expect(result[0].unitPriceCents).toBe(0)
  })

  it('preserves a manual quantityOverride across a regeneration', () => {
    const existing = [
      makeItem({
        id: 'auto-w1',
        source: 'auto',
        nodeId: 'w1',
        quantity: 10,
        quantityOverride: 12,
        unitPriceCents: 5000,
      }),
    ]
    // Geometry refreshes net to 11, but the craftsman's override must survive.
    const result = reconcileAutoItems(existing, [freshAuto('w1', 11)])
    expect(result[0].quantity).toBe(11) // fresh geometry
    expect(result[0].quantityOverride).toBe(12) // preserved override
    expect(effectiveQuantity(result[0])).toBe(12) // billed = override
  })

  it('does not invent an override for a node that never had one', () => {
    const existing = [
      makeItem({ id: 'auto-w1', source: 'auto', nodeId: 'w1', quantity: 10, unitPriceCents: 5000 }),
    ]
    const result = reconcileAutoItems(existing, [freshAuto('w1', 11)])
    expect(result[0].quantityOverride).toBeUndefined()
    expect(effectiveQuantity(result[0])).toBe(11)
  })
})
