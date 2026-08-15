/**
 * Tests for canonical/workflow/sceneCompareModel.ts
 *
 * Covers:
 * - compareVariants: detects provider-added, customer-added, and provider-changed nodes
 * - compareVariants: produces correct counts per origin
 * - compareVariants: identical variants → no changes
 * - buildVariantOverrideMap: keeps latest entry per nodeId, coerces values to strings
 * - inferKind heuristics (indirectly via compareVariants change entries)
 */
import { describe, it, expect } from 'vitest'

import {
  compareVariants,
  buildVariantOverrideMap,
} from '../../../../../src/lib/spatial/canonical/workflow/sceneCompareModel.ts'
import type { VariantOverrideMap } from '../../../../../src/lib/spatial/canonical/workflow/sceneCompareModel.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

function variantMap(entries: Array<[string, Record<string, string>]>): VariantOverrideMap {
  return new Map(entries)
}

// ── compareVariants ───────────────────────────────────────────────────────────

describe('compareVariants', () => {
  it('returns empty result for two identical empty variants', () => {
    const result = compareVariants(variantMap([]), variantMap([]))
    expect(result.changes).toHaveLength(0)
    expect(result.providerCount).toBe(0)
    expect(result.customerCount).toBe(0)
  })

  it('returns empty result for two identical non-empty variants', () => {
    const ref = variantMap([['node-wall', { lengthM: '2.80' }]])
    const working = variantMap([['node-wall', { lengthM: '2.80' }]])
    const result = compareVariants(ref, working)
    expect(result.changes).toHaveLength(0)
  })

  it('detects provider-added node (exists in working, not in reference)', () => {
    const ref = variantMap([])
    const working = variantMap([['node-door', { posX: '1.5', posY: '0' }]])
    const result = compareVariants(ref, working)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].origin).toBe('provider')
    expect(result.changes[0].fromValue).toBeNull()
    expect(result.changes[0].label).toBe('node-door')
    expect(result.providerCount).toBe(1)
  })

  it('detects customer-added node (exists in reference, not in working)', () => {
    const ref = variantMap([['node-window', { lengthM: '2.28' }]])
    const working = variantMap([])
    const result = compareVariants(ref, working)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].origin).toBe('customer')
    // fromValue = reference (Kunden-Aufmaß) value; toValue = null (not in working)
    expect(result.changes[0].fromValue).toBe('2.28 m')
    expect(result.changes[0].toValue).toBeNull()
    expect(result.customerCount).toBe(1)
  })

  it('detects provider-changed node (different values between variants)', () => {
    const ref = variantMap([['node-wall', { lengthM: '2.80' }]])
    const working = variantMap([['node-wall', { lengthM: '2.75' }]])
    const result = compareVariants(ref, working)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].origin).toBe('provider')
    expect(result.changes[0].fromValue).toBe('2.80 m')
    expect(result.changes[0].toValue).toBe('2.75 m')
  })

  it('uses nodeLabels map for display labels when provided', () => {
    const ref = variantMap([])
    const working = variantMap([['node-rw', { lengthM: '2.75' }]])
    const labels = new Map([['node-rw', 'Rückwand']])
    const result = compareVariants(ref, working, labels)
    expect(result.changes[0].label).toBe('Rückwand')
  })

  it('handles mixed scenario: 2 provider + 1 customer change', () => {
    const ref = variantMap([
      ['wall-a', { lengthM: '2.80' }],
      ['window-1', { lengthM: '2.10' }],
    ])
    const working = variantMap([
      ['wall-a', { lengthM: '2.75' }], // provider changed
      ['door-1', { posX: '0.5' }], // provider added
    ])
    // window-1 only in ref → customer added
    const result = compareVariants(ref, working)
    expect(result.providerCount).toBe(2)
    expect(result.customerCount).toBe(1)
    expect(result.changes).toHaveLength(3)
  })

  it('assigns unique ids to each change', () => {
    const ref = variantMap([])
    const working = variantMap([
      ['n1', { lengthM: '1' }],
      ['n2', { lengthM: '2' }],
    ])
    const result = compareVariants(ref, working)
    const ids = result.changes.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('infers measurement kind for lengthM fields', () => {
    const ref = variantMap([])
    const working = variantMap([['node-wall', { lengthM: '3.0' }]])
    const result = compareVariants(ref, working)
    expect(result.changes[0].kind).toBe('measurement')
  })

  it('infers layout kind for position fields', () => {
    const ref = variantMap([])
    const working = variantMap([['node-door', { posX: '1.2', posY: '0' }]])
    const result = compareVariants(ref, working)
    expect(result.changes[0].kind).toBe('layout')
  })

  it('infers material kind for materialId fields', () => {
    const ref = variantMap([])
    const working = variantMap([['node-floor', { materialId: 'mat-42' }]])
    const result = compareVariants(ref, working)
    expect(result.changes[0].kind).toBe('material')
  })
})

// ── buildVariantOverrideMap ──────────────────────────────────────────────────

describe('buildVariantOverrideMap', () => {
  it('returns an empty map for no entries', () => {
    expect(buildVariantOverrideMap([])).toEqual(new Map())
  })

  it('maps one entry per nodeId', () => {
    const map = buildVariantOverrideMap([
      { baseNodeId: 'n1', overrideFields: { lengthM: 2.8 }, createdAt: '2025-01-01T10:00:00Z' },
    ])
    expect(map.get('n1')).toEqual({ lengthM: '2.8' })
  })

  it('keeps the latest entry when multiple entries share a nodeId', () => {
    const map = buildVariantOverrideMap([
      { baseNodeId: 'n1', overrideFields: { value: 'old' }, createdAt: '2025-01-01T08:00:00Z' },
      { baseNodeId: 'n1', overrideFields: { value: 'new' }, createdAt: '2025-01-01T10:00:00Z' },
    ])
    expect(map.get('n1')).toEqual({ value: 'new' })
  })

  it('coerces numeric values to strings', () => {
    const map = buildVariantOverrideMap([
      { baseNodeId: 'n1', overrideFields: { lengthM: 2.8 }, createdAt: '2025-01-01T10:00:00Z' },
    ])
    expect(typeof map.get('n1')!.lengthM).toBe('string')
  })

  it('handles null field values gracefully', () => {
    const map = buildVariantOverrideMap([
      { baseNodeId: 'n1', overrideFields: { tag: null }, createdAt: '2025-01-01T10:00:00Z' },
    ])
    expect(map.get('n1')!.tag).toBe('')
  })

  it('handles multiple distinct nodes independently', () => {
    const map = buildVariantOverrideMap([
      { baseNodeId: 'n1', overrideFields: { a: '1' }, createdAt: '2025-01-01T10:00:00Z' },
      { baseNodeId: 'n2', overrideFields: { b: '2' }, createdAt: '2025-01-01T10:00:00Z' },
    ])
    expect(map.size).toBe(2)
    expect(map.get('n1')!.a).toBe('1')
    expect(map.get('n2')!.b).toBe('2')
  })
})
