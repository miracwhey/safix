/**
 * Tests for categoryToDefaultAsset (scan render-fallback).
 *
 * Scan objects carry a `category` but no `asset_id`, so this map gives each
 * ObjectCategory a default catalog slug → a scanned fixture renders its real
 * GLB / procedural silhouette instead of the brown generic box. These tests are
 * the DRIFT LOCK: every non-null slug must resolve to a real catalog asset of
 * the matching geometryKind, and a procedural-source slug must have a built
 * procedural spec — so a future catalog rename can't silently re-brown a scan.
 */
import { describe, it, expect } from 'vitest'

import { categoryToDefaultAsset } from '../../../../../src/lib/spatial/canonical/catalog/categoryToDefaultAsset.ts'
import { getCatalogAsset } from '../../../../../src/lib/spatial/canonical/catalog/asset-catalog.ts'
import { hasProceduralAsset } from '../../../../../src/lib/spatial/canonical/geometry/procedural-assets.ts'
import type { ObjectCategory } from '../../../../../src/lib/spatial/canonical/types/objects.ts'

/** Every ObjectCategory union member (mirrors types/objects.ts:30-72). */
const ALL_CATEGORIES: readonly ObjectCategory[] = [
  'toilet', 'sink', 'bathtub', 'shower', 'bidet', 'towel_rail', 'mirror',
  'washing_machine', 'toilet_paper_holder',
  'kitchen_sink', 'cooktop', 'oven', 'refrigerator', 'dishwasher', 'range_hood',
  'kitchen_faucet',
  'radiator', 'electrical_outlet', 'light_switch', 'fuse_box', 'lamp',
  'sofa', 'armchair', 'bed', 'wardrobe', 'bookshelf', 'table', 'chair',
  'cabinet', 'tv_cabinet', 'plant', 'curtains', 'fireplace', 'rug',
  'column', 'generic_cuboid',
]

/** Intentional nulls: no category-indexed catalog asset → accurate box. */
const NULL_CATEGORIES = new Set<ObjectCategory>(['fuse_box', 'column', 'generic_cuboid'])

describe('categoryToDefaultAsset', () => {
  it('covers all 36 ObjectCategory members', () => {
    expect(ALL_CATEGORIES).toHaveLength(36)
    // Sanity: no duplicates / typos in the local mirror.
    expect(new Set(ALL_CATEGORIES).size).toBe(36)
  })

  it('returns null exactly for the 3 intentional-null categories', () => {
    for (const category of ALL_CATEGORIES) {
      const slug = categoryToDefaultAsset(category)
      if (NULL_CATEGORIES.has(category)) {
        expect(slug, `${category} should be null`).toBeNull()
      } else {
        expect(slug, `${category} should have a default slug`).toBeTypeOf('string')
      }
    }
  })

  it('every non-null slug resolves to a real catalog asset (no drift)', () => {
    for (const category of ALL_CATEGORIES) {
      const slug = categoryToDefaultAsset(category)
      if (slug === null) continue
      const asset = getCatalogAsset(slug)
      expect(asset, `${category} → ${slug} must exist in ASSET_CATALOG`).toBeDefined()
      expect(['glb', 'procedural']).toContain(asset!.geometryKind)
      // A procedural-source default must have a built procedural spec, else
      // resolveBoxResult would fall through to a generic box.
      if (asset!.geometryKind === 'procedural') {
        expect(hasProceduralAsset(slug), `${slug} needs a procedural spec`).toBe(true)
      }
    }
  })

  it('resolves the reuse-first split: 27 glb + 6 procedural + 3 null', () => {
    let glb = 0
    let procedural = 0
    let nul = 0
    for (const category of ALL_CATEGORIES) {
      const slug = categoryToDefaultAsset(category)
      if (slug === null) {
        nul++
        continue
      }
      const asset = getCatalogAsset(slug)!
      if (asset.geometryKind === 'glb') glb++
      else procedural++
    }
    expect({ glb, procedural, nul }).toEqual({ glb: 27, procedural: 6, nul: 3 })
  })

  it('maps the reported scan fixtures to real assets', () => {
    // The device complaint: scanned bathtub + sink rendered as brown boxes.
    expect(getCatalogAsset(categoryToDefaultAsset('bathtub')!)!.geometryKind).toBe('glb')
    expect(getCatalogAsset(categoryToDefaultAsset('sink')!)!.geometryKind).toBe('glb')
    // Reuse-first procedural silhouettes (incl. kitchen_faucet, the plan-table drift).
    expect(getCatalogAsset(categoryToDefaultAsset('dishwasher')!)!.geometryKind).toBe('procedural')
    expect(getCatalogAsset(categoryToDefaultAsset('kitchen_faucet')!)!.geometryKind).toBe('procedural')
    // The 3 Swift-Schicht-2 categories point at on-disk GLBs.
    expect(categoryToDefaultAsset('washing_machine')).toBe('sanitary-washing-machine')
    expect(categoryToDefaultAsset('fireplace')).toBe('decor-fireplace')
    expect(categoryToDefaultAsset('tv_cabinet')).toBe('furn-tv-cabinet-lowboard')
  })
})
