import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import AppShell from '../components/AppShell'
import ExploreReelCard from '../components/explore/ExploreReelCard'
import { AudioSessionProvider } from '../lib/explore/useAudioSession'
import ExploreSearchScreen from '../components/explore/ExploreSearchScreen'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import Spinner from '../components/system/Spinner'
import {
  fetchExploreItemFeedPage,
  type ExploreItemFeedCursor,
} from '../lib/explore/exploreItemFeedService'
import { getExploreSearchResults } from '../lib/explore/exploreService'
import { getExploreProviderCards } from '../lib/explore/exploreProfileService'
import { buildViewerContext, type ViewerContext } from '../lib/explore/exploreRanking'
import type { ExploreReel, ExploreTab } from '../lib/explore/exploreTypes'
import { setDiscoveryProviderCache, fetchDiscoveryProviders } from '../lib/discovery'
import type { DiscoveryProvider } from '../lib/discovery/discoveryTypes'
import { useSession } from '../hooks/useSession'
import { resolveAppContext } from '../lib/access'
import { supabase } from '../lib/supabase'
import { logError } from '../lib/observability'

/**
 * Cheap, height-preserving stand-in for an out-of-window reel. Renders no
 * <video> and no realtime interaction channels — only a poster image when a
 * real one exists — so the scroll-snap geometry stays identical while the
 * heavy ExploreReelCard is unmounted. (A null video poster intentionally
 * falls through to a neutral black cell; the real poster fix lives in B2.3.)
 */
function ReelPlaceholder({ reel }: { reel: ExploreReel }) {
  const poster = reel.mediaType === 'image' ? reel.mediaUrl : reel.posterUrl
  return (
    <div className="h-full w-full bg-black">
      {poster && (
        <img
          src={poster}
          alt=""
          aria-hidden
          className="h-full w-full object-cover"
          loading="lazy"
        />
      )}
    </div>
  )
}

export default function ExploreFeed() {
  const session = useSession()
  const appContext = resolveAppContext(session)
  const location = useLocation()
  const isActive = location.pathname === '/explore'

  // Native StatusBar (fullscreen overlay + Light glyphs for the dark Reels
  // surface) is owned globally by StatusBarController, keyed on the route.
  // No per-screen toggle here anymore — the old mount/unmount + cleanup
  // races left the bar stuck (grey bar / wrong glyph color) when navigating
  // between Reels and normal screens.

  const [activeTab, setActiveTab] = useState<ExploreTab>('foryou')
  const [searchOpen, setSearchOpen] = useState(false)
  // Cards raise their reel.id here while ANY of their reel overlays (comments,
  // save-to-folder, report) is open so we drop the top tab pills (the sheets
  // portal over everything; leaving the pills up made them peek above the sheet
  // — TikTok shows no chrome there). Tracked as a SET keyed by reel.id, not a
  // single boolean: up to 3 cards are mounted in the virtualization window, and
  // a neighbor (re)mounting/unmounting on a realtime/visibility refetch would
  // otherwise push a stale `false` and ghost the pills back while the active
  // card's sheet is still open. Stable callback so memoized ExploreReelCard
  // doesn't re-render on every feed render.
  const [openOverlayReels, setOpenOverlayReels] = useState<Set<string>>(() => new Set())
  const handleOverlayOpenChange = useCallback((reelId: string, open: boolean) => {
    setOpenOverlayReels((prev) => {
      if (open === prev.has(reelId)) return prev
      const next = new Set(prev)
      if (open) next.add(reelId)
      else next.delete(reelId)
      return next
    })
  }, [])
  const anyReelOverlayOpen = openOverlayReels.size > 0
  const [searchQuery, setSearchQuery] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const reelRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Live mirror of activeIndex for the realtime/visibility handlers (they close
  // over stale state otherwise). Used to suppress feed refreshes that would yank
  // a deep scroller back to the top.
  const activeIndexRef = useRef(0)
  // Set when the user switches tabs → the next loaded feed scrolls back to top.
  // An epoch refresh (realtime / visibility / retry) leaves it false so the
  // user's scroll position is preserved.
  const pendingTopResetRef = useRef(false)

  // ── Item-feed state (M3.1) ─────────────────────────────────────────────────
  const [reels, setReels] = useState<ExploreReel[]>([])
  const [nextCursor, setNextCursor] = useState<ExploreItemFeedCursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // Synchronous in-flight guard: the bottom-sentinel observer can fire
  // handleLoadMore twice before the `loadingMore` state commit is visible to the
  // next call's closure, double-fetching the same cursor page. The ref is set
  // immediately so the second call bails. (The append below is also dedup'd in
  // the functional updater as a second line of defense.)
  const loadingMoreRef = useRef(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedLoading, setFeedLoading] = useState(false)
  // Manually-incremented epoch to force a refetch (visibilitychange, realtime
  // insert, retry button). Always rebuilds the feed from page 1.
  const [feedLoadEpoch, setFeedLoadEpoch] = useState(0)

  // Provider-cards still feed the search overlay's provider tab + the discovery
  // cache used by synchronous inquiry workflows. We load them once per session
  // and reuse — they are NOT the source of the reels feed any more (M3.1).
  const [discoveryProviders, setDiscoveryProviders] = useState<DiscoveryProvider[]>([])

  // ── For-you ranking signals (M3.2) ────────────────────────────────────────
  // Resolved once per viewer-session and reused for both the initial load
  // and pagination calls. A null context (unauthenticated, fetch failure)
  // tells the for-you tab to fall back to Inspiration ordering — a
  // deliberate cold-start pattern, not an error surface.
  const [viewerContext, setViewerContext] = useState<ViewerContext | null>(null)
  useEffect(() => {
    let cancelled = false
    const userId = session.user?.id
    if (!userId) {
      setViewerContext(null)
      return
    }
    void buildViewerContext(userId).then((ctx) => {
      if (!cancelled) setViewerContext(ctx)
    })
    return () => {
      cancelled = true
    }
  }, [session.user?.id])

  // ── Initial / refresh load: page 1 of the item feed ───────────────────────
  // Re-fires when:
  //   - the user toggles `activeTab` (foryou ↔ inspiration),
  //   - `feedLoadEpoch` ticks (visibilitychange, realtime insert, retry),
  //   - the user identity changes,
  //   - `viewerContext` finishes resolving — without this the first foryou
  //     fetch would land before the signals do, scoring everything at the
  //     cold-start floor and producing the inspiration order even when
  //     personalization is available a tick later.
  useEffect(() => {
    let cancelled = false
    setFeedError(null)
    setFeedLoading(true)
    fetchExploreItemFeedPage({
      tab: activeTab,
      viewerUserId: session.user?.id,
      viewerContext,
    })
      .then((page) => {
        if (cancelled) return
        setReels(page.reels)
        setNextCursor(page.nextCursor)
        // Do NOT hard-reset activeIndex here: the scroll container (<main>) is
        // not remounted on reload, so its scrollTop is preserved. The re-created
        // IntersectionObserver (deps: reels) re-derives activeIndex from the real
        // scroll offset; forcing 0 while scrolled down unmounted the visible reel.
        setFeedLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        logError('explore.feed_load_failed', err, { tab: activeTab })
        setFeedError('Reels konnten nicht geladen werden.')
        setFeedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, feedLoadEpoch, session.user?.id, viewerContext])

  // ── Search overlay backing data ───────────────────────────────────────────
  // Two independent loads, both non-blocking for the reels feed:
  //   - DiscoveryProvider[] feeds the provider tab in ExploreSearchOverlay
  //   - ExploreProviderCard[] populates the discovery cache used by
  //     synchronous inquiry workflows (CustomerNewRequestCard,
  //     CustomerProjectDetailScreen) so they can resolve providers without
  //     an async hop at inquiry time.
  useEffect(() => {
    let cancelled = false
    fetchDiscoveryProviders()
      .then((providers) => {
        if (!cancelled) setDiscoveryProviders(providers)
      })
      .catch(() => {
        // non-blocking — provider search degrades gracefully
      })
    getExploreProviderCards()
      .then((cards) => {
        if (!cancelled) setDiscoveryProviderCache(cards)
      })
      .catch(() => {
        // non-blocking — inquiry workflow falls back to async lookup
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── visibilitychange: refresh when the user returns to the tab ────────────
  // Customer keeps Reels open, backgrounds the app, comes back — the feed
  // catches up to fresh uploads without a full reload. Same pattern as
  // CraftsmanProfile / ExploreCraftsmanProfileScreen.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => {
      // Only catch up to fresh uploads when the user is at the top of the feed.
      // Refreshing while they're scrolled deep would replace the feed and yank
      // their position (the snap container's scrollTop is preserved across the
      // refetch). Deep scrollers get fresh content on their next return to top.
      if (document.visibilityState === 'visible' && activeIndexRef.current <= 0) {
        setFeedLoadEpoch((n) => n + 1)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // ── Realtime: refresh on new published portfolio items ────────────────────
  // INSERT-only channel; UPDATE published=true→false and DELETE flow into the
  // visibilitychange path on next focus. Provider_media must be a member of
  // the supabase_realtime publication for this to deliver — see migration
  // 20260505000001_provider_media_realtime.sql.
  //
  // Tightly throttled: rapid-fire publishes coalesce into a single refetch
  // via a 1.5s leading-edge timer so we don't thrash the JOIN query.
  useEffect(() => {
    let pendingTimer: number | null = null
    const channel = supabase
      .channel('explore-item-feed-inserts')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'provider_media',
          filter: 'kind=eq.portfolio',
        },
        (payload) => {
          const row = payload.new as { published?: boolean } | null
          if (!row?.published) return
          // Don't yank a deep scroller to the top for a new upload — only
          // auto-refresh when they're already at the top of the feed.
          if (activeIndexRef.current > 0) return
          if (pendingTimer !== null) return
          pendingTimer = window.setTimeout(() => {
            pendingTimer = null
            setFeedLoadEpoch((n) => n + 1)
          }, 1500)
        },
      )
      .subscribe()
    return () => {
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      void supabase.removeChannel(channel)
    }
  }, [])

  // ── Pagination: load more when the user scrolls near the bottom ───────────
  async function handleLoadMore() {
    if (loadingMoreRef.current) return
    if (!nextCursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const page = await fetchExploreItemFeedPage({
        tab: activeTab,
        viewerUserId: session.user?.id,
        viewerContext,
        cursor: nextCursor,
      })
      // Dedup INSIDE the functional updater so we filter against the authoritative
      // committed list, not a stale `reels` closure — otherwise two appends for
      // the same cursor page each compute `fresh` against the pre-page snapshot
      // and the second re-appends rows already present (duplicate React keys).
      setReels((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        const fresh = page.reels.filter((r) => !seen.has(r.id))
        return fresh.length > 0 ? [...prev, ...fresh] : prev
      })
      setNextCursor(page.nextCursor)
    } catch (err) {
      logError('explore.feed_load_more_failed', err, { tab: activeTab })
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  const searchResults = useMemo(() => {
    return getExploreSearchResults(searchQuery, reels)
  }, [searchQuery, reels])

  useEffect(() => {
    setSearchQuery('')
  }, [activeTab])

  // ── Deep-link: ?reel=<id> auto-scrolls into the matching reel ─────────────
  useEffect(() => {
    const reelId = searchParams.get('reel')
    if (!reelId) return

    const timeout = window.setTimeout(() => {
      const element = reelRefs.current[reelId]
      if (element) {
        element.scrollIntoView({ behavior: 'auto', block: 'start' })
      }
    }, 60)

    return () => window.clearTimeout(timeout)
  }, [searchParams, reels])

  // ── Bottom-sentinel observer for infinite scroll ──────────────────────────
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = bottomSentinelRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void handleLoadMore()
          }
        }
      },
      { rootMargin: '0px 0px 400px 0px', threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // We intentionally re-bind whenever the cursor flips between null/value
    // so observed-once nodes don't go stale across pagination boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore])

  // ── Virtualization: track the active reel index ───────────────────────────
  // Only the active reel and its immediate neighbors mount the heavy
  // ExploreReelCard (live <video> + realtime interaction channels); the rest
  // render a cheap poster placeholder of identical height. iOS WKWebView caps
  // concurrent video decoders (~16) and unbounded mounting grows memory without
  // limit on a long scroll, so we keep a small live window like TikTok/Insta.
  const VIRTUAL_WINDOW = 1
  const [activeIndex, setActiveIndex] = useState(0)
  const cellRefs = useRef<(HTMLDivElement | null)[]>([])
  const cellRatios = useRef<Map<number, number>>(new Map())

  // Keep the live mirror in sync for the scroll-preserving refresh guards.
  useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  // Tab switch → request a scroll-to-top once the new tab's reels render.
  useEffect(() => {
    pendingTopResetRef.current = true
  }, [activeTab])

  // After a tab-triggered reload, snap back to the first reel. Epoch refreshes
  // (realtime / visibility / retry) leave pendingTopReset false, so the user's
  // scroll position is preserved instead of being yanked to the top.
  useEffect(() => {
    if (!pendingTopResetRef.current || reels.length === 0) return
    pendingTopResetRef.current = false
    cellRatios.current.clear()
    setActiveIndex(0)
    cellRefs.current[0]?.scrollIntoView({ block: 'start' })
  }, [reels])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const ratios = cellRatios.current
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.index)
          if (Number.isNaN(idx)) continue
          ratios.set(idx, entry.isIntersecting ? entry.intersectionRatio : 0)
        }
        let bestIdx = -1
        let bestRatio = 0
        ratios.forEach((ratio, idx) => {
          if (ratio > bestRatio) {
            bestRatio = ratio
            bestIdx = idx
          }
        })
        if (bestIdx >= 0 && bestRatio >= 0.5) setActiveIndex(bestIdx)
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    cellRefs.current.length = reels.length
    for (const node of cellRefs.current) {
      if (node) observer.observe(node)
    }
    return () => {
      observer.disconnect()
      ratios.clear()
    }
    // Re-observe whenever the rendered reel set changes (reload, tab switch,
    // pagination append, realtime replace) — NOT just on length change. A fresh
    // IntersectionObserver delivers initial intersection for every observed
    // cell, so activeIndex re-derives from the actual scroll position instead
    // of going stale against a preserved scrollTop (the blank-active-reel bug).
  }, [reels])

  if (!session.sessionValidated || appContext === 'unknown' || appContext === 'employee') {
    return (
      <AppShell active="explore" bottomNavVariant="immersive" immersive className="bg-black">
        <ScreenSkeleton />
      </AppShell>
    )
  }

  const header = searchOpen ? null : (
    <div className="px-3 pb-1 pt-2">
      <div className="safe-top" />

      {/* Liquid-Glass Pill — kompakter und transparenter als pre-PR-D.
          .liquid-glass-dark liefert das iOS-26-Glas-Surface (10% white max,
          subtler border, blur 32px + saturate 1.6). Active-Pill ist ein
          weicheres weißes Highlight (75% statt 90%) damit es zum Glas-Look
          passt und nicht solid wirkt. */}
      <div className="mx-auto flex w-full max-w-[360px] items-center gap-2">
        <div className="liquid-glass-dark flex flex-1 rounded-full p-[3px]">
          <button
            type="button"
            onClick={() => setActiveTab('foryou')}
            className={`flex-1 rounded-full py-1.5 text-[12px] font-semibold transition-all duration-300 ease-out ${
              activeTab === 'foryou'
                ? 'bg-white/75 text-slate-900 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)]'
                : 'bg-transparent text-white/45 hover:text-white/70'
            }`}
          >
            Für dich
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('inspiration')}
            className={`flex-1 rounded-full py-1.5 text-[12px] font-semibold transition-all duration-300 ease-out ${
              activeTab === 'inspiration'
                ? 'bg-white/75 text-slate-900 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)]'
                : 'bg-transparent text-white/45 hover:text-white/70'
            }`}
          >
            Inspiration
          </button>
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="liquid-glass-dark flex h-9 w-9 items-center justify-center rounded-full text-white/70"
          aria-label="Reels durchsuchen"
        >
          <Search size={16} aria-hidden />
        </button>
      </div>
    </div>
  )

  return (
    <AudioSessionProvider>
    <AppShell
      active="explore"
      bottomNavVariant="immersive"
      hideBottomNav={searchOpen}
      header={anyReelOverlayOpen ? undefined : header}
      className={searchOpen ? 'bg-canvas' : 'bg-black'}
      immersive
      // PR-D: hide the browser's vertical scroll indicator on the reel
      // feed container. The vertical-snap card list is its own UI; a
      // 4-6px scrollbar competing with the right-action-rail looked off.
      // (Search overlay still wants the scrollbar — only apply on feed.)
      mainClassName={searchOpen ? undefined : 'reels-no-scrollbar'}
      mainStyle={{
        height: searchOpen ? '100dvh' : 'calc(100dvh - var(--bottom-nav-immersive-h))',
        minHeight: searchOpen ? '100dvh' : 'calc(100dvh - var(--bottom-nav-immersive-h))',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollSnapType: searchOpen ? undefined : 'y mandatory',
        overscrollBehaviorY: 'contain',
      }}
    >
      {searchOpen ? (
        <ExploreSearchScreen
          query={searchQuery}
          results={searchResults}
          feedReels={reels}
          discoveryProviders={discoveryProviders}
          onQueryChange={setSearchQuery}
          onClose={() => {
            setSearchOpen(false)
            setSearchQuery('')
          }}
          onSelectReel={(reelId) => {
            setSearchOpen(false)
            setSearchQuery('')
            setSearchParams({ reel: reelId })
          }}
        />
      ) : (
        // PR-D crossfade: re-keying on activeTab makes React remount this
        // subtree so the fade-in keyframe replays on every tab toggle.
        // Pure opacity (no transform) so the underlying scroll-snap
        // container does not visibly shift mid-animation.
        <div key={activeTab} className="reel-tab-fade-in">
          {feedError && (
            <div
              className="flex flex-col items-center justify-center gap-3 px-6 text-center"
              style={{ height: 'calc(100dvh - var(--bottom-nav-immersive-h))' }}
            >
              <p className="text-[14px] text-white/70">{feedError}</p>
              <button
                type="button"
                onClick={() => setFeedLoadEpoch((n) => n + 1)}
                disabled={feedLoading}
                className="rounded-full bg-white/15 px-5 py-2.5 text-[14px] font-semibold text-white/90 backdrop-blur-sm disabled:opacity-50"
              >
                {feedLoading ? 'Wird geladen…' : 'Erneut versuchen'}
              </button>
            </div>
          )}
          {!feedError && feedLoading && reels.length === 0 && (
            <div
              className="flex items-center justify-center"
              style={{ height: 'calc(100dvh - var(--bottom-nav-immersive-h))' }}
              aria-label="Reels werden geladen"
            >
              <Spinner size="lg" tone="onDark" />
            </div>
          )}
          {!feedError && !feedLoading && reels.length === 0 && (
            <div
              className="flex flex-col items-center justify-center px-8 text-center"
              style={{ height: 'calc(100dvh - var(--bottom-nav-immersive-h))' }}
            >
              <div className="mb-4 text-[48px] leading-none">🎬</div>
              <h2 className="text-[18px] font-semibold text-white/90">Noch keine Reels</h2>
              <p className="mt-2 max-w-[280px] text-[14px] leading-relaxed text-white/50">
                Sobald Handwerker Arbeitsproben hochladen, erscheinen sie hier.
              </p>
            </div>
          )}
          {!feedError &&
            reels.map((reel, i) => {
              // Clamp guards the frame after a shorter feed arrives but before
              // the observer re-derives activeIndex (stale index > new length).
              const clampedActive =
                reels.length > 0 ? Math.min(activeIndex, reels.length - 1) : 0
              const inWindow = Math.abs(i - clampedActive) <= VIRTUAL_WINDOW
              // Preload the active reel + the forward neighbor only (swipe
              // direction) so the next swipe plays instantly without warming
              // every transient neighbor's full video on cellular.
              const videoPreload: 'auto' | 'metadata' =
                i === clampedActive || i === clampedActive + 1 ? 'auto' : 'metadata'
              return (
                <div
                  key={reel.id}
                  data-index={i}
                  ref={(node) => {
                    reelRefs.current[reel.id] = node
                    cellRefs.current[i] = node
                  }}
                  style={{
                    height: 'calc(100dvh - var(--bottom-nav-immersive-h))',
                    scrollSnapAlign: 'start',
                    scrollSnapStop: 'always',
                  }}
                >
                  <div className="h-full w-full">
                    {inWindow ? (
                      <ExploreReelCard
                        reel={reel}
                        viewerRole={appContext}
                        videoPreload={videoPreload}
                        active={i === clampedActive}
                        feedVisible={isActive && !searchOpen}
                        onOverlayOpenChange={handleOverlayOpenChange}
                      />
                    ) : (
                      <ReelPlaceholder reel={reel} />
                    )}
                  </div>
                </div>
              )
            })}
          {/* Bottom region: infinite-scroll sentinel + tail feedback. The
              IntersectionObserver (rootMargin 400px) triggers the next page
              before this scrolls into view; the spinner / "alles gesehen"
              marker replace the previous silent stop. */}
          {!feedError && nextCursor !== null && reels.length > 0 && (
            <div
              ref={bottomSentinelRef}
              className="flex items-center justify-center py-8"
              aria-hidden={!loadingMore}
              aria-label="Mehr Reels werden geladen"
            >
              {loadingMore && <Spinner size="md" tone="onDark" />}
            </div>
          )}
          {!feedError && reels.length > 0 && nextCursor === null && (
            <div
              className="flex flex-col items-center justify-center gap-1 px-8 text-center"
              style={{
                height: 'calc(100dvh - var(--bottom-nav-immersive-h))',
                scrollSnapAlign: 'start',
                scrollSnapStop: 'always',
              }}
            >
              <p className="text-[15px] font-semibold text-white/70">Du hast alles gesehen</p>
              <p className="text-[12px] text-white/35">Schau später für neue Reels vorbei</p>
            </div>
          )}
        </div>
      )}
    </AppShell>
    </AudioSessionProvider>
  )
}
