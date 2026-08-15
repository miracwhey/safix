/**
 * ExploreReelCard — M3.1 Item-Feed Contract
 *
 * Freezes the M3.1 render-branch + like-anchor migration so the Reels feed
 * cannot silently regress to the legacy provider-feed shape.
 *
 * Frozen invariants:
 *   A. Like anchor reads `mediaId` first, falls back to `featuredMediaId`
 *   B. Video render branch uses `<video>` with `selectVideoSource()`
 *   C. Image / legacy branch keeps the existing `<img src=thumbnailUrl>`
 *   D. Video element sets muted + playsInline (iOS autoplay requirement)
 *   E. useReelAutoPlay is wired to the ref, gated by mediaType==='video'
 *   F. controlsList limits the platform UI to safe affordances only
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/components/explore/ExploreReelCard.tsx'),
  'utf-8',
)

describe('ExploreReelCard: like-anchor migration', () => {
  it('reads mediaId before featuredMediaId (M3.1 first-class)', () => {
    expect(source).toContain('reel.mediaId ?? reel.featuredMediaId')
  })

  it('does not pin the like target on featuredMediaId alone', () => {
    expect(source).not.toMatch(/!!\s*reel\.featuredMediaId/)
  })
})

describe('ExploreReelCard: video render branch', () => {
  it('imports selectVideoSource for the codec fallback decision', () => {
    expect(source).toContain("from '../../lib/media/playbackCompat'")
    expect(source).toContain('selectVideoSource')
  })

  it('imports useReelAutoPlay', () => {
    expect(source).toContain("from '../../lib/explore/useReelAutoPlay'")
  })

  it('renders a <video> with src + a REAL poster only when mediaType is video', () => {
    expect(source).toMatch(/<video[\s\S]*?src=\{videoSrc\}/)
    // B2.3: poster must be a real image or undefined — never reel.thumbnailUrl,
    // which for a video collapses to the video URL and breaks the <img> poster.
    expect(source).toMatch(/poster=\{reel\.posterUrl\s*\?\?\s*undefined\}/)
    expect(source).not.toMatch(/poster=\{reel\.posterUrl\s*\?\?\s*reel\.thumbnailUrl/)
  })

  it('marks the video muted + playsInline for iOS autoplay compliance', () => {
    expect(source).toMatch(/<video[\s\S]*?muted[\s\S]*?playsInline/)
  })

  it('sets controlsList to limit platform UI to safe affordances', () => {
    expect(source).toContain('controlsList="nodownload nofullscreen noremoteplayback"')
  })

  it('loops the video so the reel cycles while the user lingers', () => {
    expect(source).toMatch(/<video[\s\S]*?\sloop\b/)
  })
})

describe('ExploreReelCard: legacy image / cover branch', () => {
  it('keeps <img src=thumbnailUrl> for image reels and the legacy provider-feed shape', () => {
    expect(source).toContain('src={reel.thumbnailUrl}')
  })

  it('uses isItemReel + isVideo to decide the render branch (not just thumbnailUrl)', () => {
    expect(source).toContain('isItemReel && isVideo && videoSrc')
  })
})

describe('ExploreReelCard: autoplay wiring', () => {
  it('passes enabled = isItemReel && isVideo to useReelAutoPlay', () => {
    expect(source).toMatch(/useReelAutoPlay\(\{[\s\S]*?enabled:\s*isItemReel\s*&&\s*isVideo/)
  })

  it('passes the user-pause override so tap-pause is honored across IntersectionObserver firings', () => {
    expect(source).toMatch(/useReelAutoPlay\(\{[\s\S]*?paused:\s*userPaused/)
  })
})

describe('ExploreReelCard: engagement surfaces (PR-C)', () => {
  it('imports the save hook so save state lives in a per-mediaId Realtime channel', () => {
    expect(source).toContain("from '../../lib/providerMedia/useSaveStatus'")
    expect(source).toContain('useSaveStatus')
  })

  it('save button short-tap toggles the save via a real onClick (B4.3)', () => {
    // B4.3: tap-to-save runs through the button's own onClick — NOT a custom
    // touch onTap, which the scroll-snap feed dropped on touchcancel mid-scroll
    // (the reason saving "didn't work"). useLongPress runs in clickDrivenTap
    // mode and only adds the long-press → folder-sheet affordance.
    expect(source).toMatch(/\{\.\.\.saveHandlers\}/)
    expect(source).toMatch(/onClick=\{handleSaveTap\}/)
    expect(source).toMatch(/useLongPress\([\s\S]*?clickDrivenTap:\s*true/)
    expect(source).not.toMatch(/useLongPress\([\s\S]*?onTap:\s*handleSaveTap/)
    expect(source).toMatch(/function handleSaveTap\(\)\s*\{[\s\S]*?save\.toggle\(\)/)
  })

  it('save button long-press opens the SaveToFolderSheet for folder assignment', () => {
    expect(source).toContain("import SaveToFolderSheet from '../savedReels/SaveToFolderSheet'")
    expect(source).toMatch(/useLongPress\([\s\S]*?onLongPress:\s*handleSaveLongPress/)
    expect(source).toMatch(/function handleSaveLongPress\(\)\s*\{[\s\S]*?setFolderSheetOpen\(true\)/)
  })

  it('save button surface uses the hook count, not the seeded reel.saves', () => {
    // Pre-PR-D rendered `save.saveCount` directly; PR-D pipes it through
    // formatCount() for the Insta-/TikTok-style "1.2K"/"1.2M" surface.
    expect(source).toMatch(/save\.saveCount\s*>\s*0\s*\?\s*formatCount\(save\.saveCount\)/)
  })

  it('like and save counts go through formatCount for compact rendering (PR-D)', () => {
    expect(source).toContain("from '../../lib/format/formatCount'")
    // Block 3 migrated the card to `useLikeStatus` — the compact-render
    // surface reads from `liveLikeCount` (the hydrated hook value with
    // a seed fallback), but it's still piped through formatCount.
    expect(source).toMatch(/formatCount\(liveLikeCount\)/)
    expect(source).toMatch(/formatCount\(save\.saveCount\)/)
  })

  it('renders PortfolioCommentsPanel for the reel mediaId', () => {
    expect(source).toContain("import PortfolioCommentsPanel from './PortfolioCommentsPanel'")
    expect(source).toMatch(/<PortfolioCommentsPanel[\s\S]*?mediaId=\{likeAnchorId/)
  })

  it('a comment button toggles the comments sheet open', () => {
    expect(source).toMatch(/setCommentsOpen\(true\)/)
  })

  it('renders a Share button that shares via a public web origin (B3.5, was deferred to M2.4)', () => {
    expect(source).toContain('Share2')
    expect(source).toContain('handleShare')
    // Must build the link from getPublicWebOrigin() — window.location.origin is
    // capacitor://localhost in the native shell and would be unopenable.
    expect(source).toContain('getPublicWebOrigin()')
  })

  it('handles tap-to-pause via userPaused state (single-tap path) and double-tap-likes (Block 3)', () => {
    expect(source).toMatch(/userPaused/)
    expect(source).toMatch(/handleVideoTap/)
    // Block 3 hardening: the single-tap fires INSTANTLY (immediateSingle) so
    // pause/play feels responsive and rapid taps don't degrade into likes. The
    // tap-handlers spread onto the <video> include the immediate single-tap
    // (handleVideoTap) and the double-tap-like (handleVideoDoubleTap).
    expect(source).toMatch(/useDoubleTap\(\s*\{[\s\S]*?onSingleTap:[\s\S]*?onDoubleTap:[\s\S]*?\}/)
    expect(source).toMatch(/immediateSingle:\s*true/)
    expect(source).toMatch(/\{\.\.\.videoTapHandlers\}/)
  })

  it('double-tap reverts the instant single-tap pause toggle before liking (no playback change on a like)', () => {
    // immediateSingle already toggled userPaused on the first tap; onDoubleTap
    // must flip it back so a like never pauses/resumes the video.
    expect(source).toMatch(/onDoubleTap:[\s\S]*?setUserPaused\(\(prev\)\s*=>\s*!prev\)[\s\S]*?handleVideoDoubleTap/)
  })

  it('renders a large Heart-Burst overlay on double-tap (Insta-Convention)', () => {
    expect(source).toContain('animate-heart-burst')
    expect(source).toContain('likeBurst')
  })

  it('renders a centered Pause indicator gated on the delayed showPauseGlyph', () => {
    // Batch-2 hardening: the glyph is gated on showPauseGlyph (a delayed mirror
    // of userPaused) instead of userPaused directly, so a double-tap-like — which
    // toggles+reverts pause within the window — never flashes the Pause icon.
    expect(source).toMatch(/showPauseGlyph\s*\?[\s\S]*?<Pause/)
    expect(source).toContain('setShowPauseGlyph(true)')
  })

  it('pause overlay is pointer-events-none so the resume tap reaches the video', () => {
    expect(source).toMatch(/<Pause[\s\S]*?\/>|pointer-events-none[\s\S]*?Pause/)
  })

  it('renders the description as a separate paragraph distinct from title', () => {
    expect(source).toMatch(/reel\.description/)
    expect(source).toMatch(/descriptionExpanded/)
  })

  it('description offers a "mehr"-Expand toggle when long', () => {
    expect(source).toContain("'mehr'")
    expect(source).toContain("'weniger'")
  })

  it('removes the white step-bar placeholder at the top of the card', () => {
    // The pre-PR-C card rendered a 2px white bar as a multi-item-carousel
    // stub. PR-C drops it; the contract pins the absence so a future
    // refactor cannot re-introduce it without touching this assertion.
    expect(source).not.toMatch(/h-\[2px\][^"]*bg-white\/95/)
  })
})

describe('ExploreReelCard: role-aware CTA gate (PR-B)', () => {
  it('accepts a viewerRole prop driven by AppContext', () => {
    expect(source).toMatch(/viewerRole:\s*AppContext/)
  })

  it('derives canInquire = viewerRole === customer', () => {
    expect(source).toMatch(/canInquire\s*=\s*viewerRole\s*===\s*['"]customer['"]/)
  })

  it('only renders the "Projekt anfragen" CTA when canInquire is true', () => {
    // The CTA block must be inside a `{canInquire ? (...) : null}` branch.
    expect(source).toMatch(/canInquire\s*\?\s*\([\s\S]*?Projekt anfragen[\s\S]*?\)\s*:\s*null/)
  })

  it('guards handleInquiry with !canInquire as defense-in-depth', () => {
    expect(source).toMatch(/if\s*\(!canInquire\)\s*return/)
  })
})

describe('ExploreReelCard: M3 multi-asset carousel', () => {
  it('derives multiAsset from reel.assets.length > 1', () => {
    expect(source).toMatch(/reel\.assets.*length.*>\s*1|totalAssets\s*>\s*1/)
  })

  it('maintains assetIndex state and resets on reel.id change', () => {
    expect(source).toContain('assetIndex')
    expect(source).toContain('setAssetIndex(0)')
  })

  it('renders non-cover asset as <img> (no second autoplay video)', () => {
    expect(source).toMatch(/assetIndex\s*>\s*0/)
    expect(source).toMatch(/currentAsset\.publicUrl/)
  })

  it('shows dot indicators when multiAsset', () => {
    expect(source).toContain('multiAsset')
    // reelAssets is the stable alias for reel.assets ?? []
    expect(source).toMatch(/multiAsset[\s\S]*?reelAssets\.map/)
  })

  it('renders invisible tap zones for prev/next asset navigation', () => {
    expect(source).toMatch(/Vorheriges Bild/)
    expect(source).toMatch(/Nächstes Bild/)
    expect(source).toMatch(/setAssetIndex.*Math\.max|setAssetIndex.*Math\.min/)
  })
})
