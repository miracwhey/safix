import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import ProfileReelsGrid from '../../../src/components/explore/ProfileReelsGrid'
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
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

function render(items: PortfolioItem[], likeCounts: Record<string, number> = {}): string {
  return renderToString(
    React.createElement(ProfileReelsGrid, { items, likeCounts }),
  )
}

describe('ProfileReelsGrid', () => {
  it('shows the empty state when no items are passed', () => {
    expect(render([])).toContain('Noch keine Reels')
  })

  it('marks the first tile as Pin', () => {
    const html = render([
      makeItem({ id: 'a' }),
      makeItem({ id: 'b' }),
    ])
    const pinMatches = html.match(/>Pin</g) ?? []
    expect(pinMatches.length).toBe(1)
  })

  it('renders the like count from the provided lookup', () => {
    const html = render(
      [makeItem({ id: 'a' })],
      { a: 42 },
    )
    expect(html).toContain('42')
  })

  it('renders a video element for items with mediaType=video', () => {
    const html = render([makeItem({ id: 'a', mediaType: 'video', publicUrl: 'https://cdn/v.mp4' })])
    expect(html).toContain('<video')
  })
})
