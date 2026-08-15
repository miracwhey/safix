/**
 * Tests for overrides/cache.ts (Risk R8 mitigation · CRIT-3 audit-fix).
 *
 * The cache now uses content-addressed keys, not WeakMap-by-identity, so
 * that React-immutable consumers (zustand+immer, structural sharing) still
 * see cache hits when the scene reference changes but the content is equal.
 */
import { describe, it, expect } from 'vitest'

import {
  createOverrideCache,
  invalidateScene,
  invalidateVariant,
  resolveSceneCached,
  clearOverrideCache,
  OVERRIDE_CACHE_MAX_ENTRIES,
} from '../../../../../src/lib/spatial/canonical/overrides/cache.ts'
import type { NodeOverride, Variant } from '../../../../../src/lib/spatial/canonical/types/variants.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

const variants: Variant[] = [
  { id: 'base_roomplan', display_name: 'Scan', is_default: true },
  {
    id: 'customer_corrections',
    display_name: 'Customer',
    is_default: false,
    parent_variant_id: 'base_roomplan',
  },
]

/** Structural-share clone — preserves field equality, breaks reference equality. */
function cloneScene(scene: RoomScene): RoomScene {
  return JSON.parse(JSON.stringify(scene)) as RoomScene
}

describe('cache · resolveSceneCached', () => {
  it('returns the same reference on repeated calls', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const first = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    const second = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    expect(second).toBe(first)
  })

  it('hits the cache when the scene reference changes but content is equal (React-immutable pattern)', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const first = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    // Simulate zustand+immer / structural sharing producing a fresh reference
    // with identical content.
    const sceneClone = cloneScene(scene)
    expect(sceneClone).not.toBe(scene)
    const second = resolveSceneCached(
      { scene: sceneClone, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    expect(second).toBe(first)
  })

  it('treats overrides with different fields as different keys (cache miss)', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const overridesA: NodeOverride[] = [
      {
        base_node_id: 'wall-a',
        variant_id: 'customer_corrections',
        override_fields: { thickness_m: 0.18 },
      },
    ]
    const overridesB: NodeOverride[] = [
      {
        base_node_id: 'wall-a',
        variant_id: 'customer_corrections',
        override_fields: { thickness_m: 0.22 },
      },
    ]
    const a = resolveSceneCached(
      { scene, overrides: overridesA, variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    const b = resolveSceneCached(
      { scene, overrides: overridesB, variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    expect(b).not.toBe(a)
  })

  it('is insensitive to override array order (sorts internally)', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const o1: NodeOverride = {
      base_node_id: 'wall-a',
      variant_id: 'customer_corrections',
      override_fields: { thickness_m: 0.18 },
    }
    const o2: NodeOverride = {
      base_node_id: 'wall-b',
      variant_id: 'customer_corrections',
      override_fields: { thickness_m: 0.20 },
    }
    const ab = resolveSceneCached(
      { scene, overrides: [o1, o2], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    const ba = resolveSceneCached(
      { scene, overrides: [o2, o1], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    expect(ba).toBe(ab)
  })

  it('is insensitive to override_fields key order', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const a = resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-a',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18, height_m: 2.5 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    const b = resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-a',
            variant_id: 'customer_corrections',
            override_fields: { height_m: 2.5, thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    expect(b).toBe(a)
  })
})

describe('cache · invalidation', () => {
  it('invalidateVariant forces a recompute for that variant only', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const base = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'base_roomplan' },
      cache,
    )
    const customer = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    invalidateVariant(cache, scene, 'customer_corrections')
    const customer2 = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'customer_corrections' },
      cache,
    )
    expect(customer2).not.toBe(customer)
    const base2 = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'base_roomplan' },
      cache,
    )
    expect(base2).toBe(base)
  })

  it('invalidateScene wipes every variant entry for that scene', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    const base1 = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'base_roomplan' },
      cache,
    )
    invalidateScene(cache, scene)
    const base2 = resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'base_roomplan' },
      cache,
    )
    expect(base2).not.toBe(base1)
  })

  it('clearOverrideCache empties the live instance and returns a fresh one', () => {
    const scene = makeRoom()
    const cache = createOverrideCache()
    resolveSceneCached(
      { scene, overrides: [], variants, activeVariantId: 'base_roomplan' },
      cache,
    )
    expect(cache.entries.size).toBe(1)
    const fresh = clearOverrideCache(cache)
    expect(cache.entries.size).toBe(0)
    expect(fresh.entries.size).toBe(0)
  })
})

describe('cache · LRU bounds', () => {
  it(`evicts the oldest entry once size exceeds ${OVERRIDE_CACHE_MAX_ENTRIES}`, () => {
    const scene = makeRoom()
    const cache = createOverrideCache(3)
    for (let i = 0; i < 5; i += 1) {
      resolveSceneCached(
        {
          scene,
          overrides: [
            {
              base_node_id: `wall-${i}`,
              variant_id: 'customer_corrections',
              override_fields: { thickness_m: 0.1 + i * 0.01 },
            },
          ],
          variants,
          activeVariantId: 'customer_corrections',
        },
        cache,
      )
    }
    expect(cache.entries.size).toBe(3)
  })

  it('touches an LRU entry on hit so it survives eviction', () => {
    const scene = makeRoom()
    const cache = createOverrideCache(2)
    const hot = resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-hot',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-2',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    // Touch the hot entry to move it to the tail.
    const hotAgain = resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-hot',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    expect(hotAgain).toBe(hot)
    // Now insert a third entry — the OLDER wall-2 should evict, hot survives.
    resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-3',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    const hotStill = resolveSceneCached(
      {
        scene,
        overrides: [
          {
            base_node_id: 'wall-hot',
            variant_id: 'customer_corrections',
            override_fields: { thickness_m: 0.18 },
          },
        ],
        variants,
        activeVariantId: 'customer_corrections',
      },
      cache,
    )
    expect(hotStill).toBe(hot)
  })
})
