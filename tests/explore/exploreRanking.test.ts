/**
 * Explore Ranking — score function & cold-start fallback contract.
 *
 * The async `buildViewerContext` lives off Supabase reads and is covered
 * by the source-string contract on `exploreItemFeedService`. These tests
 * focus on the pure pieces:
 *   - scoreReelForYou: deterministic over its inputs.
 *   - sortReelsByForYou: cold-start floor + stable sort.
 */

import { describe, it, expect } from 'vitest'
import {
  scoreReelForYou,
  sortReelsByForYou,
  type ViewerContext,
} from '../../src/lib/explore/exploreRanking'
import type { ExploreReel } from '../../src/lib/explore/exploreTypes'

function makeReel(over: Partial<ExploreReel>): ExploreReel {
  return {
    id: over.id ?? 'r',
    craftsmanId: 'c',
    craftsmanName: '',
    craftsmanHandle: '@h',
    craftsmanAvatarUrl: '',
    title: '',
    category: '',
    location: '',
    thumbnailUrl: '',
    likes: 0,
    saves: 0,
    likeCount: 0,
    isLikedByCurrentUser: false,
    projectTags: [],
    searchTags: [],
    costLabel: '',
    durationLabel: '',
    createdAt: 0,
    ...over,
  }
}

function ctx(over: Partial<ViewerContext> = {}): ViewerContext {
  return {
    userId: 'u',
    likedTags: new Set<string>(),
    savedTags: new Set<string>(),
    recentJobTags: new Set<string>(),
    adjacentTags: new Set<string>(),
    ...over,
  }
}

describe('scoreReelForYou', () => {
  it('returns ~0 for an empty context + tag-less reel + ancient timestamp', () => {
    const reel = makeReel({ createdAt: 0 })
    expect(scoreReelForYou(reel, ctx())).toBe(0)
  })

  it('adds 1.0 for each direct like-tag match', () => {
    const reel = makeReel({ projectTags: ['Bad', 'Sanitär'] })
    const score = scoreReelForYou(
      reel,
      ctx({ likedTags: new Set(['Bad', 'Sanitär']) }),
    )
    expect(score).toBeCloseTo(2.0, 5)
  })

  it('adds 1.0 for save-tag match, 1.0 for recent-job-tag match', () => {
    const reel = makeReel({ projectTags: ['Bad'] })
    const score = scoreReelForYou(
      reel,
      ctx({
        savedTags: new Set(['Bad']),
        recentJobTags: new Set(['Bad']),
      }),
    )
    expect(score).toBeCloseTo(2.0, 5)
  })

  it('adds 0.5 for adjacency match (weaker than direct hit)', () => {
    const reel = makeReel({ projectTags: ['Fliesen'] })
    const direct = scoreReelForYou(reel, ctx({ likedTags: new Set(['Fliesen']) }))
    const adj = scoreReelForYou(reel, ctx({ adjacentTags: new Set(['Fliesen']) }))
    expect(direct).toBeGreaterThan(adj)
    expect(adj).toBeCloseTo(0.5, 5)
  })

  it('skips the freshness term for invalid createdAt', () => {
    const reel = makeReel({ createdAt: -1 })
    expect(scoreReelForYou(reel, ctx())).toBe(0)
  })

  it('verified + well-rated providers each contribute +0.1 quality boost', () => {
    const a = makeReel({ verified: false, ratingCount: 0 })
    const b = makeReel({ verified: true, ratingCount: 99 })
    expect(scoreReelForYou(b, ctx()) - scoreReelForYou(a, ctx())).toBeCloseTo(0.2, 5)
  })

  it('decays freshness with a 14-day half-life', () => {
    const fresh = makeReel({ createdAt: Date.now() })
    const oldish = makeReel({ createdAt: Date.now() - 14 * 86_400_000 })
    const veryOld = makeReel({ createdAt: Date.now() - 90 * 86_400_000 })
    expect(scoreReelForYou(fresh, ctx())).toBeGreaterThan(scoreReelForYou(oldish, ctx()))
    expect(scoreReelForYou(oldish, ctx())).toBeGreaterThan(scoreReelForYou(veryOld, ctx()))
  })

  it('trims and skips empty tags so leading/trailing space cannot fake matches or scores', () => {
    const reel = makeReel({ projectTags: ['  Bad  ', '', '   '] })
    const score = scoreReelForYou(reel, ctx({ likedTags: new Set(['Bad']) }))
    expect(score).toBeCloseTo(1.0, 5)
  })
})

describe('sortReelsByForYou', () => {
  const inspiration = [
    makeReel({ id: 'a', projectTags: ['Sauna'] }),
    makeReel({ id: 'b', projectTags: ['Bad', 'Fliesen'] }),
    makeReel({ id: 'c', projectTags: ['Holzboden'] }),
  ]

  it('returns the input order verbatim when the context is null (unauthenticated)', () => {
    const out = sortReelsByForYou(inspiration, null)
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('falls back to input order when no reel scores above the cold-start floor', () => {
    // No tags hit; freshness 0; quality 0 → all reels at score 0.
    const out = sortReelsByForYou(inspiration, ctx())
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by score desc when a real signal hits', () => {
    const out = sortReelsByForYou(
      inspiration,
      ctx({
        likedTags: new Set(['Bad']),
        savedTags: new Set(['Fliesen']),
      }),
    )
    expect(out[0].id).toBe('b') // 2.0 (Bad + Fliesen) wins
  })

  it('preserves insertion order for ties (stable sort)', () => {
    const reels = [
      makeReel({ id: '1', projectTags: ['Bad'] }),
      makeReel({ id: '2', projectTags: ['Bad'] }),
      makeReel({ id: '3', projectTags: ['Bad'] }),
    ]
    const out = sortReelsByForYou(reels, ctx({ likedTags: new Set(['Bad']) }))
    expect(out.map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  it('handles empty reel arrays', () => {
    expect(sortReelsByForYou([], ctx({ likedTags: new Set(['Bad']) }))).toEqual([])
  })
})
