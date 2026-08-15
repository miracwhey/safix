/**
 * Tests for the Material-Picker presentation model (pure helpers).
 */
import { describe, it, expect } from 'vitest'

import {
  CATEGORY_PILLS,
  surfaceTypeToCategory,
  materialThumbnailUrl,
  materialFinishLabel,
} from '../../../../src/components/spatial/edit/materialPickerModel.ts'
import { getCatalogMaterial } from '../../../../src/lib/spatial/canonical/catalog/material-catalog.ts'

describe('materialPickerModel', () => {
  it('exposes the 5 Category-Pills in display order', () => {
    expect(CATEGORY_PILLS.map((p) => p.id)).toEqual(['wall', 'floor', 'counter', 'metal', 'decor'])
  })

  it('maps every surface type to a material category — incl. decor (reachable)', () => {
    expect(surfaceTypeToCategory('wall')).toBe('wall')
    expect(surfaceTypeToCategory('floor')).toBe('floor')
    expect(surfaceTypeToCategory('counter')).toBe('counter')
    expect(surfaceTypeToCategory('ceiling')).toBe('wall')
    expect(surfaceTypeToCategory('fixture')).toBe('metal')
    expect(surfaceTypeToCategory('decor')).toBe('decor')
  })

  it('derives a public thumbnail URL + finish label from a catalog material', () => {
    const material = getCatalogMaterial('wall-tile-white')!
    expect(materialThumbnailUrl(material)).toBe(
      '/spatial-assets/materials/thumbnails/wall-tile-white.jpg',
    )
    expect(materialFinishLabel(material)).toBe('Fliesen')
  })
})
