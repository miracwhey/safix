/**
 * useReelAutoPlay — Source-of-Truth Contract (single-authority model, Block 4)
 *
 * The FEED (ExploreFeed) owns the one IntersectionObserver and passes the
 * active reel + foreground flag down. This hook has NO per-card observer; a
 * single derived `shouldPlay` drives play / eager-pause so two reels never
 * play at once and audio never trails the active card or leaks on a tab switch.
 *
 * Frozen invariants:
 *   A. shouldPlay = enabled && active && feedVisible && showingVideo && !paused
 *   B. No per-card IntersectionObserver (the single authority lives in the feed)
 *   C. play() when shouldPlay, pause() EAGERLY on any false transition
 *   D. pause() on unmount so a removed / backgrounded video releases audio
 *   E. an unmuted-play rejection replays MUTED + signals onPlayBlocked
 *   F. native appStateChange + web visibilitychange pause on background
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/lib/explore/useReelAutoPlay.ts'),
  'utf-8',
)

describe('useReelAutoPlay invariants (single-authority)', () => {
  it('derives shouldPlay from feed authority + carousel + pause state', () => {
    expect(source).toContain(
      'enabled && active && feedVisible && showingVideo && !paused',
    )
  })

  it('does NOT run a per-card IntersectionObserver (the feed is the authority)', () => {
    expect(source).not.toContain('new IntersectionObserver')
  })

  it('plays when shouldPlay and pauses eagerly otherwise', () => {
    expect(source).toContain('if (shouldPlay) {')
    expect(source).toContain('video.play()')
    expect(source).toContain('video.pause()')
  })

  it('pauses video on unmount so audio focus is released', () => {
    const cleanupBlock = source.slice(source.indexOf('return () => {'))
    expect(cleanupBlock).toContain('video.pause()')
  })

  it('replays muted on an unmuted-play rejection and signals onPlayBlocked', () => {
    expect(source).toContain('video.muted = true')
    expect(source).toContain('onPlayBlockedRef.current?.()')
  })

  it('pauses on native app background (appStateChange) and web visibilitychange', () => {
    expect(source).toContain("'appStateChange'")
    expect(source).toContain('visibilitychange')
  })

  it('sub-effects bail out when enabled is false', () => {
    expect(source).toContain('if (!enabled) return')
  })
})
