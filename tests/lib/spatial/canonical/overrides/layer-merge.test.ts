/**
 * Tests for overrides/layer-merge.ts
 */
import { describe, it, expect } from 'vitest'

import {
  DELETION_MARKER_KEY,
  applyOverride,
  isDeletionOverride,
  mergeOverrides,
  selectOverrides,
} from '../../../../../src/lib/spatial/canonical/overrides/layer-merge.ts'
import type { NodeOverride } from '../../../../../src/lib/spatial/canonical/types/variants.ts'

function ov(fields: Record<string, unknown>, opts: { variant?: string; baseId?: string } = {}): NodeOverride {
  return {
    base_node_id: opts.baseId ?? 'n1',
    variant_id: opts.variant ?? 'customer_corrections',
    override_fields: fields,
  }
}

describe('layer-merge · applyOverride', () => {
  it('shallow-merges override_fields onto the base', () => {
    const result = applyOverride({ a: 1, b: 2 }, ov({ b: 99 }))
    expect(result).toEqual({ a: 1, b: 99 })
  })

  it('returns null when the override is a deletion marker', () => {
    const result = applyOverride({ a: 1 }, ov({ [DELETION_MARKER_KEY]: true }))
    expect(result).toBeNull()
  })
})

describe('layer-merge · mergeOverrides', () => {
  it('applies multiple overrides in order, last wins', () => {
    const result = mergeOverrides({ a: 1, b: 2 }, [
      ov({ a: 10 }),
      ov({ a: 20, b: 99 }, { variant: 'provider' }),
    ])
    expect(result).toEqual({ a: 20, b: 99 })
  })

  it('returns null when a deletion appears in the chain', () => {
    const result = mergeOverrides({ a: 1 }, [
      ov({ a: 10 }),
      ov({ [DELETION_MARKER_KEY]: true }),
    ])
    expect(result).toBeNull()
  })

  it('resurrects a deleted node via a stronger non-deletion override', () => {
    // Delete in customer-layer, then provider-layer adds a fresh value.
    const result = mergeOverrides({ a: 1, b: 2 }, [
      ov({ [DELETION_MARKER_KEY]: true }),
      ov({ a: 99 }, { variant: 'provider' }),
    ])
    // Resurrect from the base + apply override fields.
    expect(result).toEqual({ a: 99, b: 2 })
  })
})

describe('layer-merge · selectOverrides', () => {
  it('filters by base id + variant id', () => {
    const overrides: NodeOverride[] = [
      ov({}, { baseId: 'wall_a', variant: 'cc' }),
      ov({}, { baseId: 'wall_a', variant: 'provider' }),
      ov({}, { baseId: 'wall_b', variant: 'cc' }),
    ]
    expect(selectOverrides(overrides, 'wall_a', 'cc')).toHaveLength(1)
  })

  it('isDeletionOverride returns true only for the marker shape', () => {
    expect(isDeletionOverride(ov({ [DELETION_MARKER_KEY]: true }))).toBe(true)
    expect(isDeletionOverride(ov({ a: 1 }))).toBe(false)
  })
})
