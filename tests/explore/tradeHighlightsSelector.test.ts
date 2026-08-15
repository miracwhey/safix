import { describe, it, expect } from 'vitest'
import { deriveTradeHighlights } from '../../src/lib/explore/tradeHighlightsSelector'
import type { PortfolioItem } from '../../src/lib/providerMedia'

function makeItem(partial: Partial<PortfolioItem>): PortfolioItem {
  return {
    id: partial.id ?? 'item',
    providerId: 'provider-1',
    kind: 'portfolio',
    storagePath: null,
    publicUrl: partial.publicUrl ?? null,
    mediaType: 'image',
    title: null,
    caption: null,
    description: null,
    tradeTags: partial.tradeTags ?? [],
    sortOrder: 0,
    published: true,
    showPrice: false,
    showDuration: false,
    sourceJobId: null,
    projectTitleSnapshot: null,
    locationSnapshot: null,
    durationSnapshot: null,
    amountSnapshot: null,
    tradeTagsSnapshot: partial.tradeTagsSnapshot ?? [],
    assets: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('deriveTradeHighlights', () => {
  it('returns empty when there are no trade categories', () => {
    expect(deriveTradeHighlights([], [])).toEqual([])
  })

  it('keeps the order of the provided trade categories and dedupes', () => {
    const result = deriveTradeHighlights(['Elektrik', ' Bad ', 'Elektrik', ''], [])
    expect(result.map((h) => h.trade)).toEqual(['Elektrik', 'Bad'])
  })

  it('matches a cover via tradeTagsSnapshot before tradeTags (case-insensitive)', () => {
    const items = [
      makeItem({
        id: 'a',
        publicUrl: 'https://cdn/a.jpg',
        tradeTagsSnapshot: ['ELEKTRIK'],
      }),
      makeItem({
        id: 'b',
        publicUrl: 'https://cdn/b.jpg',
        tradeTags: ['bad'],
      }),
    ]
    const result = deriveTradeHighlights(['Elektrik', 'Bad'], items)
    expect(result).toEqual([
      { trade: 'Elektrik', coverPublicUrl: 'https://cdn/a.jpg' },
      { trade: 'Bad', coverPublicUrl: 'https://cdn/b.jpg' },
    ])
  })

  it('falls back to null cover when no portfolio item lists the trade', () => {
    const items = [makeItem({ id: 'a', publicUrl: 'https://cdn/a.jpg', tradeTags: ['Elektrik'] })]
    const result = deriveTradeHighlights(['Maler'], items)
    expect(result).toEqual([{ trade: 'Maler', coverPublicUrl: null }])
  })

  it('skips items without a publicUrl when picking the cover', () => {
    const items = [
      makeItem({ id: 'a', publicUrl: null, tradeTags: ['Elektrik'] }),
      makeItem({ id: 'b', publicUrl: 'https://cdn/b.jpg', tradeTags: ['Elektrik'] }),
    ]
    const result = deriveTradeHighlights(['Elektrik'], items)
    expect(result[0].coverPublicUrl).toBe('https://cdn/b.jpg')
  })
})
