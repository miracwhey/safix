import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, ChevronDown, ChevronUp, Heart, MessageCircle, Smartphone, X } from 'lucide-react'
import type { PortfolioItem } from '../../lib/providerMedia'
import { getPlaybackBlockReason, selectVideoSource } from '../../lib/media/playbackCompat'
import { useVideoTeardown } from '../../lib/media/useVideoTeardown'
import { useLikeStatus } from '../../lib/providerMedia/useLikeStatus'
import { useSaveStatus } from '../../lib/providerMedia/useSaveStatus'
import { useComments } from '../../lib/providerMedia/useComments'
import { useToast } from '../../hooks/useToast'
import { useLongPress } from '../../lib/ui/useLongPress'
import PortfolioCommentsPanel from './PortfolioCommentsPanel'
import SaveToFolderSheet from '../savedReels/SaveToFolderSheet'
import SourceJobMarker from './SourceJobMarker'

type Props = {
  open: boolean
  items: PortfolioItem[]
  /** Index in `items` to start playback from. Clamped to bounds. */
  startIndex: number
  onClose: () => void
  /** Optional likeCount lookup keyed by provider_media.id. Used for footer. */
  likeCounts?: Record<string, number>
  /**
   * Auth user id of the viewer (M2.3 — only set when signed in). Drives
   * the comment-composer enable/disable + the "your comments" delete
   * affordance.
   */
  currentUserId?: string | null
  /**
   * Auth user id of the provider that owns these reels. Lets the host
   * delete any comment on their own media (parity with the RLS DELETE
   * policy). For the explore profile this equals
   * `profile.craftsmanId` because profiles.id = auth.users.id.
   */
  providerOwnerUserId?: string | null
}

/**
 * Fullscreen TikTok-style lightbox. Tap a tile in `ProfileReelsGrid` /
 * `ProfilePortfolioGrid` to open. Vertical swipe + arrow keys navigate
 * between items. Native `<video controls>` for actual playback so the
 * built-in scrub bar / mute toggle / timeline ride along.
 *
 * Compat banner: when `getPlaybackBlockReason(item)` returns non-null
 * (today: HEVC `.mov` on Android Chromium), the player swaps the `<video>`
 * for the poster frame plus a centered explainer card. This keeps the cover
 * frame visible and avoids the ghost-spinner of a `<video>` whose codec the
 * browser will silently fail to decode.
 *
 * Touch handling: only vertical drags >= SWIPE_THRESHOLD trigger navigation.
 * Horizontal motion is ignored so the user can scroll-through long captions
 * without flipping reels by accident.
 */

const SWIPE_THRESHOLD = 60

export default function PortfolioLightbox({
  open,
  items,
  startIndex,
  onClose,
  likeCounts,
  currentUserId = null,
  providerOwnerUserId = null,
}: Props) {
  const toast = useToast()
  const total = items.length
  const clampedStart = useMemo(() => {
    if (total === 0) return 0
    if (startIndex < 0) return 0
    if (startIndex >= total) return total - 1
    return startIndex
  }, [startIndex, total])

  const [currentIndex, setCurrentIndex] = useState<number>(clampedStart)
  const [assetIndex, setAssetIndex] = useState<number>(0)
  const [commentsOpen, setCommentsOpen] = useState<boolean>(false)
  const [folderSheetOpen, setFolderSheetOpen] = useState<boolean>(false)
  const [likePopKey, setLikePopKey] = useState<number>(0)
  const [bookmarkPopKey, setBookmarkPopKey] = useState<number>(0)

  // Reset cursor whenever the consumer reopens with a new starting point.
  // The single-mount lightbox would otherwise keep its previous index when
  // the parent closes-and-reopens fast. We synchronise with `open` via a
  // useEffect (refs can't be read during render — react-hooks/refs); the
  // ref-write at the tail tracks the previous value for the rising-edge check.
  const prevOpenRef = useRef<boolean>(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // Rising-edge reset: the consumer reopened the lightbox at a new
      // startIndex; we mirror that into local state. This runs at most once
      // per open-cycle so the cascading-render concern of
      // react-hooks/set-state-in-effect doesn't apply.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentIndex(clampedStart)
    }
    prevOpenRef.current = open
  }, [open, clampedStart])

  // Items can shrink while the lightbox is open (e.g. user unsave-t einen
  // Reel im Saved-Folder-Screen → useSavedReels filtert ihn raus → `items`-
  // Prop des Lightboxes verkürzt sich). Ohne Clamping zeigt der Player „1/8"
  // statt „1/7" und der currentIndex steht out-of-bounds → leerer Stage.
  useEffect(() => {
    if (!open) return
    if (total === 0) return
    if (currentIndex >= total) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentIndex(total - 1)
    }
  }, [open, total, currentIndex])

  // Reset within-post asset cursor whenever the active item changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssetIndex(0)
  }, [currentIndex])

  const goPrev = useCallback(() => {
    setCurrentIndex((idx) => (idx <= 0 ? idx : idx - 1))
  }, [])
  const goNext = useCallback(() => {
    setCurrentIndex((idx) => (idx >= total - 1 ? idx : idx + 1))
  }, [total])


  // Keyboard navigation. Escape closes the lightbox; arrows navigate. While
  // the comments panel is open it owns the keyboard — its own Escape handler
  // closes the panel, and we must not also close the lightbox in the same
  // keydown event. Arrow keys are silenced too so a textarea cursor moves
  // freely without flipping reels.
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      // Comments panel + folder sheet own the keyboard while open — they self-
      // close on Escape, so the lightbox must not also close in the same event.
      if (commentsOpen || folderSheetOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        goNext()
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        goPrev()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, commentsOpen, folderSheetOpen, onClose, goPrev, goNext])

  // Lock scroll while open so the page underneath can't shift. App scroll
  // moved from <body> into [data-app-scroll] (AppShell Body→Container), so
  // locking only body.style.overflow is now a no-op — lock the container too
  // (body kept as belt-and-suspenders for any non-AppShell mount context).
  useEffect(() => {
    if (!open) return
    const scroller = document.querySelector<HTMLElement>('[data-app-scroll]')
    const previousBody = document.body.style.overflow
    const previousScroller = scroller?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (scroller) scroller.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousBody
      if (scroller) scroller.style.overflow = previousScroller
    }
  }, [open])

  // Touch swipe. We only commit a navigation on touchend so cancellations
  // (touchcancel / multi-finger / out-of-range) don't desync state.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const onTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      // While the comments panel OR the folder sheet is open it owns touches —
      // record nothing so a swipe inside the thread / a scroll or grabber-pull
      // on the folder sheet does not get consumed as a reel-flip when the user
      // lifts their finger (which would silently flip the reel behind the sheet
      // and save the wrong one).
      if (commentsOpen || folderSheetOpen) return
      const t = event.touches[0]
      if (!t) return
      touchStartRef.current = { x: t.clientX, y: t.clientY }
    },
    [commentsOpen, folderSheetOpen],
  )

  const onTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      // Comments panel + folder sheet sit above the lightbox in the same React
      // tree so their touch events bubble up. Ignore them entirely while either
      // is open — the user is scrolling the thread / folder list, not navigating
      // reels. (The folder sheet also stops its own touches, but this host-side
      // guard is the authoritative defense.)
      if (commentsOpen || folderSheetOpen) return
      if (!start) return
      const t = event.changedTouches[0]
      if (!t) return
      const dy = t.clientY - start.y
      const dx = t.clientX - start.x
      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal swipe → navigate within-post assets when N>1.
        const assetCount = items[currentIndex]?.assets.length ?? 0
        if (assetCount > 1 && Math.abs(dx) >= SWIPE_THRESHOLD) {
          if (dx < 0) {
            setAssetIndex((ai) => Math.min(ai + 1, assetCount - 1))
          } else {
            setAssetIndex((ai) => Math.max(ai - 1, 0))
          }
        }
        return
      }
      if (dy <= -SWIPE_THRESHOLD) {
        goNext()
      } else if (dy >= SWIPE_THRESHOLD) {
        goPrev()
      }
    },
    [commentsOpen, folderSheetOpen, goPrev, goNext, items, currentIndex],
  )

  // Hooks below MUST run on every render to satisfy the Rules of Hooks.
  // Calling them after a conditional `return null` means the hook count
  // differs between "closed" and "open" renders and React crashes with
  // "Rendered more hooks than during the previous render." The hooks
  // themselves are null-tolerant — passing a missing media id parks them
  // in their initial state without subscribing to anything.
  const item = open && total > 0 ? items[currentIndex] ?? null : null
  const seedLikeCount = item ? likeCounts?.[item.id] ?? 0 : 0
  const likeStatus = useLikeStatus(item?.id ?? null)
  const saveStatus = useSaveStatus(item?.id ?? null)
  const commentStatus = useComments(item?.id ?? null)

  const handleSaveTap = useCallback(() => {
    if (!item) return
    if (currentUserId === null || currentUserId === undefined) {
      toast.info('Bitte logge dich ein, um Reels zu speichern.')
      return
    }
    setBookmarkPopKey((k) => k + 1)
    void saveStatus.toggle()
  }, [currentUserId, item, saveStatus, toast])

  const handleSaveLongPress = useCallback(() => {
    if (!item) return
    if (currentUserId === null || currentUserId === undefined) {
      toast.info('Bitte logge dich ein, um Reels zu speichern.')
      return
    }
    setFolderSheetOpen(true)
  }, [currentUserId, item, toast])

  const saveHandlers = useLongPress(
    { onTap: handleSaveTap, onLongPress: handleSaveLongPress },
    { thresholdMs: 380 },
  )

  // Hard-release the active <video> on close + navigation. The lightbox plays
  // UNMUTED fullscreen clips and does NOT use useReelAutoPlay's teardown, so
  // without this a removed <video> keeps holding the iOS WKWebView audio session
  // (the previous clip's sound trails AND the next clip is blocked) — the same
  // failure class fixed for the reels feed. Keyed on item + asset so every
  // reel/asset change releases the outgoing element; both <video> branches share
  // the ref and only one is ever mounted at a time.
  const videoRef = useVideoTeardown(item ? `${item.id}:${assetIndex}` : 'closed')

  if (!open || total === 0) return null
  if (!item) return null

  // Within-post asset carousel — only active when the post has N>1 assets.
  const multiAsset = item.assets.length > 1
  const clampedAssetIndex = multiAsset
    ? Math.min(assetIndex, item.assets.length - 1)
    : 0
  const currentAsset = multiAsset ? (item.assets[clampedAssetIndex] ?? null) : null

  const isVideo = multiAsset
    ? (currentAsset?.mediaType ?? 'image') === 'video'
    : item.mediaType === 'video'
  const blockReason = !multiAsset && isVideo ? getPlaybackBlockReason(item) : null
  // Prefer the live count once the hook has hydrated. The seed prevents a
  // 0→N flash on first mount while the fetch is in flight, AND a stale
  // ghost number when a tile genuinely sits at 0 likes (the previous
  // `> 0 ? live : seed` heuristic kept showing the seed forever in that
  // case).
  const liveLikeCount = likeStatus.hydrated ? likeStatus.likeCount : seedLikeCount
  const captionLine = (item.title ?? item.caption ?? '').trim()
  const subtitle = buildSubtitle(item)

  // Portal to document.body: this fullscreen reel viewer is opened from
  // transformed/scrolled feed ancestors (ExploreCraftsmanProfile, SavedReels),
  // which trap `position:fixed` in iOS WKWebView. Mirrors HighlightStoryViewer /
  // SpatialFullscreenViewer. All `absolute` chrome inside this div moves with it.
  const viewer = (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black"
      style={{ touchAction: 'pan-y' }}
      role="dialog"
      aria-modal="true"
      aria-label="Reel-Player"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Top bar — close + index pill */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur"
          aria-label="Schließen"
        >
          <X size={18} aria-hidden />
        </button>
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
          {currentIndex + 1} / {total}
        </span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      {/* Stage — fills the remaining viewport, centers media */}
      <div className="relative flex flex-1 items-center justify-center">
        {multiAsset && currentAsset ? (
          // Within-post carousel: render the current asset directly
          currentAsset.mediaType === 'video' ? (
            <video
              key={`${item.id}-a${clampedAssetIndex}`}
              ref={videoRef}
              src={currentAsset.h264Url ?? currentAsset.publicUrl}
              poster={currentAsset.posterUrl ?? undefined}
              className="h-full max-h-full w-full max-w-full object-contain"
              controls
              autoPlay
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              key={`${item.id}-a${clampedAssetIndex}`}
              src={currentAsset.publicUrl}
              alt={captionLine || 'Arbeitsprobe'}
              className="h-full max-h-full w-full max-w-full object-contain"
              decoding="async"
            />
          )
        ) : item.publicUrl ? (
          // Single-asset fallback — use cover cache from provider_media
          isVideo && blockReason ? (
            <CompatBanner item={item} reason={blockReason.message} />
          ) : isVideo ? (
            <video
              key={item.id}
              ref={videoRef}
              src={selectVideoSource(item) ?? undefined}
              poster={item.posterUrl ?? undefined}
              className="h-full max-h-full w-full max-w-full object-contain"
              controls
              autoPlay
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              src={item.publicUrl}
              alt={captionLine || 'Arbeitsprobe'}
              className="h-full max-h-full w-full max-w-full object-contain"
              decoding="async"
            />
          )
        ) : (
          <p className="text-[13px] text-white/70">Inhalt nicht verfügbar.</p>
        )}

        {/* Vertical pagers — visible on desktop, hidden on touch */}
        {currentIndex > 0 && (
          <button
            type="button"
            onClick={goPrev}
            className="absolute left-1/2 top-3 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-1 text-white backdrop-blur md:flex"
            aria-label="Vorheriges Reel"
          >
            <ChevronUp size={18} aria-hidden />
          </button>
        )}
        {currentIndex < total - 1 && (
          <button
            type="button"
            onClick={goNext}
            className="absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-1 text-white backdrop-blur md:flex"
            aria-label="Nächstes Reel"
          >
            <ChevronDown size={18} aria-hidden />
          </button>
        )}
      </div>

      {/* Right-rail action column — Like (M2.2) + Comments (M2.3). Share lands here in M2.4. */}
      <div className="absolute right-3 z-20 flex flex-col items-center gap-3 text-white"
           style={{ bottom: 'max(120px, calc(env(safe-area-inset-bottom, 0px) + 96px))' }}>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setLikePopKey((k) => k + 1)
              void likeStatus.toggle()
            }}
            disabled={likeStatus.pending}
            aria-label={likeStatus.isLiked ? 'Like entfernen' : 'Gefällt mir'}
            aria-pressed={likeStatus.isLiked}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition active:scale-[0.92] disabled:opacity-60"
          >
            <Heart
              key={`lb-heart-${likePopKey}`}
              size={20}
              strokeWidth={1.8}
              className={`${likeStatus.isLiked ? 'fill-red-500 stroke-red-500' : 'stroke-white'} ${likePopKey > 0 ? 'animate-heart-pop' : ''}`}
              aria-hidden
            />
          </button>
          <span
            key={`lb-likect-${liveLikeCount}`}
            className="min-h-[14px] tabular-nums text-[11px] font-semibold text-white/85 animate-count-tick"
          >
            {liveLikeCount > 0 ? liveLikeCount : ''}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => setCommentsOpen(true)}
            aria-label="Kommentare öffnen"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition active:scale-[0.92]"
          >
            <MessageCircle size={20} strokeWidth={1.8} className="stroke-white" aria-hidden />
          </button>
          <span className="min-h-[14px] tabular-nums text-[11px] font-semibold text-white/85">
            {commentStatus.count > 0 ? commentStatus.count : ''}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            {...saveHandlers}
            disabled={saveStatus.pending}
            aria-label={saveStatus.isSaved ? 'Speichern entfernen' : 'Merken'}
            aria-pressed={saveStatus.isSaved}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition active:scale-[0.92] disabled:opacity-60"
            style={{ WebkitTouchCallout: 'none', touchAction: 'manipulation' }}
          >
            <Bookmark
              key={`lb-bm-${bookmarkPopKey}`}
              size={20}
              strokeWidth={1.8}
              className={`${saveStatus.isSaved ? 'fill-white stroke-white' : 'stroke-white'} ${bookmarkPopKey > 0 ? 'animate-bookmark-pop' : ''}`}
              aria-hidden
            />
          </button>
          <span className="min-h-[14px] tabular-nums text-[11px] font-semibold text-white/85">
            {saveStatus.saveCount > 0 ? saveStatus.saveCount : ''}
          </span>
        </div>
      </div>

      <PortfolioCommentsPanel
        open={commentsOpen}
        mediaId={item.id}
        currentUserId={currentUserId}
        providerOwnerUserId={providerOwnerUserId}
        onClose={() => setCommentsOpen(false)}
      />

      <SaveToFolderSheet
        open={folderSheetOpen}
        onClose={() => setFolderSheetOpen(false)}
        currentFolderId={saveStatus.isSaved ? saveStatus.folderId : undefined}
        isSaved={saveStatus.isSaved}
        onPick={async (folderId) => {
          const ok = await saveStatus.saveToFolder(folderId)
          if (ok) toast.success(folderId === null ? 'In „Alle gespeicherten" gemerkt' : 'In Ordner gespeichert')
          else toast.error('Reel konnte nicht gespeichert werden.')
        }}
        onUnsave={async () => {
          const ok = await saveStatus.unsave()
          if (ok) toast.success('Aus Gespeicherten entfernt')
          else toast.error('Reel konnte nicht entfernt werden.')
        }}
      />

      {/* Footer — meta + source-job marker */}
      <div className="relative z-10 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 text-white space-y-2">
        {/* Within-post asset dots — only when N>1 assets */}
        {multiAsset && (
          <div className="flex justify-center gap-1.5 pb-1">
            {item.assets.map((_, i) => (
              <div
                key={i}
                className={[
                  'h-1.5 rounded-full transition-all duration-200',
                  i === clampedAssetIndex ? 'w-3 bg-white' : 'w-1.5 bg-white/45',
                ].join(' ')}
              />
            ))}
          </div>
        )}
        {captionLine ? (
          <p className="line-clamp-3 text-[14px] font-semibold">{captionLine}</p>
        ) : null}
        {item.description ? (
          <p className="line-clamp-3 text-[12px] text-white/80">{item.description}</p>
        ) : null}
        {likeStatus.error ? (
          <p className="text-[11px] font-semibold text-red-300" role="alert">
            {likeStatus.error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[11px] text-white/80">
          {subtitle ? <span>{subtitle}</span> : <span />}
          {item.sourceJobId ? (
            <SourceJobMarker item={item} variant="caption" className="text-white/90" />
          ) : null}
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? viewer : createPortal(viewer, document.body)
}

function CompatBanner({ item, reason }: { item: PortfolioItem; reason: string }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-contain opacity-40"
        />
      ) : null}
      <div className="relative z-10 mx-6 max-w-[320px] rounded-2xl bg-white/95 p-5 text-center shadow-2xl">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white">
          <Smartphone size={18} aria-hidden />
        </div>
        <p className="text-[14px] font-semibold text-slate-900">Nur auf iPhone abspielbar</p>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{reason}</p>
      </div>
    </div>
  )
}

function buildSubtitle(item: PortfolioItem): string | null {
  const location = item.locationSnapshot?.trim()
  const year = new Date(item.createdAt).getFullYear()
  const yearStr = Number.isFinite(year) && year > 1970 ? String(year) : null
  const parts = [location, yearStr].filter((p): p is string => !!p)
  return parts.length > 0 ? parts.join(' · ') : null
}
