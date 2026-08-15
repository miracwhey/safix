import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import ProfilePortfolioGrid from '../../../src/components/explore/ProfilePortfolioGrid'
import type { PortfolioItem } from '../../../src/lib/providerMedia'

function makeItem(partial: Partial<PortfolioItem>): PortfolioItem {
  return {
    id: 'item',
    providerId: 'provider-1',
    kind: 'portfolio',
    storagePath: null,
    publicUrl: 'https://cdn/x.jpg',
    mediaType: 'image',
    title: null,
    caption: null,
    description: null,
    tradeTags: [],
    sortOrder: 0,
    published: true,
    showPrice: false,
    showDuration: false,
    sourceJobId: null,
    projectTitleSnapshot: null,
    locationSnapshot: null,
    durationSnapshot: null,
    amountSnapshot: null,
    tradeTagsSnapshot: [],
    assets: [],
    createdAt: new Date('2025-06-01').getTime(),
    updatedAt: 0,
    ...partial,
  }
}

function render(items: PortfolioItem[], activeFilter: string | null = null): string {
  return renderToString(
    React.createElement(ProfilePortfolioGrid, {
      items,
      activeFilter,
      onActiveFilterChange: () => {},
    }),
  )
}

describe('ProfilePortfolioGrid', () => {
  it('shows the empty state when there are no items', () => {
    const html = render([])
    expect(html).toContain('Noch keine Arbeitsproben')
  })

  it('builds filter chips from item trade tags (snapshot first)', () => {
    const html = render([
      makeItem({ id: '1', tradeTagsSnapshot: ['Elektrik'] }),
      makeItem({ id: '2', tradeTags: ['Bad'] }),
    ])
    expect(html).toContain('Alle')
    expect(html).toContain('Elektrik')
    expect(html).toContain('Bad')
  })

  it('renders 3:4 reels tiles (no inline title text — full-bleed tile design)', () => {
    const html = render([
      makeItem({ id: '1', projectTitleSnapshot: 'Wallbox-Projekt' }),
      makeItem({ id: '2', title: 'Bad-Sanierung', projectTitleSnapshot: null }),
    ])
    // Tile layout: cover image rendered, no prose title overlay. Reels-Redesign
    // „Handwerker Reels Profil" → 3-Spalten-Grid mit aspect 3/4.
    expect(html).toContain('aspect-[3/4]')
    expect(html).not.toContain('Wallbox-Projekt')
    expect(html).not.toContain('Bad-Sanierung')
  })

  it('shows the SourceJobMarker for items with a sourceJobId', () => {
    const html = render([
      makeItem({
        id: '1',
        sourceJobId: 'job-1',
        projectTitleSnapshot: 'Wallbox',
        tradeTagsSnapshot: ['Elektrik'],
        locationSnapshot: 'Berlin',
      }),
    ])
    expect(html).toContain('Elektrik')
    expect(html).toContain('Berlin')
  })
})
