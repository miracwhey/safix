import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, MoreHorizontal, Share2 } from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import ExploreProfileHeaderCard from '../components/explore/ExploreProfileHeaderCard'
import TradeHighlightsRow from '../components/explore/TradeHighlightsRow'
import HighlightsRow from '../components/explore/HighlightsRow'
import HighlightStoryViewer from '../components/explore/HighlightStoryViewer'
import ProfileTabBar from '../components/explore/ProfileTabBar'
import type { ProfileTabKey } from '../components/explore/ProfileTabBar'
import ProfilePortfolioGrid from '../components/explore/ProfilePortfolioGrid'
import ProfileReviewsTab from '../components/explore/ProfileReviewsTab'
import PortfolioLightbox from '../components/explore/PortfolioLightbox'
import { getShareReelParamName } from '../lib/media/sharePortfolioItem'
import {
  getExploreCraftsmanProfile,
} from '../lib/explore/exploreProfileService'
import type { ExploreCraftsmanProfile } from '../lib/explore/exploreProfileService'
import { fetchLikeCountsForMedia } from '../lib/providerMedia/portfolioStatsSelectors'
import ReportUserSheet from '../components/moderation/ReportUserSheet'
import BlockConfirmDialog from '../components/moderation/BlockConfirmDialog'
import { supabase } from '../lib/supabase'
import { isUserBlocked } from '../lib/moderation/moderationService'
import { startProfileInquiryWorkflow } from '../lib/workflow'
import { shareProfile } from '../lib/media/sharePortfolioItem'
import { getPublicWebOrigin } from '../lib/platform'

export default function ExploreCraftsmanProfileScreen() {
  const { craftsmanId } = useParams<{ craftsmanId: string }>()
  const navigate = useNavigate()
  const goBack = useSmartBack('/explore')
  const [searchParams, setSearchParams] = useSearchParams()

  const [profile, setProfile] = useState<ExploreCraftsmanProfile | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [showReport, setShowReport] = useState(false)
  const [showBlock, setShowBlock] = useState(false)
  const [showOverflowMenu, setShowOverflowMenu] = useState(false)
  const [isBlocked, setIsBlocked] = useState(false)
  const [activeTab, setActiveTab] = useState<ProfileTabKey>('portfolio')
  const [portfolioFilter, setPortfolioFilter] = useState<string | null>(null)
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({})
  const [showStickyCta, setShowStickyCta] = useState(false)
  const [stickyInquiryPending, setStickyInquiryPending] = useState(false)
  const [shareToast, setShareToast] = useState<string | null>(null)
  const [stickyInquiryError, setStickyInquiryError] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [highlightViewerIndex, setHighlightViewerIndex] = useState<number | null>(null)

  const headerSentinelRef = useRef<HTMLDivElement | null>(null)

  const closeReport = useCallback(() => setShowReport(false), [])
  const closeBlock = useCallback(() => setShowBlock(false), [])

  // Profile + auth + block-state loader. Reused by the initial-mount path
  // and by the visibilitychange refresh below so a customer who keeps a
  // craftsman profile open and backgrounds the app does not see stale
  // Reels when they come back. `silent` skips the loading spinner so the
  // resume path never flashes a placeholder over already-rendered content.
  const loadProfileBundle = useCallback(
    async (id: string, opts: { silent?: boolean } = {}) => {
      const silent = opts.silent ?? false
      if (!silent) setLoading(true)
      try {
        const [result, { data: { user } }, blocked] = await Promise.all([
          getExploreCraftsmanProfile(id),
          supabase.auth.getUser(),
          isUserBlocked(id).catch(() => false),
        ])
        setProfile(result)
        setCurrentUserId(user?.id ?? null)
        setIsBlocked(blocked)
        setError(false)
      } catch {
        if (!silent) setError(true)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [],
  )

  // Initial load on mount / craftsmanId change.
  useEffect(() => {
    if (!craftsmanId) {
      navigate('/explore', { replace: true })
      return
    }
    let cancelled = false
    void (async () => {
      await loadProfileBundle(craftsmanId)
      if (cancelled) {
        // setters are no-ops on stale instances — placeholder for future
        // imperative cleanup (subscriptions etc.) without rewriting the
        // useEffect skeleton.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [craftsmanId, navigate, loadProfileBundle])

  // Silent refresh when the tab regains focus. Without this, a customer
  // who opens a craftsman's Reels and backgrounds the app never sees new
  // uploads from that craftsman until they navigate away and back.
  useEffect(() => {
    if (!craftsmanId) return
    if (typeof document === 'undefined') return
    const handler = () => {
      if (document.visibilityState === 'visible') {
        void loadProfileBundle(craftsmanId, { silent: true })
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [craftsmanId, loadProfileBundle])

  // Deep-link: `?reel={portfolioItemId}` opens the lightbox at that item.
  // Reading happens after the profile load finishes so we can resolve the
  // id to an index. Once consumed, we strip the param so the lightbox does
  // not reopen if the user closes it and the URL state stays clean for
  // subsequent navigation.
  useEffect(() => {
    if (!profile) return
    const requestedReelId = searchParams.get(getShareReelParamName())
    if (!requestedReelId) return
    const idx = profile.portfolioItems.findIndex((item) => item.id === requestedReelId)
    if (idx < 0) {
      // Stale or moderation-removed reel — drop the param silently.
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.delete(getShareReelParamName())
          return next
        },
        { replace: true },
      )
      return
    }
    setLightboxIndex(idx)
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete(getShareReelParamName())
        return next
      },
      { replace: true },
    )
  }, [profile, searchParams, setSearchParams])

  // Batch like-count fetch once portfolio items are known
  useEffect(() => {
    if (!profile || profile.portfolioItems.length === 0) return
    let cancelled = false
    const ids = profile.portfolioItems.map((it) => it.id)
    void fetchLikeCountsForMedia(ids).then((counts) => {
      if (!cancelled) setLikeCounts(counts)
    })
    return () => {
      cancelled = true
    }
  }, [profile])

  // Observe header sentinel → toggle sticky CTA
  useEffect(() => {
    const target = headerSentinelRef.current
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setShowStickyCta(!entry.isIntersecting)
      },
      { rootMargin: '-72px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [profile])

  const averageRating = useMemo(() => {
    if (!profile) return 0
    let total = 0
    let count = 0
    for (const bucket of profile.ratingDistribution) {
      total += bucket.stars * bucket.count
      count += bucket.count
    }
    return count > 0 ? total / count : 0
  }, [profile])

  // Tap auf eine Gewerk-Bubble (TradeHighlightsRow) → Portfolio-Tab + Filter.
  // Deferred: Das Redesign „Handwerker Reels Profil" zeigt nur noch die
  // benannten Highlights über den Tabs + die Chip-Filter im Grid; die
  // Gewerk-Bubble-Reihe ist aus dem Render genommen. Komponente, Datenfeld
  // (`tradeHighlights`) und Handler bleiben für eine spätere Rückkehr erhalten.
  // Siehe ~/.claude/plans/deferred-explore-profile.md
  const handleSelectTrade = useCallback((trade: string) => {
    setPortfolioFilter(trade)
    setActiveTab('portfolio')
  }, [])
  void TradeHighlightsRow
  void handleSelectTrade

  const handleShare = useCallback(async () => {
    if (!profile) return
    const outcome = await shareProfile({
      craftsmanId: profile.craftsmanId,
      craftsmanName: profile.craftsmanName,
      origin: getPublicWebOrigin(),
    })
    if (outcome.kind === 'copied') {
      setShareToast('Link kopiert')
      setTimeout(() => setShareToast(null), 2500)
    }
  }, [profile])

  const handleStickyInquiry = useCallback(async () => {
    if (!profile || stickyInquiryPending) return
    setStickyInquiryPending(true)
    setStickyInquiryError(null)
    try {
      const threadId = await startProfileInquiryWorkflow(profile)
      navigate(`/messages/${threadId}`)
    } catch (err) {
      // Surface the workflow's own message (e.g. daily-limit) so a failed
      // sticky inquiry is never silent — mirrors the header CTA's inline
      // error handling instead of swallowing it in console.error.
      console.error('[ExploreCraftsmanProfileScreen] sticky inquiry failed', err)
      const msg = err instanceof Error && err.message.trim().length > 0
        ? err.message
        : 'Anfrage konnte nicht gestartet werden. Bitte versuche es erneut.'
      setStickyInquiryError(msg)
      setTimeout(() => setStickyInquiryError(null), 4000)
    } finally {
      setStickyInquiryPending(false)
    }
  }, [profile, stickyInquiryPending, navigate])

  if (loading) {
    return (
      <AppShell active="explore" className="bg-canvas">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] flex items-center justify-center py-20">
            <span className="text-ink-muted text-[14px]">Lade Profil …</span>
          </div>
        </section>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell active="explore" className="bg-canvas">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] space-y-4">
            <button
              type="button"
              onClick={goBack}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm ring-1 ring-edge"
            >
              <ArrowLeft size={18} className="text-ink" aria-hidden />
            </button>
            <p className="text-ink-sub text-[14px]">Profil konnte nicht geladen werden.</p>
          </div>
        </section>
      </AppShell>
    )
  }

  if (!profile) {
    return (
      <AppShell active="explore" className="bg-canvas">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] space-y-4">
            <button
              type="button"
              onClick={goBack}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm ring-1 ring-edge"
            >
              <ArrowLeft size={18} className="text-ink" aria-hidden />
            </button>
            <p className="text-ink-sub text-[14px]">Profil nicht verfügbar.</p>
          </div>
        </section>
      </AppShell>
    )
  }

  const isOwnProfile = currentUserId !== null && currentUserId === profile.craftsmanId
  const reviewsCount = profile.ratingDistribution.reduce((sum, b) => sum + b.count, 0)

  return (
    <AppShell active="explore" className="bg-canvas" noSafeTop>
      <section className="relative pb-6">
        {/* Sticky Topbar (compact 48px + iOS safe-area; tab bar pins below) */}
        <div className="sticky top-0 z-40 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-end justify-between gap-2 bg-canvas/95 px-3 pb-2 backdrop-blur">
          <button
            type="button"
            onClick={goBack}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
            aria-label="Zurück"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <span className="truncate text-[13px] font-semibold text-ink">
            {profile.craftsmanHandle}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleShare()}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
              aria-label="Profil teilen"
            >
              <Share2 size={16} className="text-ink" aria-hidden />
            </button>
            {!isOwnProfile && (
              <button
                type="button"
                onClick={() => setShowOverflowMenu(true)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
                aria-label="Mehr Optionen"
              >
                <MoreHorizontal size={18} className="text-ink" aria-hidden />
              </button>
            )}
          </div>
        </div>

        {/* Profile content — eine verbundene weiße Sheet-Fläche (Header →
            Highlights → Tabs → Portfolio/Stimmen) mit runder Oberkante wie im
            Design „Handwerker Reels Profil". Kein overflow-hidden, damit die
            Tab-Bar weiter sticky an den Topbar andocken kann. */}
        <div className="mx-auto w-full max-w-[420px]">
          <div className="rounded-t-[26px] bg-white shadow-[0_8px_24px_-18px_rgba(2,6,23,0.25)]">
            <ExploreProfileHeaderCard profile={profile} averageRating={averageRating} />

            {profile.highlights.length > 0 && (
              <HighlightsRow
                highlights={profile.highlights}
                onOpen={(idx) => setHighlightViewerIndex(idx)}
              />
            )}

            {/* Sentinel marks end of header — collapses sticky CTA on scroll past */}
            <div ref={headerSentinelRef} aria-hidden className="h-px w-full" />

            <ProfileTabBar
              active={activeTab}
              onChange={setActiveTab}
              portfolioCount={profile.portfolioItems.length}
              reviewsCount={reviewsCount}
            />

            <div>
              {activeTab === 'portfolio' && (
                <ProfilePortfolioGrid
                  items={profile.portfolioItems}
                  activeFilter={portfolioFilter}
                  onActiveFilterChange={setPortfolioFilter}
                  likeCounts={likeCounts}
                  onSelect={(item) => {
                    const idx = profile.portfolioItems.findIndex((p) => p.id === item.id)
                    if (idx >= 0) setLightboxIndex(idx)
                  }}
                />
              )}
              {activeTab === 'stimmen' && (
                <ProfileReviewsTab
                  providerUserId={profile.craftsmanId}
                  ratingDistribution={profile.ratingDistribution}
                  ratingCount={profile.ratingCount}
                  averageRating={averageRating}
                  wouldHireAgainCount={profile.stats.wouldHireAgainCount}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Sticky Anfragen-CTA when scrolled past header */}
      {showStickyCta && !isOwnProfile ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
          <div className="pointer-events-auto mx-auto w-full max-w-[420px] rounded-card bg-white/95 p-2 shadow-[0_-4px_18px_-8px_rgba(2,6,23,0.18)] ring-1 ring-edge backdrop-blur">
            <div className="flex items-center gap-2">
              {profile.craftsmanAvatarUrl ? (
                <img
                  src={profile.craftsmanAvatarUrl}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover ring-1 ring-edge"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-[12px] font-semibold text-slate-500 ring-1 ring-edge">
                  {profile.craftsmanName.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-ink">
                  {profile.craftsmanName}
                </p>
                <p className="truncate text-[11px] text-ink-muted">
                  {profile.primaryCategory || 'Handwerker'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleStickyInquiry}
                disabled={stickyInquiryPending}
                className="rounded-card bg-brand px-3 py-1.5 text-[12px] font-semibold text-white transition active:scale-[0.97] disabled:opacity-60"
              >
                {stickyInquiryPending ? 'Sende …' : 'Anfragen →'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Overflow action sheet */}
      {showOverflowMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          onClick={() => setShowOverflowMenu(false)}
        >
          <div
            className="w-full max-w-[430px] rounded-t-[24px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300" />
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => { setShowOverflowMenu(false); setShowReport(true) }}
                className="w-full rounded-2xl px-4 py-3.5 text-left text-[15px] font-medium text-slate-700 transition active:bg-slate-50"
              >
                Profil melden
              </button>
              <button
                type="button"
                onClick={() => { setShowOverflowMenu(false); setShowBlock(true) }}
                className="w-full rounded-2xl px-4 py-3.5 text-left text-[15px] font-medium text-rose-600 transition active:bg-rose-50"
              >
                {isBlocked ? 'Nutzer entblocken' : 'Nutzer blockieren'}
              </button>
              <div className="my-2 h-px bg-slate-100" />
              <button
                type="button"
                onClick={() => setShowOverflowMenu(false)}
                className="w-full rounded-2xl px-4 py-3.5 text-center text-[15px] font-medium text-slate-500 transition active:bg-slate-50"
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}

      {showReport && (
        <ReportUserSheet
          targetUserId={profile.craftsmanId}
          targetLabel={profile.craftsmanName}
          onClose={closeReport}
        />
      )}

      {showBlock && (
        <BlockConfirmDialog
          targetUserId={profile.craftsmanId}
          targetLabel={profile.craftsmanName}
          isBlocked={isBlocked}
          onClose={closeBlock}
          onToggled={setIsBlocked}
        />
      )}

      <PortfolioLightbox
        open={lightboxIndex !== null}
        items={profile.portfolioItems}
        startIndex={lightboxIndex ?? 0}
        likeCounts={likeCounts}
        currentUserId={currentUserId}
        providerOwnerUserId={profile.craftsmanId}
        onClose={() => setLightboxIndex(null)}
      />

      {shareToast && (
        <div className="pointer-events-none fixed inset-x-0 top-[max(60px,calc(env(safe-area-inset-top)+16px))] z-50 flex justify-center px-4">
          <div className="rounded-full bg-ink/90 px-4 py-2 text-[13px] font-medium text-white shadow-lg backdrop-blur-sm">
            {shareToast}
          </div>
        </div>
      )}

      {stickyInquiryError && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(84px,calc(env(safe-area-inset-bottom)+76px))] z-50 flex justify-center px-4">
          <div
            role="alert"
            className="max-w-[420px] rounded-card bg-rose-600/95 px-4 py-2 text-[13px] font-medium text-white shadow-lg backdrop-blur-sm"
          >
            {stickyInquiryError}
          </div>
        </div>
      )}

      {highlightViewerIndex !== null && profile.highlights.length > 0 && (
        <HighlightStoryViewer
          highlights={profile.highlights}
          startHighlightIndex={highlightViewerIndex}
          providerName={profile.craftsmanName}
          providerAvatarUrl={profile.craftsmanAvatarUrl}
          onClose={() => setHighlightViewerIndex(null)}
        />
      )}
    </AppShell>
  )
}
