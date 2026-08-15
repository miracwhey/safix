import type { ExploreReel } from './exploreTypes'

/**
 * Re-orders the feed so the same provider does not appear twice within a
 * sliding window of `windowSize` consecutive reels. Pure, deterministic;
 * stable for inputs that already satisfy the constraint.
 *
 * Why this exists
 *   The naive `sort_order DESC` query returns up to N items per provider in a
 *   single block (e.g. a craftsman who just published 4 portfolio items in a
 *   row). Without re-ordering, customers would see four reels of the same
 *   handwerker before any other voice — which is the cardinal Insta/TikTok
 *   "single-creator-spam" anti-pattern. The rest of the recommendation block
 *   (M3.2 scoring) doesn't address this — it's an orthogonal concern.
 *
 * Algorithm
 *   Greedy with a bench queue:
 *     1. Walk the input in order.
 *     2. Track the providerIds that appeared in the last `windowSize` *output*
 *        positions.
 *     3. If the next candidate's providerId is not in the window → emit.
 *     4. If it is → push to a bench queue tagged by providerId.
 *     5. After every emit, sweep the bench front-to-back and try to release
 *        the earliest bench item whose providerId left the window.
 *     6. After the input is exhausted, drain the bench in FIFO order onto the
 *        tail (this is the only place the constraint can be relaxed; we never
 *        drop reels).
 *
 *   Complexity: O(n * windowSize) which is fine for feeds up to a few hundred
 *   items — far below any pagination boundary we'd actually hit.
 *
 * Edge cases
 *   - Empty input  → empty output.
 *   - Single reel  → unchanged.
 *   - All same provider → unchanged (bench drains as tail; no drops).
 *   - Reel with no providerId (legacy provider-feed shape, M3.1 transitional)
 *     is treated as its own "anonymous" bucket so it never blocks others.
 *   - windowSize <= 1 → unchanged input (no constraint).
 */
export function applyDistinctProviderWindow(
  reels: ExploreReel[],
  windowSize = 5,
): ExploreReel[] {
  if (reels.length <= 1) return reels.slice()
  if (windowSize <= 1) return reels.slice()

  const providerOf = (r: ExploreReel): string => r.providerId ?? `__anon__:${r.id}`

  const output: ExploreReel[] = []
  const recent: string[] = [] // providerId queue, length <= windowSize
  const bench: ExploreReel[] = []

  const inWindow = (pid: string): boolean => recent.includes(pid)

  const emit = (reel: ExploreReel) => {
    output.push(reel)
    const pid = providerOf(reel)
    recent.push(pid)
    if (recent.length > windowSize) recent.shift()
  }

  // Try to release a bench item whose provider has just left the window.
  const sweepBench = () => {
    let i = 0
    while (i < bench.length) {
      const candidate = bench[i]
      if (!inWindow(providerOf(candidate))) {
        bench.splice(i, 1)
        emit(candidate)
        // Don't advance i — after emit() the window state moved, re-scan
        // from the same index in case another bench item is now releasable.
        continue
      }
      i++
    }
  }

  for (const reel of reels) {
    const pid = providerOf(reel)
    if (inWindow(pid)) {
      bench.push(reel)
    } else {
      emit(reel)
      sweepBench()
    }
  }

  // Drain bench in FIFO. This relaxes the constraint when we'd otherwise drop
  // reels, which is the explicit trade-off documented in the plan.
  for (const reel of bench) output.push(reel)

  return output
}
