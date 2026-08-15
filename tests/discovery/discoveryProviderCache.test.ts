import { describe, expect, it, beforeEach } from 'vitest'
import {
  getCachedProviderCount,
  setDiscoveryProviderCache,
  clearDiscoveryProviderCache,
} from '../../src/lib/discovery/discoveryProviderCache'
import type { ExploreProviderCard } from '../../src/lib/explore/exploreTypes'

function makeCard(id: string): ExploreProviderCard {
  return {
    craftsmanId: id,
    craftsmanName: `Provider ${id}`,
    craftsmanHandle: `@p_${id}`,
    location: 'Hannover',
    primaryCategory: 'Elektrik',
    tradeCategories: ['Elektrik'],
    servicesOffered: ['Elektrik'],
    serviceRadiusKm: 25,
  }
}

describe('discoveryProviderCache', () => {
  beforeEach(() => {
    clearDiscoveryProviderCache()
  })

  it('getCachedProviderCount returns 0 when cache is empty', () => {
    expect(getCachedProviderCount()).toBe(0)
  })

  it('getCachedProviderCount reflects the size of the cached set', () => {
    setDiscoveryProviderCache([makeCard('a'), makeCard('b'), makeCard('c')])
    expect(getCachedProviderCount()).toBe(3)
  })

  it('clearDiscoveryProviderCache resets the count', () => {
    setDiscoveryProviderCache([makeCard('a')])
    expect(getCachedProviderCount()).toBe(1)
    clearDiscoveryProviderCache()
    expect(getCachedProviderCount()).toBe(0)
  })
})
