import { memo, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Heart,
  Bookmark,
  MessageCircle,
  BadgeCheck,
  Flag,
  Pause,
  Share2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { getPublicWebOrigin } from '../../lib/platform'
import { useAudioSession } from '../../lib/explore/useAudioSession'
import type { ExploreReel } from '../../lib/explore/exploreTypes'
import { startReelInquiryWorkflow } from '../../lib/workflow'
import { inquiryErrorMessage } from '../../lib/explore/inquiryErrorMessage'
import type { AppContext } from '../../lib/access'
import { deriveProviderTrustProjection } from '../../lib/trust'
import {
  getRatingsByProviderUserId,
  deriveProviderReputation,
  formatAverageRating,
  subscribeRatings,
} from '../../lib/ratings'
import { useStoreSync } from '../../lib/reactive'
import { useLikeStatus } from '../../lib/providerMedia/useLikeStatus'
import { useSaveStatus } from '../../lib/providerMedia/useSaveStatus'
import { formatCount } from '../../lib/format/formatCount'
import { formatResponseLatencyLabel } from '../../lib/messages/responseLatencySelector'
import { supabase } from '../../lib/supabase'
import { selectVideoSource } from '../../lib/media/playbackCompat'
import { useReelAutoPlay } from '../../lib/explore/useReelAutoPlay'
import { useInViewport } from '../../hooks/useInViewport'
import PortfolioCommentsPanel from './PortfolioCommentsPanel'
import Spinner from '../system/Spinner'
import SaveToFolderSheet from '../savedReels/SaveToFolderSheet'
import ReportUserSheet from '../moderation/ReportUserSheet'
import { useLongPress } from '../../lib/ui/useLongPress'
import { useDoubleTap } from '../../lib/ui/useDoubleTap'
import { useToast } from '../../hooks/useToast'
import { useHaptics } from '../../hooks/useHaptics'

type Props = {
  reel: ExploreReel
  /**
   * Viewer's resolved role / app context. Drives role-aware UI surfaces:
   *   - 'customer' → "Projekt anfragen" CTA visible, inquiry workflow allowed.
   *   - 'owner'    → CTA hidden; craftsmen browse the feed for inspiration but
   *                  cannot inquire on other craftsmen's reels.
   *   - 'employee' → unreachable here (ExploreFeed early-returns for employees).
   *   - 'unknown'  → unreachable here (ExploreFeed early-returns).
   *
   * Required prop — there is no safe default. The defense-in-depth guard in
   * `handleInquiry` re-checks before invoking the workflow.
   *
   * Named `viewerRole` (not `viewerContext`) so the AppContext role surface
   * does not collide with the for-you ranker's `ViewerContext` type — they
   * carry different concepts (role vs personalization signals).
   */
  viewerRole: AppContext
  /**
   * `<video preload>` strategy, decided by the feed: 'auto' for the active reel
   * and its forward neighbor (instant swipe), 'metadata' otherwise. Defaults to
   * 'metadata' so non-feed callers stay conservative.
   */
  videoPreload?: 'auto' | 'metadata'
  /**
   * This card is the feed's currently-active reel. The single playback
   * authority — only the active reel plays; everything else pauses eagerly.
   * Defaults true so non-feed callers (e.g. a standalone preview) still play.
   */
  active?: boolean
  /**
   * The reels feed is the foreground surface (route active + search closed).
   * False → the video pauses even though the card stays mounted (PersistentTabs
   * keeps tabs mounted via display:none). Defaults true.
   */
  feedVisible?: boolean
  /**
   * Notifies the feed when ANY of this card's full-screen reel overlays —
   * comments, save-to-folder, or report — opens / closes, so the feed can hide
   * its top tab pills while a sheet is up (TikTok parity — no chrome peeking
   * above the sheet; all three portal to <body> with a top-reaching backdrop and
   * the pills are iOS-fixed-trapped, so a higher z-index alone does not rescue
   * them). Keyed by `reel.id` so the feed tracks a SET of open cards: with up to
   * 3 cards mounted in the virtualization window, a neighbor (re)mounting /
   * unmounting (e.g. on a realtime/visibility refetch) must not stomp the flag
   * the active card set. Optional: standalone callers (lightbox, preview) omit it.
   */
  onOverlayOpenChange?: (reelId: string, open: boolean) => void
}

// Above this character count we offer the "mehr"-Expand toggle even when
// the line-clamp wouldn't visibly cut anything yet. Mirrors Insta's
// description-expand heuristic: short captions stay always-open, longer
// ones get the affordance. The collapsed line count is encoded in the
// `line-clamp-2` Tailwind class directly — Tailwind's content scanner
// doesn't pick up dynamic class names like `line-clamp-${N}`, so we keep
// the literal class and document the line count here.
const DESCRIPTION_EXPAND_THRESHOLD = 80

function ExploreReelCard({
  reel,
  viewerRole,
  videoPreload = 'metadata',
  active = true,
  feedVisible = true,
  onOverlayOpenChange,
}: Props) {
  const navigate = useNavigate()
  const canInquire = viewerRole === 'customer'

  // M3.1: like anchor migrated from `featuredMediaId` (legacy provider-feed)
  // to `mediaId` (item-feed). Both forms are accepted during transition;
  // remove the fallback once all read sites emit `mediaId`.
  const likeAnchorId = reel.mediaId ?? reel.featuredMediaId

  // M3.1: render branch on item-feed media. When mediaType is absent we
  // fall back to the pre-M3.1 cover render (legacy provider-feed shape).
  const isItemReel = !!reel.mediaType
  const isVideo = reel.mediaType === 'video'

  // ── Tap-to-pause state (PR-C) ─────────────────────────────────────────
  // The viewer can tap the video to pause it. The autoplay hook honors this
  // override so the IntersectionObserver does not race with the tap.
  const [userPaused, setUserPaused] = useState(false)
  // Reset the pause when the reel changes (swipe to next card) AND whenever this
  // card becomes the active reel — otherwise, with the virtualization window
  // keeping the card mounted, a reel paused then scrolled past would stay frozen
  // on its poster when scrolled back to (TikTok/Insta resume on return).
  useEffect(() => {
    if (active) setUserPaused(false)
  }, [reel.id, active])

  // Pause GLYPH visibility is delayed past the double-tap window. A double-tap-
  // like toggles pause on its first tap (immediateSingle) and reverts it on the
  // second ~150ms later; gating the centered Pause icon on `userPaused` directly
  // flashed that glyph on every like. The video itself still pauses/resumes
  // instantly (that frame change IS the feedback for a genuine pause) — only the
  // confirmation glyph waits out the window, so a like never paints it while a
  // real single-tap pause still surfaces it ~350ms later. 350 > the 300ms
  // double-tap window so the revert always clears the timer first.
  const [showPauseGlyph, setShowPauseGlyph] = useState(false)
  useEffect(() => {
    if (!userPaused) {
      setShowPauseGlyph(false)
      return
    }
    const t = window.setTimeout(() => setShowPauseGlyph(true), 350)
    return () => window.clearTimeout(t)
  }, [userPaused])

  // ── M3: within-post asset carousel ────────────────────────────────────
  const reelAssets = reel.assets ?? []
  const totalAssets = reelAssets.length
  const multiAsset = totalAssets > 1
  const [assetIndex, setAssetIndex] = useState(0)
  useEffect(() => { setAssetIndex(0) }, [reel.id])

  // ── Swipe gesture for multi-asset navigation ───────────────────────────
  // touchStartRef tracks the initial touch position. swipeDetectedRef is set
  // when a qualifying horizontal swipe is consumed so the deferred video
  // single-tap handler can bail out and not toggle pause mid-swipe.
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const swipeDetectedRef = useRef(false)
  const currentAsset = multiAsset
    ? (reelAssets[Math.min(assetIndex, totalAssets - 1)] ?? null)
    : null

  const { unmuted, toggle: toggleMute, mute } = useAudioSession()

  // Playback is feed-authoritative: only the active reel, while the feed is the
  // foreground surface and the video (not a carousel photo) is showing, plays.
  // enabled=false (image reels) skips it entirely.
  const videoRef = useReelAutoPlay({
    enabled: isItemReel && isVideo,
    active,
    feedVisible,
    showingVideo: assetIndex === 0,
    paused: userPaused,
    // Unmuted autoplay rejected → the hook already replayed muted; sync global
    // mute state so the button reflects reality. mute() is idempotent.
    onPlayBlocked: mute,
  })

  // Show a spinner while the video is waiting on network data. Cleared on
  // playing, pause, or reel change. Only meaningful when the video is active
  // (not user-paused) — the pause indicator takes precedence.
  const [isBuffering, setIsBuffering] = useState(false)
  useEffect(() => {
    setIsBuffering(false)
  }, [reel.id])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onWaiting = () => setIsBuffering(true)
    const onPlaying = () => setIsBuffering(false)
    const onPause = () => setIsBuffering(false)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
    }
  }, [videoRef])

  const trust = deriveProviderTrustProjection({
    craftsmanUserId: reel.craftsmanId,
    completedJobsCount: reel.completedJobsCount,
    wouldHireAgainCount: reel.wouldHireAgainCount,
  })

  const [reputation, setReputation] = useState(() =>
    deriveProviderReputation(reel.craftsmanId, getRatingsByProviderUserId(reel.craftsmanId))
  )

  useStoreSync([subscribeRatings], () => {
    setReputation(
      deriveProviderReputation(reel.craftsmanId, getRatingsByProviderUserId(reel.craftsmanId))
    )
  })

  const [inquiryPending, setInquiryPending] = useState(false)
  const [inquiryError, setInquiryError] = useState<string | null>(null)

  // ── Viewport gating (perf) ────────────────────────────────────────────
  // Only the cards currently on screen hold a like/save Realtime channel and
  // fire status fetches. A populated feed scrolled across many pages would
  // otherwise accumulate 2 channels + 2 fetches per mounted card without bound.
  const [cardRef, inView] = useInViewport<HTMLDivElement>()

  // ── Like (Block 3) ──────────────────────────────────────────────────
  // Block 3 migriert die Card auf den `useLikeStatus`-Hook — gleiche
  // Quelle wie Lightbox + Cross-Device-Realtime. Vor Block 3 lebte
  // `handleLike` mit lokalem useState neben dem Hook im Lightbox; das
  // führte zu divergierenden Counters bei zwei offenen Surfaces.
  const like = useLikeStatus(likeAnchorId, inView)
  const seedLikeCount = reel.likeCount
  const liveLikeCount = like.hydrated ? like.likeCount : seedLikeCount
  const [likeBurst, setLikeBurst] = useState<{
    id: number
    x: number
    y: number
  } | null>(null)
  const [likePopKey, setLikePopKey] = useState(0)

  // ── Save (Bookmark) — PR-C ───────────────────────────────────────────
  // Twin of the like flow but lives in its own hook with its own per-item
  // Realtime channel. We render `saveCount` from the hook (authoritative)
  // and ignore the seeded `reel.saves` (always 0 from the feed mapper —
  // counter is computed live from `provider_media_saves`).
  const saveAnchorId = likeAnchorId ?? null
  const save = useSaveStatus(saveAnchorId, inView)
  const toast = useToast()
  const haptics = useHaptics()
  const [folderSheetOpen, setFolderSheetOpen] = useState(false)

  // ── Report (Apple 1.2 UGC moderation) ────────────────────────────────
  const [reportOpen, setReportOpen] = useState(false)

  // ── Comments — PR-C ──────────────────────────────────────────────────
  const [commentsOpen, setCommentsOpen] = useState(false)
  // Tell the feed to hide its top tab pills while ANY reel overlay is open
  // (comments, save-to-folder, or report — all portal to <body> over the
  // iOS-fixed-trapped pills), keyed by reel.id, and clear our own entry if the
  // card unmounts mid-open (virtualization). reel.id is stable per card instance
  // (the feed keys cards by it), so the cleanup runs only on real unmount.
  const anyOverlayOpen = commentsOpen || folderSheetOpen || reportOpen
  useEffect(() => {
    onOverlayOpenChange?.(reel.id, anyOverlayOpen)
  }, [reel.id, anyOverlayOpen, onOverlayOpenChange])
  useEffect(() => {
    return () => onOverlayOpenChange?.(reel.id, false)
  }, [reel.id, onOverlayOpenChange])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setCurrentUserId(data.session?.user?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Description expand (Insta-style) — PR-C ──────────────────────────
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const description = reel.description?.trim() ?? ''
  const hasDescription = description.length > 0
  const descriptionCanExpand =
    hasDescription && description.length > DESCRIPTION_EXPAND_THRESHOLD

  async function handleLike() {
    if (!likeAnchorId) return
    if (!currentUserId) {
      toast.info('Bitte logge dich ein, um zu liken.')
      return
    }
    // Haptic only on a fresh LIKE — un-like (toggle-off) stays silent.
    if (!like.isLiked) haptics.light()
    setLikePopKey((k) => k + 1)
    await like.toggle()
  }

  function handleVideoDoubleTap(event: { x: number; y: number }) {
    if (!likeAnchorId) return
    if (!currentUserId) {
      toast.info('Bitte logge dich ein, um zu liken.')
      return
    }
    haptics.medium()
    // Insta-Convention: Double-tap-Heart liked, never unlikes. Burst-
    // Overlay rendert in jedem Fall (visuelles Feedback für den Tap).
    if (!like.isLiked) {
      setLikePopKey((k) => k + 1)
      void like.toggle()
    }
    setLikeBurst({ id: Date.now(), x: event.x, y: event.y })
  }

  const videoTapHandlers = useDoubleTap(
    {
      onSingleTap: () => handleVideoTap(),
      onDoubleTap: (event) => {
        // immediateSingle already toggled pause on the first tap. A like must
        // never change playback, so flip the pause back, then like + burst.
        setUserPaused((prev) => !prev)
        handleVideoDoubleTap(event)
      },
    },
    // Instant pause/play (no 280ms defer); a second tap within the window still
    // routes to the double-tap-like above. Block 3 hardening.
    { windowMs: 300, immediateSingle: true },
  )

  const [bookmarkPopKey, setBookmarkPopKey] = useState(0)

  function handleSaveTap() {
    if (!saveAnchorId) return
    if (!currentUserId) {
      toast.info('Bitte logge dich ein, um Reels zu speichern.')
      return
    }
    setBookmarkPopKey((k) => k + 1)
    void save.toggle()
  }

  function handleSaveLongPress() {
    if (!saveAnchorId) return
    if (!currentUserId) {
      toast.info('Bitte logge dich ein, um Reels zu speichern.')
      return
    }
    setFolderSheetOpen(true)
  }

  // Tap-to-save runs through the button's own onClick (reliable, like the Like
  // button) — NOT through a custom touch onTap, which the scroll-snap feed drops
  // on touchcancel mid-scroll (the reason saving "didn't work"). useLongPress
  // here only adds the long-press → folder-sheet affordance (B4.3).
  const saveHandlers = useLongPress(
    { onLongPress: handleSaveLongPress },
    { thresholdMs: 380, clickDrivenTap: true },
  )

  async function handleInquiry() {
    // Defense-in-depth: the CTA is also hidden for non-customers, but a
    // misrouted call (e.g. via deep-link or developer console) must not
    // start an inquiry workflow.  The workflow itself enforces the same
    // contract server-side.
    if (!canInquire) return
    if (inquiryPending) return
    setInquiryPending(true)
    setInquiryError(null)
    try {
      const threadId = await startReelInquiryWorkflow(reel)
      navigate(`/messages/${threadId}`)
    } catch (err) {
      console.error('[ExploreReelCard] handleInquiry failed', err)
      // Gate the user-facing message: allowlisted user-friendly errors (e.g. the
      // daily-cap reason) pass through; RbacError / Supabase / Postgrest / generic
      // technical errors collapse to a clean fallback so nothing internal leaks.
      setInquiryError(inquiryErrorMessage(err))
    } finally {
      setInquiryPending(false)
    }
  }

  function handleProfileNavigate() {
    navigate(`/explore/craftsman/${reel.craftsmanId}`)
  }

  async function handleShare() {
    // Always a PUBLIC web origin — window.location.origin is capacitor://localhost
    // in the native shell and would produce an unopenable share link. Share the
    // craftsman PROFILE (resolves for any public provider) rather than ?reel=,
    // which only deep-links to reels already in the recipient's loaded feed page.
    const url = `${getPublicWebOrigin()}/explore/craftsman/${reel.craftsmanId}`
    try {
      const { Share } = await import('@capacitor/share')
      const { value: canShare } = await Share.canShare()
      if (canShare) {
        try {
          await Share.share({
            title: reel.title?.trim() || reel.craftsmanName,
            text: `${reel.craftsmanName} auf SaFix`,
            url,
            dialogTitle: 'Reel teilen',
          })
        } catch {
          // user canceled the native share sheet — nothing to do
        }
        return
      }
    } catch {
      // share plugin unavailable → fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link kopiert')
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  function handleVideoTap() {
    // Primary swipe filtering lives in useDoubleTap (a >10px move never fires a
    // tap), so a horizontal asset-swipe no longer toggles pause. This remains as
    // defense-in-depth: if a swipe flag is set, bail and reset it so an
    // interrupted touch sequence can't permanently block subsequent toggles.
    if (swipeDetectedRef.current) {
      swipeDetectedRef.current = false
      return
    }
    if (!isItemReel || !isVideo) return
    setUserPaused((prev) => !prev)
  }

  function handleCardTouchStart(e: React.TouchEvent) {
    // While a reel overlay (comments / folder sheet / report) is open its touches
    // bubble up the React tree to this host handler — a swipe on the sheet's
    // backdrop (which does not stopPropagation) would otherwise advance the asset
    // carousel behind the open sheet. Record nothing so no swipe is committed.
    if (anyOverlayOpen) return
    const t = e.touches[0]
    if (!t) return
    swipeDetectedRef.current = false
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }

  function handleCardTouchEnd(e: React.TouchEvent) {
    if (anyOverlayOpen) return
    if (!touchStartRef.current) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y
    const dt = Date.now() - touchStartRef.current.t
    touchStartRef.current = null

    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)

    // Not a qualifying horizontal swipe — let the document tab-switch handler through.
    if (dt > 400 || absDx < 50 || absDx < absDy * 1.5) return

    // Always consume qualifying horizontal swipes to prevent tab navigation,
    // regardless of asset count. Asset change only applies to multi-asset reels.
    swipeDetectedRef.current = true
    e.nativeEvent.stopPropagation()

    if (!multiAsset) return

    if (dx < 0) {
      setAssetIndex((i) => Math.min(i + 1, totalAssets - 1))
    } else {
      setAssetIndex((i) => Math.max(i - 1, 0))
    }
  }

  useEffect(() => {
    if (!likeBurst) return
    const t = window.setTimeout(() => setLikeBurst(null), 720)
    return () => window.clearTimeout(t)
  }, [likeBurst])

  // Compact trust badge: prefer "wieder gebucht" > completed jobs > rating
  const trustBadge =
    trust.wouldHireAgainCount > 0
      ? `${trust.wouldHireAgainCount}x wieder gebucht`
      : trust.completedJobsCount > 0
        ? `${trust.completedJobsCount} Projekte`
        : null

  const hasLikeTarget = !!likeAnchorId
  const hasSaveTarget = !!saveAnchorId
  const hasCommentsTarget = !!likeAnchorId
  // Apple-1.2 report target: the reel's craftsman (= provider auth user id).
  // Hidden when the viewer is that craftsman (the DB reports_no_self_report
  // CHECK would reject a self-report).
  const canReport = !!reel.craftsmanId && reel.craftsmanId !== currentUserId
  // user_reports.context_id is a uuid column. likeAnchorId is the portfolio-item
  // UUID on the live item-feed. The legacy provider-feed builder yields a
  // composite `provider_reel_<uuid>` for reel.id, which would 22P02 against the
  // uuid column — so never fall back to reel.id. context_id is nullable; a missing
  // anchor records the report with reported_id + context_type only.
  const reportContextId = likeAnchorId ?? undefined
  const hasPortfolioBg = !!reel.thumbnailUrl
  const responseLabel = formatResponseLatencyLabel(reel.responseLatency ?? null)

  // M3.1: video reels render a `<video>` so the feed feels TikTok/Insta-native;
  // image reels keep the `<img>` cover. The legacy provider-feed branch (no
  // mediaType) falls through to the `<img>` path with `reel.thumbnailUrl`.
  const videoSrc =
    isItemReel && isVideo
      ? selectVideoSource({
          // Minimal PortfolioItem-shape required by selectVideoSource — only
          // the four fields it reads. Other fields are unused at runtime.
          id: reel.mediaId ?? reel.id,
          providerId: reel.providerId ?? '',
          kind: 'portfolio',
          mediaType: 'video',
          storagePath: null,
          publicUrl: reel.mediaUrl ?? null,
          posterUrl: reel.posterUrl ?? null,
          h264Url: reel.h264Url ?? null,
          title: null,
          caption: null,
          description: null,
          tradeTags: [],
          sortOrder: 0,
          published: true,
          showPrice: false,
          showDuration: false,
          sourceJobId: null,
          projectTitleSnapshot: null,
          locationSnapshot: null,
          durationSnapshot: null,
          amountSnapshot: null,
          tradeTagsSnapshot: [],
          assets: [],
          createdAt: 0,
          updatedAt: 0,
        })
      : null

  // Headline / body slot decision (reels can carry caption-only,
  // description-only, both, or neither). The mapper keeps the slots
  // distinct now — pickReelTitle no longer falls back to a description
  // snippet — so the Card can present them without de-duplication
  // heuristics. The description paragraph (with the Insta-style
  // "mehr"-Expand) renders whenever a description exists; the headline
  // renders whenever a caption / title exists. Both can appear, both can
  // be absent.
  const captionHeadline = reel.title?.trim() ?? ''
  const showHeadline = captionHeadline.length > 0
  const showDescriptionBody = hasDescription

  return (
    <div
      ref={cardRef}
      className="relative h-full w-full overflow-hidden bg-slate-950"
      onTouchStart={handleCardTouchStart}
      onTouchEnd={handleCardTouchEnd}
    >
      {/* Base layer — the main media. The <video> stays MOUNTED across carousel
          swipes (it is NOT swapped out at assetIndex>0); a photo asset is drawn
          as an overlay on top instead. Returning to the video therefore never
          re-mounts / re-buffers / re-pauses it (B4.1). */}
      {isItemReel && isVideo && videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          // Only ever a REAL poster image — never reel.thumbnailUrl, which for a
          // video collapses to the video URL (poster_url ?? public_url) and would
          // feed an MP4/MOV to the image `poster` attribute → black/broken flash.
          // A null poster intentionally falls through to the card's bg until the
          // first frame decodes (B2.3).
          poster={reel.posterUrl ?? undefined}
          className="absolute inset-0 h-full w-full object-cover"
          muted={!unmuted}
          playsInline
          loop
          // Buffer strategy decided by the feed: 'auto' for the active reel +
          // forward neighbor (instant swipe), 'metadata' for the backward
          // neighbor so we don't warm every transient neighbor on cellular (B2.4).
          preload={videoPreload}
          // iOS WKWebView quirks:
          //   - touch-action: manipulation  → disables double-tap-zoom so
          //     onClick fires reliably and immediately on a single tap.
          //   - -webkit-touch-callout: none → suppresses the long-press
          //     "Save Video" / "Add to Photos" context menu, which would
          //     otherwise let viewers exfiltrate raw uploads on iOS.
          //   - user-select: none           → no awkward text-selection on
          //     long-press (Android Chrome).
          style={{
            touchAction: 'manipulation',
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
          // Block 3: Single-tap toggles pause, double-tap likes + Heart-Burst
          // (Insta-Convention). useDoubleTap fires the single-tap IMMEDIATELY
          // (instant pause); a second tap within the 300ms window still routes
          // to the double-tap-like, which reverts the pause. The pause GLYPH is
          // delayed (showPauseGlyph) so that revert never flashes the icon.
          {...videoTapHandlers}
          // Disable the WKWebView remote-playback / picture-in-picture
          // affordances explicitly. `controlsList` is only honored when
          // `controls` is set, but the dedicated boolean attributes below
          // apply unconditionally — keep them.
          disableRemotePlayback
          // controlsList is a defensive hint for browsers that surface
          // controls anyway (e.g. when an extension forces them).
          controlsList="nodownload nofullscreen noremoteplayback"
        />
      ) : hasPortfolioBg ? (
        <img
          src={reel.thumbnailUrl}
          alt={reel.title}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        // Fallback bei Provider ohne Portfolio: Brand-Gradient statt
        // Avatar-Vollbild-Stretch.
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(170deg, #1e3a8a 0%, #0f172a 100%)',
        }} />
      )}

      {/* Carousel overlay — a non-first asset (photo) drawn ON TOP of the still-
          mounted base video (DOM order = above the <video>, below the gradient
          and controls). For a video asset use only a real poster, never the
          video URL. The base video is paused behind it (showingVideo=false). */}
      {multiAsset && assetIndex > 0 && currentAsset ? (
        currentAsset.mediaType === 'video' ? (
          currentAsset.posterUrl ? (
            <img
              src={currentAsset.posterUrl}
              alt={reel.title}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-slate-950" />
          )
        ) : (
          <img
            src={currentAsset.publicUrl}
            alt={reel.title}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )
      ) : null}

      {/* Centered pause indicator — only while the user paused AND the video is
          the visible asset (not a carousel photo). Pointer-events disabled so
          the underlying <video> still receives the resume tap. */}
      {isItemReel && isVideo && assetIndex === 0 && showPauseGlyph ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
            <Pause size={28} strokeWidth={1.6} className="fill-white stroke-white" aria-label="Pausiert" />
          </div>
        </div>
      ) : null}

      {/* Buffering spinner — only while the video (visible asset) waits on
          network data and the user has not paused. Pointer-events disabled. */}
      {isItemReel && isVideo && assetIndex === 0 && isBuffering && !userPaused ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" aria-label="Lädt">
          <Spinner size="lg" tone="onDark" />
        </div>
      ) : null}

      {/* Heart-Burst overlay (Block 3) — Insta-Convention beim Double-Tap.
          Pointer-events deaktiviert, damit der Tap am Video durchkommt
          und die Animation nicht selbst die nächste Geste blockt. */}
      {likeBurst ? (
        <div
          key={likeBurst.id}
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 animate-heart-burst"
          style={{ left: likeBurst.x, top: likeBurst.y }}
          aria-hidden
        >
          <Heart
            size={96}
            strokeWidth={1.4}
            className="fill-red-500 stroke-red-400 drop-shadow-[0_4px_18px_rgba(239,68,68,0.6)]"
            aria-hidden
          />
        </div>
      ) : null}

      {/* Gradient overlay — tighter at top, heavier at bottom */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.02)_0%,rgba(15,23,42,0.05)_28%,rgba(15,23,42,0.22)_55%,rgba(15,23,42,0.82)_100%)] pointer-events-none" />

      {/* M3: asset navigation tap zones — invisible strips on left/right.
          Positioned in mid-card (10%–65% height) to avoid the mute button
          at the top-right and action column at the bottom-right. z-[5] so
          action buttons (z-10/z-20) remain on top. */}
      {multiAsset && assetIndex > 0 ? (
        <button
          type="button"
          aria-label="Vorheriges Bild"
          onClick={() => setAssetIndex((i) => Math.max(i - 1, 0))}
          className="absolute left-0 top-[10%] z-[5] h-[55%] w-[28%]"
        />
      ) : null}
      {multiAsset && assetIndex < totalAssets - 1 ? (
        <button
          type="button"
          aria-label="Nächstes Bild"
          onClick={() => setAssetIndex((i) => Math.min(i + 1, totalAssets - 1))}
          className="absolute right-0 top-[10%] z-[5] h-[55%] w-[28%]"
        />
      ) : null}

      {/* Mute / Unmute — video reels only. Positioned below the header pill bar.
          env(safe-area-inset-top) accounts for the device status bar; the +56px
          clears the tab pills rendered by ExploreFeed's header overlay. */}
      {isItemReel && isVideo ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleMute() }}
          aria-label={unmuted ? 'Ton ausschalten' : 'Ton einschalten'}
          aria-pressed={unmuted}
          className="absolute z-20 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition active:scale-[0.92]"
          style={{
            top: 'calc(env(safe-area-inset-top, 0px) + 56px)',
            right: '12px',
            touchAction: 'manipulation',
          }}
        >
          {unmuted ? (
            <Volume2 size={17} strokeWidth={1.8} className="stroke-white" aria-hidden />
          ) : (
            <VolumeX size={17} strokeWidth={1.8} className="stroke-white" aria-hidden />
          )}
        </button>
      ) : null}

      <div className="relative z-10 flex h-full w-full flex-col justify-end px-4 pb-5 pointer-events-none">
        <div className="flex items-end gap-3 pointer-events-auto">

          {/* ── Left: profile + meta + description + CTA ── */}
          <div className="min-w-0 flex-1">

            {/* Profile row: avatar + name + "Profil" link */}
            <button
              type="button"
              onClick={handleProfileNavigate}
              className="flex w-full items-center gap-2 text-left"
            >
              {reel.craftsmanAvatarUrl ? (
                <img
                  src={reel.craftsmanAvatarUrl}
                  alt={reel.craftsmanName}
                  className="h-8 w-8 flex-shrink-0 rounded-full object-cover ring-1 ring-white/20"
                />
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-slate-700 ring-1 ring-white/20">
                  <span className="text-[11px] font-bold text-white">
                    {reel.craftsmanName.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <div className="min-w-0 flex-1 flex items-baseline gap-1">
                <span className="truncate text-[13px] font-semibold leading-tight text-white">
                  {reel.craftsmanName}
                </span>
                {reel.verified ? (
                  <BadgeCheck size={13} className="text-blue-300 flex-shrink-0" aria-label="Verifiziert" />
                ) : null}
                <span className="flex-shrink-0 text-[10px] text-slate-300/50 ml-1">
                  Profil
                </span>
              </div>
            </button>

            {/* Meta row: handle · location · trust/rating badge */}
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="truncate text-[11px] text-slate-300/70">
                {reel.craftsmanHandle} · {reel.location}
              </span>
              {trustBadge ? (
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/60 backdrop-blur-sm">
                  {trustBadge}
                </span>
              ) : null}
              {reputation.ratingCount > 0 ? (
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/60 backdrop-blur-sm">
                  ★ {formatAverageRating(reputation)}
                </span>
              ) : null}
            </div>

            {/* Antwortzeit-Surrogat (Trust-Signal). Bewusst zurückhaltend
                gestyled, nur wenn Provider rating- + verified-fähig ist. */}
            {responseLabel ? (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                {responseLabel}
              </div>
            ) : null}

            {/* Caption / headline — always 1-2 lines clamped. Hidden when
                no caption / title was uploaded; in that case the
                description paragraph below carries the visible text. */}
            {showHeadline ? (
              <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug text-white/90">
                {captionHeadline}
              </p>
            ) : null}

            {/* Long-form description body (Insta-style "mehr"-Expand).
                Renders whenever a description was uploaded — independent
                of the headline. Collapsed at 2 lines; tap "mehr" to expand
                inline. Long descriptions ALWAYS get the toggle; short
                ones render in full without the affordance. */}
            {showDescriptionBody ? (
              <p
                className={
                  descriptionExpanded
                    ? 'mt-1 text-[12px] leading-relaxed text-white/75 whitespace-pre-line'
                    : 'mt-1 line-clamp-2 text-[12px] leading-relaxed text-white/75'
                }
              >
                {description}
                {descriptionCanExpand ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => setDescriptionExpanded((v) => !v)}
                      className="text-[12px] font-semibold text-white/70 underline-offset-2 hover:underline"
                    >
                      {descriptionExpanded ? 'weniger' : 'mehr'}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}

            {/* Cost + Duration chips */}
            {(reel.costLabel || reel.durationLabel) ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {reel.costLabel ? (
                  <span className="rounded-full bg-white/12 px-2.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm">
                    {reel.costLabel}
                  </span>
                ) : null}
                {reel.durationLabel ? (
                  <span className="rounded-full bg-white/12 px-2.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm">
                    {reel.durationLabel}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* Single primary CTA — customer-only.  Craftsmen browse the
                same feed for inspiration but cannot inquire on other
                craftsmen's reels (project requests are a customer surface). */}
            {canInquire ? (
              <div className="mt-2.5">
                <button
                  type="button"
                  onClick={handleInquiry}
                  disabled={inquiryPending}
                  className="rounded-full bg-white/90 px-4 py-1.5 text-[12px] font-semibold text-slate-900 backdrop-blur-sm transition active:scale-[0.97] disabled:opacity-60"
                >
                  {inquiryPending ? 'Wird gesendet…' : 'Projekt anfragen'}
                </button>
              </div>
            ) : null}

            {/* Inline error feedback */}
            {canInquire && inquiryError ? (
              <p className="mt-1.5 text-[11px] font-semibold text-red-400">{inquiryError}</p>
            ) : like.error ? (
              <p className="mt-1.5 text-[11px] font-semibold text-red-400">{like.error}</p>
            ) : save.error ? (
              <p className="mt-1.5 text-[11px] font-semibold text-red-400">{save.error}</p>
            ) : null}

            {/* M3: dot indicators for multi-asset items */}
            {multiAsset ? (
              <div className="mt-2 flex gap-1.5">
                {reelAssets.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 rounded-full transition-all duration-200 ${
                      i === assetIndex ? 'w-3 bg-white' : 'w-1.5 bg-white/50'
                    }`}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {/* ── Right: action column — Like / Comment / Save ── */}
          <div className="flex w-10 flex-col items-center gap-0.5 pb-1">

            {/* Like */}
            <button
              type="button"
              onClick={() => void handleLike()}
              disabled={like.pending || !hasLikeTarget}
              aria-label={like.isLiked ? 'Like entfernen' : 'Gefällt mir'}
              aria-pressed={like.isLiked}
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition before:absolute before:-inset-0.5 before:content-[''] active:scale-[0.92] disabled:opacity-40"
            >
              <Heart
                key={`heart-${likePopKey}`}
                size={17}
                strokeWidth={1.8}
                className={`${like.isLiked ? 'fill-red-500 stroke-red-500' : 'stroke-white'} ${likePopKey > 0 ? 'animate-heart-pop' : ''}`}
                aria-hidden
              />
            </button>
            <span
              key={`count-${liveLikeCount}`}
              className="mb-2 min-h-[14px] text-[10px] font-semibold text-white/60 animate-count-tick"
            >
              {liveLikeCount > 0 ? formatCount(liveLikeCount) : ''}
            </span>

            {/* Comment — opens the bottom sheet for the reel's mediaId. */}
            <button
              type="button"
              onClick={() => setCommentsOpen(true)}
              disabled={!hasCommentsTarget}
              aria-label="Kommentare öffnen"
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition before:absolute before:-inset-0.5 before:content-[''] active:scale-[0.92] disabled:opacity-40"
            >
              <MessageCircle size={17} strokeWidth={1.8} className="stroke-white" aria-hidden />
            </button>
            <span className="mb-2 min-h-[14px] text-[10px] font-semibold text-white/60" />

            {/* Save / Bookmark — short-tap toggles (onClick), long-press opens folder sheet */}
            <button
              type="button"
              {...saveHandlers}
              onClick={handleSaveTap}
              disabled={save.pending || !hasSaveTarget}
              aria-label={save.isSaved ? 'Speichern entfernen' : 'Merken'}
              aria-pressed={save.isSaved}
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition before:absolute before:-inset-0.5 before:content-[''] active:scale-[0.92] disabled:opacity-40"
              style={{ WebkitTouchCallout: 'none', touchAction: 'manipulation' }}
            >
              <Bookmark
                key={`bm-${bookmarkPopKey}`}
                size={17}
                strokeWidth={1.8}
                className={`${save.isSaved ? 'fill-white stroke-white' : 'stroke-white'} ${bookmarkPopKey > 0 ? 'animate-bookmark-pop' : ''}`}
                aria-hidden
              />
            </button>
            <span className="mb-2 min-h-[14px] text-[10px] font-semibold text-white/60">
              {save.saveCount > 0 ? formatCount(save.saveCount) : ''}
            </span>

            {/* Share — native share sheet (Capacitor) with clipboard fallback. */}
            <button
              type="button"
              onClick={() => void handleShare()}
              aria-label="Reel teilen"
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition before:absolute before:-inset-0.5 before:content-[''] active:scale-[0.92]"
            >
              <Share2 size={17} strokeWidth={1.8} className="stroke-white" aria-hidden />
            </button>
            <span className="mb-2 min-h-[14px]" />

            {/* Report (Apple 1.2) — hidden on the viewer's own reel. */}
            {canReport ? (
              <>
                <button
                  type="button"
                  onClick={() => setReportOpen(true)}
                  aria-label="Reel melden"
                  className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition before:absolute before:-inset-0.5 before:content-[''] active:scale-[0.92]"
                >
                  <Flag size={17} strokeWidth={1.8} className="stroke-white" aria-hidden />
                </button>
                <span className="mb-2 min-h-[14px]" />
              </>
            ) : null}

          </div>
        </div>
      </div>

      {/* Mounted only while open so its useKeyboardInset rig (and comment
          fetch + realtime channel) runs only when the user opened comments,
          not for every reel card in the virtualization window. */}
      {commentsOpen ? (
        <PortfolioCommentsPanel
          open={commentsOpen}
          mediaId={likeAnchorId ?? null}
          currentUserId={currentUserId}
          // The reel's `craftsmanId` is the provider's auth.users.id (it
          // comes from `providers.profile_id`), which is exactly what
          // PortfolioCommentsPanel expects for host-moderation.
          providerOwnerUserId={reel.craftsmanId ?? null}
          onClose={() => setCommentsOpen(false)}
        />
      ) : null}

      {/* Mount the folder sheet only while open — otherwise its useSavedFolders
          hook opens a folder-list fetch + 2 realtime channels per reel card even
          though the sheet is closed (channel-storm contributor, B2.2). */}
      {folderSheetOpen ? (
        <SaveToFolderSheet
          open={folderSheetOpen}
          onClose={() => setFolderSheetOpen(false)}
          currentFolderId={save.isSaved ? save.folderId : undefined}
          isSaved={save.isSaved}
          onPick={async (folderId) => {
            const ok = await save.saveToFolder(folderId)
            if (ok) toast.success(folderId === null ? 'In „Alle gespeicherten" gemerkt' : 'In Ordner gespeichert')
            else toast.error('Reel konnte nicht gespeichert werden.')
          }}
          onUnsave={async () => {
            const ok = await save.unsave()
            if (ok) toast.success('Aus Gespeicherten entfernt')
            else toast.error('Reel konnte nicht entfernt werden.')
          }}
        />
      ) : null}

      {reportOpen ? (
        <ReportUserSheet
          targetUserId={reel.craftsmanId}
          targetLabel={reel.craftsmanName}
          contextType="explore_reel"
          contextId={reportContextId}
          onClose={() => setReportOpen(false)}
        />
      ) : null}
    </div>
  )
}

// Memoized: the feed re-renders on every active-index change while scrolling;
// cards whose (reel, viewerRole, videoPreload) props are unchanged skip the
// re-render. Interaction state lives in hooks/local state, not props.
export default memo(ExploreReelCard)
