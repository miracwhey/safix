import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  PenLine,
  Eye,
  Plus,
  ShieldCheck,
  Users,
  ChevronRight,
  MoreHorizontal,
  Settings,
  Sparkles,
  Share2,
  Check,
  X,
} from 'lucide-react'
import { isTaxProfileComplete, hasBankingDetails } from '../lib/providers/taxProfileSelectors'
import AppShell from '../components/AppShell'
import { getMyCraftsmanBusinessProfile, upsertCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import { updateProviderProfile } from '../lib/providers/providerProfileService'
import { shareProfile } from '../lib/media/sharePortfolioItem'
import { getPublicWebOrigin } from '../lib/platform'
import type { CraftsmanBusinessProfile } from '../lib/craftsman/types'
import AvatarUpload from '../components/media/AvatarUpload'
import InlineFeedback from '../components/system/InlineFeedback'
import ProfileTabBar from '../components/explore/ProfileTabBar'
import type { ProfileTabKey } from '../components/explore/ProfileTabBar'
import ProfilePortfolioGrid from '../components/explore/ProfilePortfolioGrid'
import ProfileReviewsTab from '../components/explore/ProfileReviewsTab'
import HighlightsRow from '../components/explore/HighlightsRow'
import HighlightStoryViewer from '../components/explore/HighlightStoryViewer'
import InstaProfileHeader, {
  type InstaProfileAction,
} from '../components/profile/InstaProfileHeader'
import { formatStatNumber } from '../components/profile/instaStatFormat'
import {
  fetchOwnerPortfolio,
  deletePortfolioItem,
  mergePortfolioById,
} from '../lib/providerMedia/portfolioItemService'
import type { PortfolioItem } from '../lib/providerMedia/providerMediaTypes'
import {
  aggregateLikesForProvider,
  fetchLikeCountsForMedia,
} from '../lib/providerMedia/portfolioStatsSelectors'
import { fetchProviderRatingDistribution } from '../lib/ratings/ratingDistributionService'
import type { RatingDistributionBucket } from '../lib/ratings/ratingDistributionService'
import {
  fetchHighlightsForProvider,
  type ProviderHighlight,
} from '../lib/highlights/highlightRepository'
import { IMAGE_VIDEO_ACCEPT, resolveMediaType, validateMediaFile } from '../lib/media/mediaUploadService'
import AddWorkSampleSheet from '../components/portfolio/AddWorkSampleSheet'
import JobPickerForPortfolio from '../components/portfolio/JobPickerForPortfolio'
import PortfolioItemComposer from '../components/portfolio/PortfolioItemComposer'
import type { ComposerMediaSource, DraftAsset } from '../components/portfolio/PortfolioItemComposer'
import {
  subscribeRatings,
  getRatingsByProviderUserId,
  deriveProviderReputation,
  isRatingsHydrated,
} from '../lib/ratings'
import { useStoreSync } from '../lib/reactive'
import { logInfo, logError } from '../lib/observability'
import {
  deriveProviderResponseLatency,
  formatResponseLatencyLabel,
} from '../lib/messages/responseLatencySelector'
import { deriveProviderTrustProjection } from '../lib/trust'

// ---------------------------------------------------------------------------
// Item action sheet (owner edit / delete)
// ---------------------------------------------------------------------------
function ItemActionSheet({
  item,
  onEdit,
  onDelete,
  onClose,
}: {
  item: PortfolioItem
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[24px] bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-slate-300" />
        </div>
        <div className="px-4 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] space-y-2">
          <p className="px-1 pb-1 text-[12px] text-ink-muted truncate">
            {item.title ?? item.caption ?? 'Arbeitsprobe'}
          </p>
          <button
            type="button"
            onClick={() => { onEdit(); onClose() }}
            className="flex w-full items-center gap-3 rounded-xl bg-surface px-4 py-3.5 text-[14px] font-semibold text-ink ring-1 ring-edge transition active:bg-canvas"
          >
            Bearbeiten
          </button>
          <button
            type="button"
            onClick={() => { onDelete(); onClose() }}
            className="flex w-full items-center gap-3 rounded-xl bg-rose-50 px-4 py-3.5 text-[14px] font-semibold text-rose-600 ring-1 ring-rose-200 transition active:bg-rose-100"
          >
            Löschen
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Owner overflow menu (Steuern & Bank · Team · Profil-Form)
// ---------------------------------------------------------------------------
function OwnerOverflowSheet({
  profile,
  onEditFullProfile,
  onClose,
}: {
  profile: CraftsmanBusinessProfile
  onEditFullProfile: () => void
  onClose: () => void
}) {
  const tax = profile.taxProfile
  const taxComplete = useMemo(() => (tax ? isTaxProfileComplete(tax) : false), [tax])
  const bankPresent = useMemo(() => (tax ? hasBankingDetails(tax) : false), [tax])
  const taxStatus = taxComplete ? 'Steuerdaten vollständig' : 'Steuerdaten ergänzen'
  const taxTone = taxComplete
    ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    : 'bg-amber-50 text-amber-700 ring-amber-200'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[24px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300" />
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Profil verwalten
        </p>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => { onClose(); onEditFullProfile() }}
            className="flex w-full items-center gap-3 rounded-card bg-surface px-3 py-3 text-left ring-1 ring-edge/60 transition active:scale-[0.99]"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-canvas">
              <Settings size={16} className="text-ink-sub" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-[13px] font-semibold text-ink">Profil-Form bearbeiten</span>
              <p className="mt-0.5 text-[12px] text-ink-muted">Betriebsname, Bio, Trade-Liste, Telefon …</p>
            </div>
            <ChevronRight size={16} className="shrink-0 text-ink-muted" aria-hidden />
          </button>

          <Link
            to="/craftsman/highlights"
            onClick={onClose}
            className="flex items-center justify-between gap-3 rounded-card bg-surface px-3 py-3 ring-1 ring-edge/60 transition active:scale-[0.99]"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#2563EB]/10 text-[#2563EB]">
                <Sparkles size={16} aria-hidden />
              </div>
              <div className="min-w-0">
                <span className="text-[13px] font-semibold text-ink">Highlights verwalten</span>
                <p className="mt-0.5 text-[12px] text-ink-muted">Kuratierte Story-Sammlungen</p>
              </div>
            </div>
            <ChevronRight size={16} className="shrink-0 text-ink-muted" aria-hidden />
          </Link>

          <Link
            to="/craftsman/profile/tax-bank"
            onClick={onClose}
            className="flex items-center justify-between gap-3 rounded-card bg-surface px-3 py-3 ring-1 ring-edge/60 transition active:scale-[0.99]"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#2563EB]/10 text-[#2563EB]">
                <ShieldCheck size={16} aria-hidden />
              </div>
              <div className="min-w-0">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${taxTone}`}
                >
                  {taxStatus}
                </span>
                <p className="mt-1 text-[12px] text-ink-muted">
                  {tax?.isKleinunternehmer ? 'Kleinunternehmer · ' : ''}
                  {bankPresent ? 'IBAN hinterlegt' : 'Keine IBAN hinterlegt'}
                </p>
              </div>
            </div>
            <ChevronRight size={16} className="shrink-0 text-ink-muted" aria-hidden />
          </Link>

          <Link
            to="/craftsman/team"
            onClick={onClose}
            className="flex items-center justify-between gap-3 rounded-card bg-surface px-3 py-3 ring-1 ring-edge/60 transition active:scale-[0.99]"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#2563EB]/10 text-[#2563EB]">
                <Users size={16} aria-hidden />
              </div>
              <div className="min-w-0">
                <span className="text-[13px] font-semibold text-ink">
                  Beitritts-Code & Team
                </span>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  Code rotieren, Mitarbeiter einladen
                </p>
              </div>
            </div>
            <ChevronRight size={16} className="shrink-0 text-ink-muted" aria-hidden />
          </Link>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-card px-4 py-3 text-center text-[14px] font-semibold text-ink-sub transition active:bg-canvas"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline profile edit form
// ---------------------------------------------------------------------------
const TRADE_CATEGORIES = [
  'Elektrik', 'Sanitär', 'Bad', 'Fliesen', 'Schreinerei',
  'Malerei', 'Böden', 'Heizung', 'Dach', 'Garten', 'Küche', 'Trockenbau',
]

function InlineProfileEditForm({
  businessName, location, bio, phone, website, tradeCategories, error,
  onChangeBusinessName, onChangeLocation, onChangeBio, onChangePhone,
  onChangeWebsite, onChangeTradeCategories, avatarSlot,
}: {
  businessName: string
  location: string
  bio: string
  phone: string
  website: string
  tradeCategories: string[]
  error: string | null
  onChangeBusinessName: (v: string) => void
  onChangeLocation: (v: string) => void
  onChangeBio: (v: string) => void
  onChangePhone: (v: string) => void
  onChangeWebsite: (v: string) => void
  onChangeTradeCategories: (v: string[]) => void
  avatarSlot: ReactNode
}) {
  return (
    <div className="space-y-5 px-4 pb-8 pt-4">
      {/* Avatar row */}
      <div className="flex justify-center pt-2">{avatarSlot}</div>

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
          Betriebsname <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          value={businessName}
          onChange={(e) => onChangeBusinessName(e.target.value)}
          placeholder="z. B. Müller Elektrotechnik"
          className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
          autoComplete="organization"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
          Stadt / Standort <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          value={location}
          onChange={(e) => onChangeLocation(e.target.value)}
          placeholder="z. B. München"
          className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
          autoComplete="address-level2"
        />
      </div>

      <div>
        <label className="mb-2 block text-[12px] font-semibold text-ink-muted">
          Gewerke <span className="text-danger">*</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {TRADE_CATEGORIES.map((cat) => {
            const selected = tradeCategories.includes(cat)
            return (
              <button
                key={cat}
                type="button"
                onClick={() =>
                  onChangeTradeCategories(
                    selected ? tradeCategories.filter((c) => c !== cat) : [...tradeCategories, cat],
                  )
                }
                className={`rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition active:scale-[0.97] ${
                  selected ? 'bg-brand text-white ring-brand' : 'bg-surface text-ink ring-edge'
                }`}
              >
                {cat}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
          Kurzbeschreibung
        </label>
        <textarea
          value={bio}
          onChange={(e) => onChangeBio(e.target.value.slice(0, 300))}
          placeholder="Was macht deinen Betrieb besonders?"
          rows={3}
          className="w-full resize-none rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <p className="mt-1 text-right text-[11px] text-ink-muted">{bio.length} / 300</p>
      </div>

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
          Telefon (optional)
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => onChangePhone(e.target.value)}
          placeholder="+49 123 456789"
          className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
          autoComplete="tel"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
          Website (optional)
        </label>
        <input
          type="url"
          value={website}
          onChange={(e) => onChangeWebsite(e.target.value)}
          placeholder="z. B. www.mein-betrieb.de"
          className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
          autoComplete="url"
          inputMode="url"
        />
      </div>

      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function CraftsmanProfile() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<CraftsmanBusinessProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ProfileTabKey>('portfolio')
  const [portfolioFilter, setPortfolioFilter] = useState<string | null>(null)

  const [portfolioItems, setPortfolioItems] = useState<PortfolioItem[] | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({})
  const [likesTotal, setLikesTotal] = useState(0)
  const [ratingDistribution, setRatingDistribution] = useState<RatingDistributionBucket[]>(() =>
    [5, 4, 3, 2, 1].map((stars) => ({ stars: stars as 1 | 2 | 3 | 4 | 5, count: 0 })),
  )

  const [highlights, setHighlights] = useState<ProviderHighlight[]>([])
  const [highlightViewerIndex, setHighlightViewerIndex] = useState<number | null>(null)

  // Inline edit mode
  const [editMode, setEditMode] = useState(false)
  const [editingBusinessName, setEditingBusinessName] = useState('')
  const [editingLocation, setEditingLocation] = useState('')
  const [editingBio, setEditingBio] = useState('')
  const [editingPhone, setEditingPhone] = useState('')
  const [editingTradeCategories, setEditingTradeCategories] = useState<string[]>([])
  const [editingWebsite, setEditingWebsite] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [shareToast, setShareToast] = useState<string | null>(null)

  const [showAddSheet, setShowAddSheet] = useState(false)
  const [showJobPicker, setShowJobPicker] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)
  const [composerSource, setComposerSource] = useState<ComposerMediaSource | null>(null)
  const [menuItem, setMenuItem] = useState<PortfolioItem | null>(null)
  const [editingItem, setEditingItem] = useState<PortfolioItem | null>(null)

  // Avatar upload errors live here because AvatarUpload runs in compact
  // mode (no inline feedback area) and the InstaProfileHeader avatar slot
  // is too small for the message. The host renders the banner at the top
  // of the profile section so the user actually sees the failure.
  const [avatarError, setAvatarError] = useState<string | null>(null)

  const mediaInputRef = useRef<HTMLInputElement>(null)

  // Reactive ratings store (drives stat tile + reviews-tab fallback)
  const [reputation, setReputation] = useState({ averageRating: 0, ratingCount: 0 })
  useStoreSync([subscribeRatings], () => {
    if (!profile) return
    const rep = deriveProviderReputation(profile.userId, getRatingsByProviderUserId(profile.userId))
    setReputation({ averageRating: rep.averageRating, ratingCount: rep.ratingCount })
  })

  // Load owner profile + auto-refresh when the tab regains focus (e.g. after
  // returning from /craftsman/profile/edit so name/bio/avatar/trades stay in
  // sync without a full page reload).
  useEffect(() => {
    logInfo('ui.profile_opened', {})
    let cancelled = false

    const load = (initial: boolean) => {
      if (initial) setLoading(true)
      getMyCraftsmanBusinessProfile()
        .then((p) => {
          if (cancelled) return
          setProfile(p)
          setError(null)
          if (p && isRatingsHydrated()) {
            const rep = deriveProviderReputation(p.userId, getRatingsByProviderUserId(p.userId))
            setReputation({ averageRating: rep.averageRating, ratingCount: rep.ratingCount })
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          logError('ui.profile_load_failed', err, {})
          if (initial) setError('Profil konnte nicht geladen werden')
        })
        .finally(() => {
          if (!cancelled && initial) setLoading(false)
        })
    }

    load(true)

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        load(false)
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }
    return () => {
      cancelled = true
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [])

  // Portfolio + likes + rating distribution.
  //
  // Two trigger paths share one fetcher:
  //   1. Initial load when `providerId` becomes known. Shows the skeleton.
  //   2. Silent refresh on app resume (visibilitychange listener below)
  //      — the owner backgrounds the app, publishes from another device or
  //      receives new likes, then comes back. Without this the Reels grid
  //      would only re-sync on a full screen remount.
  //
  // `silent` controls whether the loading state flips so the resume
  // pathway never flashes a skeleton over an already-rendered grid.
  const loadPortfolioBundle = useCallback(
    async (providerId: string, userId: string, opts: { silent?: boolean } = {}) => {
      const silent = opts.silent ?? false
      if (!silent) {
        setPortfolioLoading(true)
        setPortfolioError(null)
      }
      try {
        const [items, likes, distribution, hls] = await Promise.all([
          fetchOwnerPortfolio(providerId),
          aggregateLikesForProvider(providerId),
          fetchProviderRatingDistribution(userId),
          fetchHighlightsForProvider(userId).catch(() => [] as ProviderHighlight[]),
        ])
        setPortfolioItems((prev) => (silent ? mergePortfolioById(prev, items) : items))
        setLikesTotal(likes)
        setRatingDistribution(distribution)
        setHighlights(hls)
        const ids = items.map((it) => it.id)
        const counts = await fetchLikeCountsForMedia(ids)
        setLikeCounts(counts)
      } catch (err) {
        logError('ui.profile_portfolio_load_failed', err, { providerId })
        if (!silent) {
          setPortfolioItems([])
          setPortfolioError('Arbeitsproben konnten nicht geladen werden.')
        }
      } finally {
        if (!silent) setPortfolioLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    const providerId = profile?.providerId
    const userId = profile?.userId
    if (!providerId || !userId) return
    let cancelled = false
    void (async () => {
      await loadPortfolioBundle(providerId, userId)
      if (cancelled) {
        // Caller unmounted while the fetch was in flight — nothing to
        // unwind because the setters above are no-ops on stale instances,
        // but the await keeps the close-over for diagnostics.
      }
    })()
    return () => { cancelled = true }
  }, [profile?.providerId, profile?.userId, loadPortfolioBundle])

  // Silent refresh when the tab regains focus. Owner publishes on phone A,
  // backgrounds, returns to phone B — the Reels grid catches up without a
  // full reload.
  useEffect(() => {
    const providerId = profile?.providerId
    const userId = profile?.userId
    if (!providerId || !userId) return
    if (typeof document === 'undefined') return
    const handler = () => {
      if (document.visibilityState === 'visible') {
        void loadPortfolioBundle(providerId, userId, { silent: true })
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [profile?.providerId, profile?.userId, loadPortfolioBundle])

  const handleAvatarUploaded = useCallback((publicUrl: string) => {
    setProfile((prev) => (prev ? { ...prev, avatarUrl: publicUrl } : prev))
  }, [])

  // Pre-upload gate: validate each file before opening the Composer so the
  // user sees a clear inline error instead of a generic PostgREST/Storage
  // failure during the publish step.
  const handleMediaFilesChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return

    const drafts: DraftAsset[] = []
    let firstError: string | null = null

    for (const file of files) {
      const validation = validateMediaFile(file)
      if (!validation.valid) {
        if (!firstError) firstError = validation.reason
        continue
      }
      const mediaType = resolveMediaType(file.type)
      const previewUrl = URL.createObjectURL(file)
      drafts.push({ id: crypto.randomUUID(), file, previewUrl, mediaType })
    }

    if (firstError) setPortfolioError(firstError)
    if (drafts.length > 0) {
      setComposerSource({ kind: 'files', drafts })
    }
  }, [])

  const handleAddFromGallery = useCallback(() => mediaInputRef.current?.click(), [])
  const handleAddFromJob = useCallback(() => setShowJobPicker(true), [])

  const handlePortfolioSaved = useCallback(async (item: PortfolioItem) => {
    // Optimistic update — keeps the grid responsive while the resync runs.
    if (editingItem) {
      setPortfolioItems((prev) => prev ? prev.map((i) => (i.id === item.id ? item : i)) : [item])
    } else {
      setPortfolioItems((prev) => (prev ? [item, ...prev] : [item]))
    }
    setComposerSource(null)
    setEditingItem(null)
    setPortfolioError(null)
    // Hard re-sync from the DB so the Reels and Portfolio tabs always reflect
    // the persisted state. We MERGE the result with the optimistic state via
    // mergePortfolioById instead of replacing — if PostgREST / replication
    // is briefly stale and does not yet include the just-inserted row, a
    // straight replace would erase the optimistic item from the grid for
    // the user. The merge keeps optimistic-only IDs at the head until the
    // next sync surfaces them.
    const providerId = profile?.providerId
    if (providerId) {
      try {
        const items = await fetchOwnerPortfolio(providerId)
        setPortfolioItems((prev) => mergePortfolioById(prev, items))
      } catch (err) {
        // Soft-fail: the optimistic update is already on screen, so we just
        // log and let the next mount-time / visibility fetch reconcile.
        console.warn('portfolio.resync_after_save_failed', err)
      }
    }
  }, [editingItem, profile?.providerId])

  const handleDelete = useCallback(async (item: PortfolioItem) => {
    setDeletingId(item.id)
    setDeleteError(null)
    try {
      await deletePortfolioItem(item.id, item.assets)
      setPortfolioItems((prev) => prev ? prev.filter((i) => i.id !== item.id) : prev)
    } catch (err) {
      console.error(err)
      setDeleteError('Löschen fehlgeschlagen')
    } finally {
      setDeletingId(null)
    }
  }, [])

  const handleMenuEdit = useCallback(() => {
    if (!menuItem) return
    setEditingItem(menuItem)
    setMenuItem(null)
  }, [menuItem])

  const handleMenuDelete = useCallback(() => {
    if (!menuItem) return
    void handleDelete(menuItem)
    setMenuItem(null)
  }, [menuItem, handleDelete])

  const handleSelectTradeFromGrid = useCallback((trade: string | null) => {
    setPortfolioFilter(trade)
  }, [])

  const openEditMode = useCallback(() => {
    if (!profile) return
    setEditingBusinessName(profile.businessName)
    setEditingLocation(profile.location)
    setEditingBio(profile.bio ?? '')
    setEditingPhone(profile.phone ?? '')
    setEditingWebsite(profile.website ?? '')
    setEditingTradeCategories(profile.tradeCategories)
    setEditError(null)
    setEditMode(true)
  }, [profile])

  const handleInlineEditSave = useCallback(async () => {
    if (!profile || editSaving) return
    const trimmedName = editingBusinessName.trim()
    const trimmedLocation = editingLocation.trim()
    if (!trimmedName || !trimmedLocation || editingTradeCategories.length === 0) return
    setEditSaving(true)
    setEditError(null)
    try {
      await updateProviderProfile({
        companyName: trimmedName,
        handle: profile.handle,
        city: trimmedLocation,
        description: editingBio.trim() || null,
        trades: editingTradeCategories,
        // Preserve the craftsman's visibility choice — an unrelated name/bio
        // edit must NOT silently re-publish a deliberately-hidden profile.
        isPublic: profile.isPublic,
      })
      try {
        await upsertCraftsmanBusinessProfile({
          businessName: trimmedName,
          handle: profile.handle,
          bio: editingBio.trim(),
          location: trimmedLocation,
          tradeCategories: editingTradeCategories,
          servicesOffered: profile.servicesOffered,
          serviceRadiusKm: profile.serviceRadiusKm,
          phone: editingPhone.trim() || undefined,
          website: editingWebsite.trim() || undefined,
          avatarUrl: profile.avatarUrl,
          yearsInBusiness: profile.yearsInBusiness,
        })
      } catch {
        // legacy write non-blocking
      }
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              businessName: trimmedName,
              location: trimmedLocation,
              bio: editingBio.trim() || undefined,
              tradeCategories: editingTradeCategories,
              phone: editingPhone.trim() || undefined,
              website: editingWebsite.trim() || undefined,
            }
          : prev,
      )
      setEditMode(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Speichern fehlgeschlagen'
      setEditError(msg)
    } finally {
      setEditSaving(false)
    }
  }, [profile, editSaving, editingBusinessName, editingLocation, editingBio, editingPhone, editingWebsite, editingTradeCategories])

  const handleShare = useCallback(async () => {
    if (!profile) return
    const outcome = await shareProfile({
      craftsmanId: profile.userId,
      craftsmanName: profile.businessName,
      origin: getPublicWebOrigin(),
    })
    if (outcome.kind === 'copied') {
      setShareToast('Link kopiert')
      setTimeout(() => setShareToast(null), 2500)
    }
  }, [profile])

  if (loading) {
    return (
      <AppShell active="profile" noSafeTop>
        <div className="flex items-center justify-center pt-[max(80px,env(safe-area-inset-top))] py-16 text-[14px] text-ink-muted">
          Lade Profil…
        </div>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell active="profile" noSafeTop>
        <div className="px-4 pt-[max(80px,env(safe-area-inset-top))] py-6">
          <p className="text-[14px] text-red-500">{error}</p>
        </div>
      </AppShell>
    )
  }

  if (!profile) {
    return (
      <AppShell active="profile" noSafeTop>
        <div className="px-4 pt-[max(80px,env(safe-area-inset-top))] py-6">
          <p className="text-[14px] text-ink-muted">
            Kein Betriebsprofil gefunden. Bitte schliesse das Onboarding ab.
          </p>
        </div>
      </AppShell>
    )
  }

  const portfolioCount = portfolioItems?.length ?? 0
  const reviewsCount = ratingDistribution.reduce((sum, b) => sum + b.count, 0)
  const trust = deriveProviderTrustProjection({
    craftsmanUserId: profile.userId,
    completedJobsCount: profile.completedJobsCount ?? 0,
  })
  // Owner doesn't track its own „verified" flag here; the latency surrogate
  // falls back to the rating threshold path when verified is unknown.
  const responseLatencyLabel = formatResponseLatencyLabel(
    deriveProviderResponseLatency({
      craftsmanUserId: profile.userId,
      ratingCount: reputation.ratingCount,
      verified: false,
    }),
  )

  const avatarSlot = profile.providerId ? (
    <AvatarUpload
      currentAvatarUrl={profile.avatarUrl}
      displayName={profile.businessName}
      ownerUserId={profile.userId}
      providerId={profile.providerId}
      onUploaded={handleAvatarUploaded}
      onError={setAvatarError}
      variant="compact"
    />
  ) : profile.avatarUrl ? (
    <img
      src={profile.avatarUrl}
      alt={profile.businessName}
      className="h-[78px] w-[78px] rounded-full object-cover ring-2 ring-edge"
    />
  ) : (
    <div className="flex h-[78px] w-[78px] items-center justify-center rounded-full bg-brand/10 ring-2 ring-edge">
      <span className="text-[22px] font-semibold text-brand">
        {profile.businessName.slice(0, 2).toUpperCase()}
      </span>
    </div>
  )

  const ownerActions: InstaProfileAction[] = [
    {
      key: 'add-sample',
      label: '+ Arbeitsprobe',
      icon: Plus,
      variant: 'primary',
      onClick: () => { setActiveTab('portfolio'); setShowAddSheet(true) },
      disabled: !profile.providerId,
    },
    {
      key: 'edit-profile',
      label: 'Bearbeiten',
      icon: PenLine,
      variant: 'icon',
      onClick: () => {
        logInfo('ui.profile_edit_opened', {})
        openEditMode()
      },
      ariaLabel: 'Profil bearbeiten',
    },
    {
      key: 'share-profile',
      label: 'Teilen',
      icon: Share2,
      variant: 'icon',
      onClick: () => void handleShare(),
      ariaLabel: 'Profil teilen',
    },
  ]

  if (profile.providerId && profile.onboardingCompleted) {
    ownerActions.push({
      key: 'preview',
      label: 'Vorschau',
      icon: Eye,
      variant: 'icon',
      onClick: () => navigate(`/explore/craftsman/${profile.userId}`),
      ariaLabel: 'Customer-Vorschau',
    })
  }

  const stats: [{ value: string; label: string }, { value: string; label: string }, { value: string; label: string }] = [
    { value: formatStatNumber(portfolioCount), label: 'Portfolio' },
    { value: formatStatNumber(likesTotal), label: 'Likes' },
    {
      value: reputation.ratingCount > 0 ? `★ ${reputation.averageRating.toFixed(1)}` : '★ –',
      label: `${reputation.ratingCount} Bew.`,
    },
  ]

  return (
    <AppShell active="profile" noSafeTop>
      <section className="relative pb-6">
        {/* Sticky Topbar */}
        <div className="sticky top-0 z-40 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-end gap-2 bg-canvas/95 px-3 pb-2 backdrop-blur">
          {editMode ? (
            <>
              <button
                type="button"
                onClick={() => setEditMode(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
                aria-label="Abbrechen"
              >
                <X size={16} className="text-ink" aria-hidden />
              </button>
              <span className="flex-1 text-[15px] font-semibold text-ink">Profil bearbeiten</span>
              <button
                type="button"
                onClick={() => void handleInlineEditSave()}
                disabled={!editingBusinessName.trim() || !editingLocation.trim() || editingTradeCategories.length === 0 || editSaving}
                className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                <Check size={14} aria-hidden />
                {editSaving ? 'Sichern …' : 'Sichern'}
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 truncate text-[13px] font-semibold text-ink">
                {profile.handle}
              </span>
              <button
                type="button"
                onClick={() => setShowOverflow(true)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
                aria-label="Profil verwalten"
              >
                <MoreHorizontal size={18} className="text-ink" aria-hidden />
              </button>
            </>
          )}
        </div>

        <div className="mx-auto w-full max-w-[420px]">
          {editMode ? (
            <InlineProfileEditForm
              businessName={editingBusinessName}
              location={editingLocation}
              bio={editingBio}
              phone={editingPhone}
              website={editingWebsite}
              tradeCategories={editingTradeCategories}
              error={editError}
              onChangeBusinessName={setEditingBusinessName}
              onChangeLocation={setEditingLocation}
              onChangeBio={setEditingBio}
              onChangePhone={setEditingPhone}
              onChangeWebsite={setEditingWebsite}
              onChangeTradeCategories={setEditingTradeCategories}
              avatarSlot={avatarSlot}
            />
          ) : (
            <div className="rounded-t-[26px] bg-white shadow-[0_8px_24px_-18px_rgba(2,6,23,0.25)]">
              <InstaProfileHeader
                name={profile.businessName}
                handle={profile.handle}
                bio={profile.bio}
                tradeCategories={profile.tradeCategories}
                location={profile.location}
                serviceRadiusKm={profile.serviceRadiusKm}
                stats={stats}
                responseLatencyLabel={responseLatencyLabel}
                trustBadges={trust.badges}
                actions={ownerActions}
                avatarSlot={avatarSlot}
              />

              {avatarError ? (
                <div className="px-4 pt-2">
                  <InlineFeedback
                    error={avatarError}
                    onDismiss={() => setAvatarError(null)}
                  />
                </div>
              ) : null}

              <HighlightsRow
                highlights={highlights}
                onOpen={(idx) => setHighlightViewerIndex(idx)}
                isOwner
                onAddNew={() => navigate('/craftsman/highlights/new')}
              />

              <div aria-hidden className="h-px w-full" />

              <ProfileTabBar
                active={activeTab}
                onChange={setActiveTab}
                portfolioCount={portfolioCount}
                reviewsCount={reviewsCount}
              />

              <div>
                {activeTab === 'portfolio' && (
                  portfolioLoading ? (
                    <div className="grid grid-cols-3 gap-[2px] bg-slate-100">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div
                          key={i}
                          className="aspect-[3/4] animate-pulse bg-slate-200"
                        />
                      ))}
                    </div>
                  ) : (
                    <ProfilePortfolioGrid
                      items={portfolioItems ?? []}
                      activeFilter={portfolioFilter}
                      onActiveFilterChange={handleSelectTradeFromGrid}
                      likeCounts={likeCounts}
                      onSelect={(item) => setMenuItem(item)}
                    />
                  )
                )}

                {activeTab === 'stimmen' && (
                  <ProfileReviewsTab
                    providerUserId={profile.userId}
                    ratingDistribution={ratingDistribution}
                    ratingCount={reputation.ratingCount}
                    averageRating={reputation.averageRating}
                    wouldHireAgainCount={trust.wouldHireAgainCount}
                  />
                )}
              </div>

              {portfolioError ? (
                <div
                  role="alert"
                  className="mx-4 mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[12px] text-rose-700 ring-1 ring-rose-200"
                >
                  {portfolioError}
                  <button
                    type="button"
                    onClick={() => setPortfolioError(null)}
                    className="ml-2 font-semibold underline"
                  >
                    OK
                  </button>
                </div>
              ) : null}

              {deleteError ? (
                <div className="mx-4 mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[12px] text-rose-700 ring-1 ring-rose-200">
                  {deleteError}
                  <button
                    type="button"
                    onClick={() => setDeleteError(null)}
                    className="ml-2 font-semibold underline"
                  >
                    OK
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {shareToast && (
        <div className="pointer-events-none fixed inset-x-0 top-[max(60px,calc(env(safe-area-inset-top)+16px))] z-50 flex justify-center px-4">
          <div className="rounded-full bg-ink/90 px-4 py-2 text-[13px] font-medium text-white shadow-lg backdrop-blur-sm">
            {shareToast}
          </div>
        </div>
      )}

      {/* Hidden file input — multi-select gallery (images + videos) */}
      <input
        ref={mediaInputRef}
        type="file"
        accept={IMAGE_VIDEO_ACCEPT}
        multiple
        className="hidden"
        onChange={handleMediaFilesChange}
      />

      {/* Bottom sheets / flows */}
      {showAddSheet && (
        <AddWorkSampleSheet
          onClose={() => setShowAddSheet(false)}
          onSelectFromGallery={handleAddFromGallery}
          onSelectFromJob={handleAddFromJob}
        />
      )}

      {showJobPicker && (
        <JobPickerForPortfolio
          onClose={() => setShowJobPicker(false)}
          onPhotoSelected={(selection) => {
            setShowJobPicker(false)
            setComposerSource({ kind: 'job', selection })
          }}
        />
      )}

      {composerSource !== null && profile.providerId && (
        <PortfolioItemComposer
          mode="create"
          providerId={profile.providerId}
          ownerUserId={profile.userId}
          mediaSource={composerSource}
          providerTradeTags={profile.tradeCategories}
          onClose={() => setComposerSource(null)}
          onSaved={handlePortfolioSaved}
        />
      )}

      {editingItem !== null && (
        <PortfolioItemComposer
          mode="edit"
          item={editingItem}
          providerTradeTags={profile.tradeCategories}
          onClose={() => setEditingItem(null)}
          onSaved={handlePortfolioSaved}
        />
      )}

      {menuItem !== null && (
        <ItemActionSheet
          item={menuItem}
          onEdit={handleMenuEdit}
          onDelete={handleMenuDelete}
          onClose={() => setMenuItem(null)}
        />
      )}

      {showOverflow && (
        <OwnerOverflowSheet
          profile={profile}
          onEditFullProfile={() => openEditMode()}
          onClose={() => setShowOverflow(false)}
        />
      )}

      {deletingId !== null ? (
        <span className="sr-only" role="status" aria-live="polite">
          Lösche Arbeitsprobe…
        </span>
      ) : null}

      {highlightViewerIndex !== null && highlights.length > 0 && (
        <HighlightStoryViewer
          highlights={highlights}
          startHighlightIndex={highlightViewerIndex}
          providerName={profile.businessName}
          providerAvatarUrl={profile.avatarUrl}
          onClose={() => setHighlightViewerIndex(null)}
        />
      )}
    </AppShell>
  )
}
