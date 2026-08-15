import { describe, it, expect } from 'vitest'
import { applyDistinctProviderWindow } from '../../src/lib/explore/distinctProviderWindow'
import type { ExploreReel } from '../../src/lib/explore/exploreTypes'

function makeReel(id: string, providerId: string | undefined): ExploreReel {
  return {
    id,
    mediaId: id,
    mediaType: 'image',
    mediaUrl: `https://cdn/${id}.jpg`,
    posterUrl: null,
    h264Url: null,
    providerId,
    craftsmanId: providerId ?? `unknown-${id}`,
    craftsmanName: 'Test',
    craftsmanHandle: '@test',
    craftsmanAvatarUrl: '',
    title: '',
    category: '',
    location: '',
    thumbnailUrl: `https://cdn/${id}.jpg`,
    likes: 0,
    saves: 0,
    likeCount: 0,
    isLikedByCurrentUser: false,
    projectTags: [],
    searchTags: [],
    costLabel: '',
    durationLabel: '',
    createdAt: 0,
  }
}

describe('applyDistinctProviderWindow', () => {
  it('returns empty array unchanged', () => {
    expect(applyDistinctProviderWindow([])).toEqual([])
  })

  it('returns single reel unchanged', () => {
    const reels = [makeReel('a', 'p1')]
    expect(applyDistinctProviderWindow(reels)).toEqual(reels)
  })

  it('returns input unchanged when windowSize <= 1', () => {
    const reels = [makeReel('a', 'p1'), makeReel('b', 'p1'), makeReel('c', 'p1')]
    expect(applyDistinctProviderWindow(reels, 0).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(applyDistinctProviderWindow(reels, 1).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps already-distinct sequence stable', () => {
    const reels = [
      makeReel('a', 'p1'),
      makeReel('b', 'p2'),
      makeReel('c', 'p3'),
      makeReel('d', 'p4'),
    ]
    const out = applyDistinctProviderWindow(reels, 5)
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reorders single-provider runs by deferring repeats to later positions', () => {
    // 4 items from p1 in a row, plus 2 different providers — window=3.
    const reels = [
      makeReel('w1', 'p1'),
      makeReel('w2', 'p1'),
      makeReel('w3', 'p1'),
      makeReel('w4', 'p1'),
      makeReel('m1', 'p2'),
      makeReel('s1', 'p3'),
    ]
    const out = applyDistinctProviderWindow(reels, 3)
    // First slot stays w1; next two slots must NOT be p1 (window=3 includes w1).
    expect(out[0].id).toBe('w1')
    expect(out[0].providerId).toBe('p1')
    // No two adjacent p1 reels within the next 2 positions
    expect(out[1].providerId).not.toBe('p1')
    expect(out[2].providerId).not.toBe('p1')
    // Bench drains all original items (no drop)
    expect(out.length).toBe(reels.length)
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(reels.map((r) => r.id)))
  })

  it('drains bench in FIFO when only one provider exists', () => {
    // All same provider → constraint cannot be satisfied; output keeps all
    // reels in the original order (no drops).
    const reels = Array.from({ length: 6 }, (_, i) => makeReel(`x${i}`, 'p1'))
    const out = applyDistinctProviderWindow(reels, 5)
    expect(out.length).toBe(6)
    expect(out.map((r) => r.id)).toEqual(reels.map((r) => r.id))
  })

  it('treats reels without providerId as anonymous (never blocks others)', () => {
    const reels = [
      makeReel('legacy1', undefined),
      makeReel('legacy2', undefined),
      makeReel('a', 'p1'),
    ]
    // Each anonymous gets its own bucket, so no one is benched.
    const out = applyDistinctProviderWindow(reels, 5)
    expect(out.map((r) => r.id)).toEqual(['legacy1', 'legacy2', 'a'])
  })

  it('is deterministic — same input produces same output', () => {
    const reels = [
      makeReel('a', 'p1'),
      makeReel('b', 'p2'),
      makeReel('c', 'p1'),
      makeReel('d', 'p1'),
      makeReel('e', 'p3'),
    ]
    const out1 = applyDistinctProviderWindow(reels, 3)
    const out2 = applyDistinctProviderWindow(reels, 3)
    expect(out1.map((r) => r.id)).toEqual(out2.map((r) => r.id))
  })

  it('respects window across mixed sequences when constraint is satisfiable', () => {
    // 5 providers × 3 items each, window=4 — pigeonhole-OK (at most 1 per
    // provider per 4-reel window is achievable when distinct providers >= window).
    const reels: ExploreReel[] = []
    const providers = ['pA', 'pB', 'pC', 'pD', 'pE']
    for (let i = 0; i < 3; i++) {
      for (const p of providers) reels.push(makeReel(`${p}${i}`, p))
    }
    const out = applyDistinctProviderWindow(reels, 4)
    expect(out.length).toBe(reels.length)
    // Sliding window of 4: any 4 consecutive must have <= 1 reel per provider
    for (let i = 0; i + 3 < out.length; i++) {
      const slice = out.slice(i, i + 4)
      const counts = new Map<string, number>()
      for (const r of slice) {
        const pid = r.providerId ?? '__anon__'
        counts.set(pid, (counts.get(pid) ?? 0) + 1)
      }
      for (const [, n] of counts) {
        expect(n).toBeLessThanOrEqual(1)
      }
    }
  })

  it('degrades gracefully when distinct providers < windowSize (Pigeonhole)', () => {
    // 3 providers × 4 items each, window=5 — Pigeonhole: cannot avoid repeats
    // within any 5-reel slice. Algorithm must still preserve all items and
    // bias toward provider rotation, but the strict per-window invariant is
    // explicitly relaxed (documented in distinctProviderWindow.ts).
    const reels: ExploreReel[] = []
    for (let i = 0; i < 4; i++) {
      reels.push(makeReel(`weber${i}`, 'pWeber'))
      reels.push(makeReel(`fliesen${i}`, 'pFliesen'))
      reels.push(makeReel(`maler${i}`, 'pMaler'))
    }
    const out = applyDistinctProviderWindow(reels, 5)
    // No drop, all reels surface exactly once
    expect(out.length).toBe(reels.length)
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(reels.map((r) => r.id)))
    // Adjacent positions are still distinct providers (the relaxation only
    // affects window-wide counts, not pairwise neighbors).
    for (let i = 1; i < out.length; i++) {
      expect(out[i].providerId).not.toBe(out[i - 1].providerId)
    }
  })

  it('does not mutate the input array', () => {
    const reels = [makeReel('a', 'p1'), makeReel('b', 'p1'), makeReel('c', 'p2')]
    const snapshot = reels.map((r) => r.id)
    applyDistinctProviderWindow(reels, 5)
    expect(reels.map((r) => r.id)).toEqual(snapshot)
  })
})
