/**
 * ExploreFeed — M3.1 Item-Feed Wiring Contract
 *
 * Freezes the screen-level wiring so future refactors cannot silently revert
 * the BottomNav `/explore` Reels feed back to the provider-discovery shape.
 *
 * Frozen invariants:
 *   A. Imports fetchExploreItemFeedPage (NOT getExploreFeedWithProviders)
 *   B. Renders ExploreReelCard for each reel with vertical scroll-snap
 *   C. visibilitychange listener bumps feedLoadEpoch on `visible`
 *   D. Realtime subscription on provider_media for INSERT events filters
 *      kind='portfolio' and only triggers refresh when published=true
 *   E. Cursor-paginated loadMore consumes nextCursor without offset math
 *   F. BottomNav is unchanged: active="explore" + bottomNavVariant="immersive"
 *   G. Feed-error retry resets feedLoadEpoch (single source of refresh trigger)
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/screens/ExploreFeed.tsx'),
  'utf-8',
)

describe('ExploreFeed: data source', () => {
  it('imports fetchExploreItemFeedPage from the item-feed service', () => {
    expect(source).toContain(
      "from '../lib/explore/exploreItemFeedService'",
    )
    expect(source).toContain('fetchExploreItemFeedPage')
  })

  it('does not import the legacy provider-feed builder', () => {
    expect(source).not.toContain('getExploreFeedWithProviders')
    expect(source).not.toContain('getExploreFeedAsync')
  })
})

describe('ExploreFeed: visibilitychange refresh', () => {
  it('subscribes to visibilitychange', () => {
    expect(source).toContain("addEventListener('visibilitychange'")
  })

  it('bumps feedLoadEpoch when visibility flips to visible', () => {
    expect(source).toMatch(/document\.visibilityState === 'visible'/)
    expect(source).toMatch(/setFeedLoadEpoch\(\(n\)\s*=>\s*n\s*\+\s*1\)/)
  })
})

describe('ExploreFeed: realtime channel', () => {
  it('subscribes to postgres_changes on provider_media INSERT', () => {
    expect(source).toMatch(/event:\s*['"]INSERT['"]/)
    expect(source).toMatch(/table:\s*['"]provider_media['"]/)
  })

  it("filters realtime payloads to kind=eq.portfolio", () => {
    expect(source).toContain("filter: 'kind=eq.portfolio'")
  })

  it('only refreshes when payload.new.published is true', () => {
    expect(source).toContain('if (!row?.published) return')
  })

  it('throttles realtime-driven refreshes via a leading-edge timer', () => {
    expect(source).toContain('pendingTimer')
    expect(source).toContain('1500')
  })

  it('removes the channel on unmount', () => {
    expect(source).toContain('supabase.removeChannel(channel)')
  })
})

describe('ExploreFeed: cursor pagination', () => {
  it('threads nextCursor back into fetchExploreItemFeedPage', () => {
    expect(source).toContain('cursor: nextCursor')
  })

  it('skips loadMore when there is no more data (nextCursor === null)', () => {
    expect(source).toContain('if (!nextCursor) return')
  })

  it('hides the bottom sentinel when nextCursor is null', () => {
    expect(source).toContain('nextCursor !== null && reels.length > 0')
  })

  it('drops duplicate reels that may surface across realtime + cursor races', () => {
    expect(source).toMatch(/seen\.has\(r\.id\)/)
  })
})

describe('ExploreFeed: BottomNav unchanged', () => {
  it('keeps active="explore" prop', () => {
    expect(source).toContain('active="explore"')
  })

  it('keeps the immersive BottomNav variant', () => {
    expect(source).toContain('bottomNavVariant="immersive"')
  })
})

describe('ExploreFeed: error retry', () => {
  it('retry button bumps feedLoadEpoch (no parallel refresh path)', () => {
    expect(source).toMatch(/onClick=\{\(\)\s*=>\s*setFeedLoadEpoch\(\(n\)\s*=>\s*n\s*\+\s*1\)\}/)
  })
})

describe('ExploreFeed: PR-D ranking + visual polish', () => {
  it('imports buildViewerContext from the ranking module', () => {
    expect(source).toContain("from '../lib/explore/exploreRanking'")
    expect(source).toContain('buildViewerContext')
  })

  it('threads viewerContext into both the initial feed fetch and pagination', () => {
    expect(source).toMatch(/fetchExploreItemFeedPage\(\{[\s\S]*?viewerContext/)
  })

  it('refetches the feed when viewerContext resolves so for-you reflects the signals as soon as they land', () => {
    expect(source).toMatch(/\[activeTab,\s*feedLoadEpoch,\s*session\.user\?\.id,\s*viewerContext\]/)
  })

  it('uses Liquid-Glass dark surface for the tab pill bar', () => {
    expect(source).toContain('liquid-glass-dark')
  })

  it('crossfade re-keys the reel list on tab change', () => {
    expect(source).toMatch(/key=\{activeTab\}[\s\S]*?reel-tab-fade-in/)
  })

  it('hides the browser scrollbar on the reel feed (issue #6)', () => {
    expect(source).toContain('reels-no-scrollbar')
  })
})
