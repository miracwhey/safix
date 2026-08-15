/**
 * Tests for catalog/ (Day 18-20 · asset + material registries + LOD).
 *
 * The TS catalog constants are the source of truth the seed migrations
 * mirror — these tests pin the counts, slug uniqueness, the procedural/GLB
 * split and the cross-references into the procedural geometry layer.
 */
import { describe, it, expect } from 'vitest'

import {
  ASSET_CATALOG,
  getCatalogAsset,
  getCatalogAssetsByCategory,
} from '../../../../../src/lib/spatial/canonical/catalog/asset-catalog.ts'
import {
  MATERIAL_CATALOG,
  getCatalogMaterial,
  getCatalogMaterialsBySurface,
} from '../../../../../src/lib/spatial/canonical/catalog/material-catalog.ts'
import {
  selectLodLevel,
  buildLodProfile,
  lodGlbPath,
} from '../../../../../src/lib/spatial/canonical/catalog/lod.ts'
import { hasProceduralAsset } from '../../../../../src/lib/spatial/canonical/geometry/procedural-assets.ts'

describe('asset-catalog', () => {
  it('has 78 entries split 13 / 10 / 17 / 38', () => {
    // V1 base 36 + batch-1 9 + phase-1.2 19 + phase-2 9 + batch-2 5 = 78.
    expect(ASSET_CATALOG).toHaveLength(78)
    expect(getCatalogAssetsByCategory('sanitary')).toHaveLength(13)
    expect(getCatalogAssetsByCategory('kitchen')).toHaveLength(10)
    expect(getCatalogAssetsByCategory('architecture')).toHaveLength(17)
    expect(getCatalogAssetsByCategory('furniture')).toHaveLength(38)
  })

  it('has unique slugs', () => {
    const slugs = new Set(ASSET_CATALOG.map((a) => a.slug))
    expect(slugs.size).toBe(78)
  })

  it('procedural assets carry no GLB path and have a real placeholder mesh', () => {
    // Procedural = 8 V1 architecture openings/fixtures + phase-2 9 DE-hero
    // generators + remaining V1 procedural slots, minus the 3 L0 wall fixtures
    // (radiator/outlet/switch) upgraded to CC-BY GLB = 27 procedural.
    const procedural = ASSET_CATALOG.filter((a) => a.geometryKind === 'procedural')
    expect(procedural).toHaveLength(27)
    for (const asset of procedural) {
      expect(asset.gltfStoragePath).toBeNull()
      expect(asset.lodLevels).toBeNull()
      expect(asset.vendor).toBe('procedural')
      expect(hasProceduralAsset(asset.slug)).toBe(true)
      expect(asset.polycountLod0).toBeGreaterThan(0)
    }
  })

  it('GLB assets carry a storage path + a 3-entry LOD profile', () => {
    // 15 V1 (10 furniture + 5 B-6 fixtures) + 9 batch-1 + 19 phase-1.2
    // + 5 batch-2 + 3 L0 wall fixtures (radiator/outlet/switch, CC-BY) = 51 GLB.
    const glb = ASSET_CATALOG.filter((a) => a.geometryKind === 'glb')
    expect(glb).toHaveLength(51)
    for (const asset of glb) {
      expect(asset.gltfStoragePath).toMatch(/^spatial-assets\/models\//)
      expect(asset.lodLevels).toHaveLength(3)
      expect(asset.lodLevels?.[0].level).toBe(0)
    }
  })

  it('every asset is CC0 (or CC-BY-3.0 with attribution) and published with sane dimensions', () => {
    for (const asset of ASSET_CATALOG) {
      // V1 baseline is CC0-only; the 3 L0 wall fixtures ship CC-BY-3.0 because
      // no scriptable CC0 radiator/outlet/switch exists — those MUST carry a
      // non-empty attribution (surfaced in the in-app credits screen).
      if (asset.license === 'CC-BY-3.0') {
        expect(asset.attribution, `${asset.slug} CC-BY needs attribution`).toBeTruthy()
        expect(asset.sourceUrl, `${asset.slug} CC-BY needs sourceUrl`).toBeTruthy()
      } else {
        expect(asset.license).toBe('CC0-1.0')
      }
      expect(asset.published).toBe(true)
      for (const dim of Object.values(asset.dimensions)) {
        expect(dim).toBeGreaterThan(0)
        expect(dim).toBeLessThan(3)
      }
    }
  })

  it('getCatalogAsset resolves by slug', () => {
    expect(getCatalogAsset('sanitary-toilet-standard-floor')?.displayName).toBe('Stand-WC')
    expect(getCatalogAsset('nope')).toBeUndefined()
  })

  it('the tripod floor lamp snaps to the floor, not the ceiling', () => {
    // `lamp` ObjectCategory defaults to a ceiling host — the floor lamp must
    // carry an explicit floor snap rule (review fix).
    expect(getCatalogAsset('furn-floor-lamp-tripod')?.snapRule.target_host).toBe('floor')
  })

  it('vanity assets are flagged as counter hosts (B-2)', () => {
    expect(getCatalogAsset('sanitary-sink-vanity-rectangle')?.isCounterHost).toBe(true)
    expect(getCatalogAsset('sanitary-sink-double-vanity')?.isCounterHost).toBe(true)
    // A plain fixture is not a counter host.
    expect(getCatalogAsset('sanitary-toilet-standard-floor')?.isCounterHost).toBe(false)
  })

  it('every catalog asset carries the sourceUrl + isCounterHost fields', () => {
    for (const asset of ASSET_CATALOG) {
      expect(typeof asset.isCounterHost).toBe('boolean')
      expect(asset.sourceUrl === null || typeof asset.sourceUrl === 'string').toBe(true)
    }
  })

  it('GLB LOD2 distance_m_max is a finite sentinel (JSON-safe, no Infinity)', () => {
    for (const asset of ASSET_CATALOG) {
      if (!asset.lodLevels) continue
      for (const lod of asset.lodLevels) {
        expect(Number.isFinite(lod.distance_m_max)).toBe(true)
      }
    }
  })
})

describe('material-catalog', () => {
  it('has 32 entries split 10 / 8 / 6 / 4 / 4', () => {
    expect(MATERIAL_CATALOG).toHaveLength(32)
    expect(getCatalogMaterialsBySurface('wall')).toHaveLength(10)
    expect(getCatalogMaterialsBySurface('floor')).toHaveLength(8)
    expect(getCatalogMaterialsBySurface('counter')).toHaveLength(6)
    expect(getCatalogMaterialsBySurface('metal')).toHaveLength(4)
    expect(getCatalogMaterialsBySurface('decor')).toHaveLength(4)
  })

  it('has unique slugs', () => {
    expect(new Set(MATERIAL_CATALOG.map((m) => m.slug)).size).toBe(32)
  })

  it('textured materials carry an ambientCG id + albedo path', () => {
    const textured = MATERIAL_CATALOG.filter((m) => !m.procedural)
    expect(textured).toHaveLength(31)
    for (const mat of textured) {
      expect(mat.acgId).toBeTruthy()
      expect(mat.textures.albedo).toMatch(/\.ktx2$/)
      expect(mat.thumbnailPath).toMatch(/\.jpg$/)
    }
  })

  it('decor-mirror is procedural with no textures and a reflective PBR setup', () => {
    const mirror = getCatalogMaterial('decor-mirror')
    expect(mirror?.procedural).toBe(true)
    expect(mirror?.acgId).toBeNull()
    expect(mirror?.textures.albedo).toBeNull()
    expect(mirror?.metalness).toBe(1)
    expect(mirror?.roughness).toBeLessThan(0.1)
  })

  it('metal materials carry a metallic map; non-metal do not', () => {
    for (const mat of MATERIAL_CATALOG) {
      if (mat.procedural) continue
      if (mat.surfaceCategory === 'metal') expect(mat.textures.metallic).toBeTruthy()
      else expect(mat.textures.metallic).toBeNull()
    }
  })

  it('every material is CC0 with a positive non-square-capable tile scale', () => {
    for (const mat of MATERIAL_CATALOG) {
      expect(mat.license).toBe('CC0-1.0')
      expect(mat.tileScale.u).toBeGreaterThan(0)
      expect(mat.tileScale.v).toBeGreaterThan(0)
    }
  })
})

describe('lod', () => {
  it('selects the LOD band by camera distance', () => {
    expect(selectLodLevel(1)).toBe(0)
    expect(selectLodLevel(2)).toBe(0)
    expect(selectLodLevel(5)).toBe(1)
    expect(selectLodLevel(8)).toBe(1)
    expect(selectLodLevel(20)).toBe(2)
  })

  it('derives decimated LOD paths from the LOD0 path', () => {
    expect(lodGlbPath('spatial-assets/models/foo.glb', 0)).toBe('spatial-assets/models/foo.glb')
    expect(lodGlbPath('spatial-assets/models/foo.glb', 1)).toBe('spatial-assets/models/foo-lod1.glb')
    expect(lodGlbPath('spatial-assets/models/foo.glb', 2)).toBe('spatial-assets/models/foo-lod2.glb')
  })

  it('builds a decreasing 3-entry LOD profile', () => {
    const profile = buildLodProfile('spatial-assets/models/foo.glb', 12000)
    expect(profile).toHaveLength(3)
    expect(profile[0].poly_count).toBe(12000)
    expect(profile[1].poly_count).toBeLessThan(profile[0].poly_count)
    expect(profile[2].poly_count).toBeLessThan(profile[1].poly_count)
  })
})
