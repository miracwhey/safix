/**
 * Tests for repository/catalog-repository.ts — the InMemory catalog source
 * + the data-source registry.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  InMemorySpatialCatalogRepository,
  SupabaseSpatialCatalogRepository,
  getSpatialCatalogRepository,
  resetSpatialCatalogRepository,
} from '../../../../../src/lib/spatial/canonical/repository/catalog-repository.ts'

beforeEach(() => {
  resetSpatialCatalogRepository()
})

describe('InMemorySpatialCatalogRepository', () => {
  const repo = new InMemorySpatialCatalogRepository()

  it('serves the full published material + asset catalogs', async () => {
    expect(await repo.listMaterials()).toHaveLength(32)
    expect(await repo.listAssets()).toHaveLength(78)
  })

  it('returns defensive copies — mutating a result cannot corrupt the catalog', async () => {
    const first = await repo.listMaterials()
    first[0].displayName = 'MUTATED'
    const second = await repo.listMaterials()
    expect(second[0].displayName).not.toBe('MUTATED')
  })
})

describe('catalog repository registry', () => {
  it('returns the InMemory implementation for the in-memory source', () => {
    expect(getSpatialCatalogRepository('in-memory')).toBeInstanceOf(InMemorySpatialCatalogRepository)
  })

  it('returns the Supabase implementation for the supabase source', () => {
    expect(getSpatialCatalogRepository('supabase')).toBeInstanceOf(SupabaseSpatialCatalogRepository)
  })

  it('caches the singleton per source kind', () => {
    const a = getSpatialCatalogRepository('in-memory')
    const b = getSpatialCatalogRepository('in-memory')
    expect(a).toBe(b)
  })
})
