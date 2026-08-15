import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import ProfileTabBar from '../../../src/components/explore/ProfileTabBar'
import type { ProfileTabKey } from '../../../src/components/explore/ProfileTabBar'

function render(active: ProfileTabKey, counts = { portfolio: 8, stimmen: 4 }): string {
  return renderToString(
    React.createElement(ProfileTabBar, {
      active,
      onChange: () => {},
      portfolioCount: counts.portfolio,
      reviewsCount: counts.stimmen,
    }),
  )
}

describe('ProfileTabBar', () => {
  it('renders two tabs (Portfolio + Stimmen) with their counts', () => {
    const html = render('portfolio')
    expect(html).toContain('Portfolio')
    expect(html).toContain('Stimmen')
    expect(html).toContain('8')
    expect(html).toContain('4')
    // Reels tab removed (merged into Portfolio)
    expect(html).not.toContain('>Reels<')
  })

  it('marks the active tab via aria-selected', () => {
    const html = render('portfolio')
    const trueMatches = html.match(/aria-selected="true"/g) ?? []
    expect(trueMatches.length).toBe(1)
    const falseMatches = html.match(/aria-selected="false"/g) ?? []
    expect(falseMatches.length).toBe(1)
  })

  it('formats counts >= 1000 as k', () => {
    const html = render('portfolio', { portfolio: 1234, stimmen: 0 })
    expect(html).toContain('1.2k')
  })
})
