/**
 * PortfolioLightbox (M2.1) — Source-Contract
 *
 * Freezes the fullscreen TikTok-style player so future changes can't silently:
 *  - drop the playback-compat banner branch
 *  - lose keyboard / swipe navigation
 *  - re-introduce a `<video>` element without `controls` (the M2.1 promise)
 *  - leak edit-flows into the public lightbox
 *
 * The wire-up contract (Lightbox is mounted from the public explore profile
 * and receives `onSelect` from both grids) lives in
 * `exploreProfilePublicContract.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/components/explore/PortfolioLightbox.tsx'),
  'utf-8',
)

// ─── A. Module shape ─────────────────────────────────────────────────────────

describe('PortfolioLightbox: module shape', () => {
  it('default-exports the component', () => {
    expect(source).toMatch(/export default function PortfolioLightbox/)
  })

  it('imports the playback compat helper', () => {
    expect(source).toContain("from '../../lib/media/playbackCompat'")
    expect(source).toContain('getPlaybackBlockReason')
  })

  it('uses the canonical PortfolioItem type', () => {
    expect(source).toContain("from '../../lib/providerMedia'")
    expect(source).toContain('PortfolioItem')
  })
})

// ─── B. Modal contract ───────────────────────────────────────────────────────

describe('PortfolioLightbox: modal contract', () => {
  it('renders a fullscreen fixed-inset overlay', () => {
    expect(source).toContain('fixed inset-0')
  })

  it('uses dialog role + aria-modal=true', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
  })

  it('returns null when closed or empty', () => {
    expect(source).toMatch(/if\s*\(!open\s*\|\|\s*total === 0\)\s*return null/)
  })
})

// ─── C. Playback contract ────────────────────────────────────────────────────

describe('PortfolioLightbox: playback contract', () => {
  it('renders <video> with controls + autoPlay + loop + playsInline', () => {
    expect(source).toMatch(/<video[\s\S]*controls[\s\S]*\/>/)
    expect(source).toContain('autoPlay')
    expect(source).toContain('loop')
    expect(source).toContain('playsInline')
  })

  it('passes posterUrl to the video element so the cover survives codec failure', () => {
    expect(source).toContain('item.posterUrl')
    expect(source).toContain('poster=')
  })

  it('renders a CompatBanner branch when blockReason is non-null', () => {
    expect(source).toContain('CompatBanner')
    expect(source).toContain('blockReason')
  })

  it('CompatBanner uses the structured reason message (not a hard-coded string)', () => {
    expect(source).toContain('blockReason.message')
  })
})

// ─── D. Navigation contract ──────────────────────────────────────────────────

describe('PortfolioLightbox: navigation contract', () => {
  it('listens to keydown for Escape, ArrowUp, ArrowDown', () => {
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toMatch(/event\.key === 'ArrowDown'/)
    expect(source).toMatch(/event\.key === 'ArrowUp'/)
  })

  it('removes the keydown listener on unmount/close', () => {
    expect(source).toContain("removeEventListener('keydown'")
  })

  it('declares touch handlers on the modal root', () => {
    expect(source).toContain('onTouchStart')
    expect(source).toContain('onTouchEnd')
  })

  it('uses a swipe threshold (not hair-trigger)', () => {
    expect(source).toMatch(/SWIPE_THRESHOLD\s*=\s*\d{2,3}/)
  })

  it('locks body scroll while open', () => {
    expect(source).toContain("document.body.style.overflow = 'hidden'")
  })
})

// ─── E. No edit flows (M2.2 like button is a NEW write — see F.) ─────────────

describe('PortfolioLightbox: no edit flows', () => {
  it('does not import or render the editor composer', () => {
    expect(source).not.toContain('PortfolioItemComposer')
    expect(source).not.toContain('AddWorkSampleSheet')
    expect(source).not.toContain('JobPickerForPortfolio')
    expect(source).not.toContain('ItemActionSheet')
  })

  it('does not call any provider_media delete / update path', () => {
    expect(source).not.toContain('deletePortfolioItem')
    expect(source).not.toContain('updatePortfolioItem')
    expect(source).not.toContain("from('provider_media')")
  })

  it('does not import supabase directly (writes go through useLikeStatus)', () => {
    expect(source).not.toContain("from '../../lib/supabase'")
  })
})

// ─── F. Like button (M2.2) ───────────────────────────────────────────────────

describe('PortfolioLightbox: like button wire-up (M2.2)', () => {
  it('uses the useLikeStatus hook (single source of truth)', () => {
    expect(source).toContain("from '../../lib/providerMedia/useLikeStatus'")
    expect(source).toContain('useLikeStatus(item?.id ?? null)')
  })

  it('renders an aria-pressed Heart button bound to likeStatus.toggle', () => {
    expect(source).toContain('aria-pressed={likeStatus.isLiked}')
    expect(source).toContain('likeStatus.toggle()')
  })

  it('disables the button while the toggle is in flight', () => {
    expect(source).toContain('disabled={likeStatus.pending}')
  })

  it('paints the heart filled red when liked', () => {
    expect(source).toContain('fill-red-500')
    expect(source).toContain('stroke-red-500')
  })

  it('keeps the seed likeCount as a fallback while the hook hydrates', () => {
    expect(source).toContain('seedLikeCount')
    expect(source).toContain('liveLikeCount')
  })

  it('surfaces likeStatus.error inline with role="alert"', () => {
    expect(source).toContain('likeStatus.error')
    expect(source).toContain('role="alert"')
  })
})

// ─── G. Comments wire-up (M2.3) ──────────────────────────────────────────────

describe('PortfolioLightbox: comments wire-up (M2.3)', () => {
  it('mounts useComments at the lightbox level so the count chip stays fresh', () => {
    expect(source).toContain('useComments(item?.id ?? null)')
  })

  it('renders the MessageCircle button driving setCommentsOpen', () => {
    expect(source).toContain('MessageCircle')
    expect(source).toContain('setCommentsOpen(true)')
  })

  it('renders the PortfolioCommentsPanel below the lightbox', () => {
    expect(source).toContain('PortfolioCommentsPanel')
    expect(source).toContain('setCommentsOpen(false)')
  })

  it('forwards currentUserId + providerOwnerUserId to the comments panel', () => {
    expect(source).toContain('currentUserId={currentUserId}')
    expect(source).toContain('providerOwnerUserId={providerOwnerUserId}')
  })
})

// ─── H. Share button (M2.4) — removed in Issue-10 fix ───────────────────────
// Share button was removed from PortfolioLightbox (Issue 10: Share-Button aus
// Lightbox und Profil-Header entfernt). Tests removed accordingly.

// ─── I. Block 0 source-selection ─────────────────────────────────────────────

describe('PortfolioLightbox: H.264 fallback source-selection (Block 0)', () => {
  it('imports + uses selectVideoSource for the video src', () => {
    expect(source).toContain('selectVideoSource')
    expect(source).toMatch(/src=\{selectVideoSource\(item\) \?\? undefined\}/)
  })
})

// ─── J. Rules of Hooks compliance (review fix) ──────────────────────────────

describe('PortfolioLightbox: hook order is stable across open/close transitions', () => {
  // The lightbox calls useLikeStatus + useComments. Both must be invoked on
  // every render — including the closed render that returns null. The fix
  // is to derive `item` to a nullable AND call the hooks with that nullable
  // id BEFORE the early returns. Hooks themselves are null-tolerant.
  it('useLikeStatus is called before any conditional return', () => {
    const useLikePos = source.indexOf('useLikeStatus(item?.id ?? null)')
    const earlyReturnPos = source.indexOf('if (!open || total === 0) return null')
    expect(useLikePos).toBeGreaterThan(-1)
    expect(earlyReturnPos).toBeGreaterThan(-1)
    expect(useLikePos).toBeLessThan(earlyReturnPos)
  })

  it('useComments is called before any conditional return', () => {
    const useCommentsPos = source.indexOf('useComments(item?.id ?? null)')
    const earlyReturnPos = source.indexOf('if (!open || total === 0) return null')
    expect(useCommentsPos).toBeGreaterThan(-1)
    expect(earlyReturnPos).toBeGreaterThan(-1)
    expect(useCommentsPos).toBeLessThan(earlyReturnPos)
  })

  it('item is derived to a nullable (open && total > 0 ? items[idx] : null)', () => {
    expect(source).toMatch(/const item = open && total > 0 \? items\[currentIndex\] \?\? null : null/)
  })
})

// ─── K. Comments-panel ownership when open (review fix) ─────────────────────

describe('PortfolioLightbox: yields keyboard + touch to comments panel when open', () => {
  it('keyboard handler skips events while commentsOpen or folderSheetOpen', () => {
    const kbHandlerStart = source.indexOf('// Keyboard navigation')
    const kbHandlerEnd = source.indexOf('document.addEventListener(\'keydown\'', kbHandlerStart)
    const kbBlock = source.slice(kbHandlerStart, kbHandlerEnd)
    // Both overlays self-close on Escape, so the lightbox must yield to either.
    expect(kbBlock).toContain('if (commentsOpen || folderSheetOpen) return')
  })

  it('keyboard effect depends on commentsOpen + folderSheetOpen so the handler rebinds when state flips', () => {
    expect(source).toMatch(/\}, \[open, commentsOpen, folderSheetOpen, onClose, goPrev, goNext\]\)/)
  })

  it('onTouchStart returns early when commentsOpen or folderSheetOpen so sheet scrolls do not arm a swipe', () => {
    const startSig = source.indexOf('const onTouchStart = useCallback(')
    expect(startSig).toBeGreaterThan(-1)
    const block = source.slice(startSig, source.indexOf('[commentsOpen, folderSheetOpen]', startSig) + 40)
    expect(block).toContain('if (commentsOpen || folderSheetOpen) return')
  })

  it('onTouchEnd returns early when commentsOpen or folderSheetOpen so sheet scrolls do not commit a swipe', () => {
    const endSig = source.indexOf('const onTouchEnd = useCallback(')
    expect(endSig).toBeGreaterThan(-1)
    // Slice generously past the closing dep array — the body is ~20 lines.
    const block = source.slice(endSig, endSig + 1400)
    // Batch-2 hardening: the folder sheet bleeding a swipe into reel-nav could
    // save the wrong reel, so both touch handlers also bail on folderSheetOpen.
    expect(block).toContain('if (commentsOpen || folderSheetOpen) return')
    // M2: deps extended with items + currentIndex for within-post asset navigation.
    expect(block).toMatch(/\[commentsOpen, folderSheetOpen, goPrev, goNext(?:, items, currentIndex)?\]/)
  })
})

// ─── L. Like count uses hydrated flag (review fix) ──────────────────────────

describe('PortfolioLightbox: liveLikeCount no longer hides genuine 0 likes behind seed', () => {
  it('uses likeStatus.hydrated to gate seed → live transition', () => {
    expect(source).toMatch(
      /const liveLikeCount = likeStatus\.hydrated \? likeStatus\.likeCount : seedLikeCount/,
    )
  })
})
