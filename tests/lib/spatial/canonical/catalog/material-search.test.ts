/**
 * Tests for catalog/material-search.ts (Mockup 42 §3a search · §3b grouping).
 */
import { describe, it, expect } from 'vitest'

import {
  normalizeSearch,
  searchMaterials,
  groupMaterialsBySection,
} from '../../../../../src/lib/spatial/canonical/catalog/material-search.ts'
import {
  MATERIAL_CATALOG,
  getCatalogMaterialsBySurface,
} from '../../../../../src/lib/spatial/canonical/catalog/material-catalog.ts'

describe('material-search · normalizeSearch', () => {
  it('lower-cases, trims and strips diacritics', () => {
    expect(normalizeSearch('  Crème  ')).toBe('creme')
    expect(normalizeSearch('Anthrazit')).toBe('anthrazit')
  })

  it('folds ß to ss so "weiss" matches "Weiß"', () => {
    expect(normalizeSearch('Weiß')).toBe('weiss')
    expect(normalizeSearch('weiss')).toBe('weiss')
  })
})

describe('material-search · searchMaterials', () => {
  const wall = getCatalogMaterialsBySurface('wall')

  it('returns the full list for an empty query', () => {
    expect(searchMaterials(wall, '')).toHaveLength(wall.length)
    expect(searchMaterials(wall, '   ')).toHaveLength(wall.length)
  })

  it('matches diacritic-insensitively against the display name', () => {
    const hits = searchMaterials(wall, 'weiss')
    expect(hits.some((m) => m.slug === 'wall-tile-white')).toBe(true)
    expect(hits.some((m) => m.slug === 'wall-brick-white')).toBe(true)
  })

  it('matches against tag synonyms (DE + EN)', () => {
    expect(searchMaterials(wall, 'glossy').some((m) => m.slug === 'wall-tile-white')).toBe(true)
    expect(searchMaterials(wall, 'ziegel').some((m) => m.slug === 'wall-brick-white')).toBe(true)
  })

  it('returns an empty list for a no-match query', () => {
    expect(searchMaterials(wall, 'zzznomatch')).toHaveLength(0)
  })
})

describe('material-search · groupMaterialsBySection', () => {
  it('buckets wall materials into the curated Typ-Sektionen in order', () => {
    const sections = groupMaterialsBySection(getCatalogMaterialsBySurface('wall'))
    expect(sections.map((s) => s.section)).toEqual([
      'Farbe & Putz',
      'Fliesen',
      'Holz & Tapete',
      'Beton & Ziegel',
    ])
    const total = sections.reduce((sum, s) => sum + s.materials.length, 0)
    expect(total).toBe(10)
  })

  it('every material in the catalog lands in exactly one section per surface', () => {
    for (const surface of ['wall', 'floor', 'counter', 'metal', 'decor'] as const) {
      const list = getCatalogMaterialsBySurface(surface)
      const grouped = groupMaterialsBySection(list)
      const flat = grouped.flatMap((s) => s.materials)
      expect(flat).toHaveLength(list.length)
    }
    expect(MATERIAL_CATALOG).toHaveLength(32)
  })
})
