import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import SourceJobMarker from '../../../src/components/explore/SourceJobMarker'
import type { PortfolioItem } from '../../../src/lib/providerMedia'

function render(
  item: Pick<
    PortfolioItem,
    'sourceJobId' | 'projectTitleSnapshot' | 'tradeTagsSnapshot' | 'tradeTags' | 'locationSnapshot'
  >,
  variant: 'overlay' | 'caption' = 'caption',
): string {
  return renderToString(React.createElement(SourceJobMarker, { item, variant }))
}

describe('SourceJobMarker', () => {
  it('renders nothing when no sourceJobId is set', () => {
    const html = render({
      sourceJobId: null,
      projectTitleSnapshot: 'Wallbox',
      tradeTagsSnapshot: ['Elektrik'],
      tradeTags: [],
      locationSnapshot: 'Berlin',
    })
    expect(html).toBe('')
  })

  it('renders trade · title · location for caption variant', () => {
    const html = render({
      sourceJobId: 'job-1',
      projectTitleSnapshot: 'Wallbox',
      tradeTagsSnapshot: ['Elektrik'],
      tradeTags: [],
      locationSnapshot: 'Berlin',
    })
    expect(html).toContain('Elektrik')
    expect(html).toContain('Wallbox')
    expect(html).toContain('Berlin')
    expect(html).toContain(' · ')
  })

  it('falls back to tradeTags when tradeTagsSnapshot is empty', () => {
    const html = render({
      sourceJobId: 'job-1',
      projectTitleSnapshot: 'Bad',
      tradeTagsSnapshot: [],
      tradeTags: ['Sanitär'],
      locationSnapshot: null,
    })
    expect(html).toContain('Sanitär')
    expect(html).toContain('Bad')
  })

  it('returns empty string when all fields are missing', () => {
    const html = render({
      sourceJobId: 'job-1',
      projectTitleSnapshot: null,
      tradeTagsSnapshot: [],
      tradeTags: [],
      locationSnapshot: null,
    })
    expect(html).toBe('')
  })
})
