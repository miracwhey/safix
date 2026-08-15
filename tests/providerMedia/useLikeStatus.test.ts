/**
 * useLikeStatus — Source-Contract
 *
 * Locks the M2.2 like-state hook so the lightbox keeps:
 *  - per-mediaId Realtime channel (INSERT + DELETE) with cleanup
 *  - generation-guarded fetches that survive a fast swipe through reels
 *  - optimistic toggle with rollback on error
 *  - a German auth-message for unauthenticated users
 *
 * Pure source-string assertions (the repo's house pattern) — running the
 * hook would require @testing-library/react which is not in the test
 * environment.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/lib/providerMedia/useLikeStatus.ts'),
  'utf-8',
)

describe('useLikeStatus: hook shape', () => {
  it('exports the hook', () => {
    expect(source).toMatch(/export function useLikeStatus\(/)
  })

  it('exports the result type', () => {
    expect(source).toMatch(/export type UseLikeStatusResult/)
  })

  it('result includes a hydrated flag (review fix — distinguishes "loading" from "really 0 likes")', () => {
    expect(source).toMatch(/hydrated: boolean/)
  })

  it('INITIAL state has hydrated=false', () => {
    expect(source).toMatch(/const INITIAL: State = \{[\s\S]*hydrated: false[\s\S]*\}/)
  })

  it('applyStatus sets hydrated=true after the canonical fetch resolves', () => {
    const applyFn = source.slice(source.indexOf('function applyStatus'))
    expect(applyFn).toContain('hydrated: true')
  })

  it('imports the existing service helpers (no duplicate fetch logic)', () => {
    expect(source).toContain('fetchLikeStatus')
    expect(source).toContain('toggleLike')
    expect(source).toContain("from './portfolioLikeService'")
  })

  it('returns a no-op shape when mediaId is null/undefined', () => {
    expect(source).toMatch(/if \(!mediaId\)/)
  })
})

describe('useLikeStatus: Realtime contract', () => {
  it('opens a channel scoped to the media id', () => {
    // Method-chained across lines in the implementation; match just the
    // channel-name template so the assertion survives formatter changes.
    expect(source).toMatch(/\.channel\(`portfolio-likes-\$\{mediaId\}`\)/)
  })

  it('subscribes to INSERT events on provider_media_likes filtered by media_id', () => {
    expect(source).toContain("event: 'INSERT'")
    expect(source).toContain("table: 'provider_media_likes'")
    expect(source).toMatch(/filter: `media_id=eq\.\$\{mediaId\}`/)
  })

  it('subscribes to DELETE events on the same scope', () => {
    expect(source).toContain("event: 'DELETE'")
  })

  it('removes the channel on unmount / id change', () => {
    expect(source).toContain('supabase.removeChannel(channel)')
  })
})

describe('useLikeStatus: generation guarding + cancellation', () => {
  it('uses a generation counter to drop stale fetches', () => {
    expect(source).toContain('generationRef')
    expect(source).toMatch(/generation\s*!==\s*generationRef\.current/)
  })

  it('uses a cancelled flag for the in-flight refresh', () => {
    expect(source).toMatch(/let cancelled = false/)
    expect(source).toContain('cancelled = true')
  })

  it('tracks the current mediaId via ref so toggle() ignores stale results', () => {
    expect(source).toContain('currentMediaIdRef')
    expect(source).toMatch(/currentMediaIdRef\.current\s*!==\s*id/)
  })
})

describe('useLikeStatus: optimistic toggle', () => {
  it('short-circuits double-taps via the pending guard', () => {
    expect(source).toMatch(/if \(prev\.pending\) return/)
  })

  it('clamps the optimistic decrement at zero', () => {
    expect(source).toContain('Math.max(0, prev.likeCount - 1)')
  })

  it('reads the pre-toggle snapshot from a commit-synced ref, NOT a setState updater (eager-state write-drop fix)', () => {
    // The old "snapshot = prev inside setState(updater)" pattern relied on
    // React's eager-state bailout running the updater synchronously; that is
    // skipped once another setState (the caller's pop-key bump) has queued work
    // on the fiber, so toggleLike() never ran and likes/unlikes never persisted.
    expect(source).not.toMatch(/snapshot = prev/)
    expect(source).toContain('stateRef')
    expect(source).toMatch(/const prev = stateRef\.current/)
  })

  it('rolls back to the captured pre-toggle values on failure', () => {
    // The hook stores the snapshot in `snapshot` and restores via `fallback`
    // (a const re-bind so TypeScript narrows the null-check). Both names
    // are acceptable; what matters is the rollback path uses the captured
    // values, not the post-optimistic state.
    const snapshotRef = /(?:snapshot|fallback)\.likeCount/
    const isLikedRef = /(?:snapshot|fallback)\.isLiked/
    expect(source).toMatch(snapshotRef)
    expect(source).toMatch(isLikedRef)
  })

  it('uses German error messages including the auth-required case', () => {
    expect(source).toContain("Bitte logge dich ein, um Reels zu liken.")
    expect(source).toContain("'NOT_AUTHENTICATED'")
    expect(source).toContain("'Like konnte nicht gespeichert werden.'")
  })
})
