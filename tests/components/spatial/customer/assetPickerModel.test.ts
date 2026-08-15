/**
 * Tests for assetPickerModel (V1.6.1 Möbel-Place-Flow Phase 3).
 */
import { describe, it, expect } from 'vitest'
import {
  ASSET_PICKER_PILLS,
  buildAssetSections,
  formatAssetFootprint,
  assetThumbnailUrl,
} from '../../../../src/components/spatial/customer/assetPickerModel.ts'
import type { CatalogAsset } from '../../../../src/lib/spatial/canonical/catalog/types.ts'

describe('ASSET_PICKER_PILLS', () => {
  it('lists Möbel first, four categories', () => {
    expect(ASSET_PICKER_PILLS.map((p) => p.id)).toEqual([
      'furniture',
      'sanitary',
      'kitchen',
      'architecture',
    ])
  })
})

describe('buildAssetSections', () => {
  it('groups furniture into ordered sub-sections, only placeable (objectCategory != null)', () => {
    const sections = buildAssetSections('furniture')
    expect(sections.length).toBeGreaterThan(0)
    // every asset in every section is published with a fine objectCategory
    for (const s of sections) {
      expect(s.assets.length).toBeGreaterThan(0)
      for (const a of s.assets) {
        expect(a.published).toBe(true)
        expect(a.objectCategory).not.toBeNull()
      }
    }
    // sub-sections are ordered: Sitzen before Tische before Schlafen
    const labels = sections.map((s) => s.label)
    const sit = labels.indexOf('Sitzen')
    const tische = labels.indexOf('Tische')
    expect(sit).toBeGreaterThanOrEqual(0)
    expect(tische).toBeGreaterThan(sit)
  })

  it('places the 3-seater sofa under "Sitzen"', () => {
    const sit = buildAssetSections('furniture').find((s) => s.label === 'Sitzen')
    expect(sit?.assets.some((a) => a.slug === 'furn-sofa-3seater-fabric-grey')).toBe(true)
  })

  it('does not duplicate an asset across sections', () => {
    const slugs = buildAssetSections('furniture').flatMap((s) => s.assets.map((a) => a.slug))
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe('formatAssetFootprint', () => {
  const mk = (w: number, d: number): CatalogAsset =>
    ({ dimensions: { width_m: w, depth_m: d, height_m: 1 } }) as CatalogAsset

  it('formats German comma + trims trailing zeros', () => {
    expect(formatAssetFootprint(mk(2.1, 0.92))).toBe('2,1 × 0,92 m')
    expect(formatAssetFootprint(mk(2, 1))).toBe('2 × 1 m')
    expect(formatAssetFootprint(mk(1.4, 1.9))).toBe('1,4 × 1,9 m')
  })
})

describe('assetThumbnailUrl', () => {
  it('returns null when no thumbnail path', () => {
    expect(assetThumbnailUrl({ thumbnailStoragePath: null } as CatalogAsset)).toBeNull()
  })
  it('resolves a path to a url', () => {
    const url = assetThumbnailUrl({
      thumbnailStoragePath: 'spatial-assets/thumbnails/furn-sofa-3seater-fabric-grey.jpg',
    } as CatalogAsset)
    expect(url).toMatch(/thumbnails\/furn-sofa-3seater-fabric-grey\.jpg$/)
  })
})
