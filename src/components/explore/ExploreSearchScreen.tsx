/**
 * ExploreSearchScreen — redesigned in-reels search.
 *
 * Drop-in replacement for `ExploreSearchOverlay`: keeps the same prop contract
 * and adds optional `feedReels` + `userCity`. Wires the real trade-aware search
 * engine (`rankDiscoveryProviders` / `rankReels`) — no mock data.
 *
 * Reality gaps vs. the Claude-Design mock (handled, not faked):
 *   - reels have no view count → likes + saves only.
 *   - providers have no km distance → city ?? 'Ort offen'.
 *   - providers have no jobs count → omitted.
 * The mock's in-screen video player is dropped: every reel tap calls
 * `onSelectReel(reel.id)`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CSSProperties } from 'react'
import type { ExploreReel } from '../../lib/explore/exploreTypes'
import type { DiscoveryProvider } from '../../lib/discovery/discoveryTypes'
import type { ScoredResult, SearchProfile } from '../../lib/search'
import { rankDiscoveryProviders, rankReels } from '../../lib/search'
import { useRecentSearches } from '../../lib/explore/useRecentSearches'
import { GEWERKE_TILES, splitIconPath } from './search/gewerkeTiles'
import { Chip, SearchButton, SegmentedControl, Switch } from './search/searchPrimitives'
import HwResultCard from './search/HwResultCard'
import './search/searchTokens.css'

type Props = {
  query: string
  results: ExploreReel[]
  /** All discovery-visible providers; ranked + filtered client-side. */
  discoveryProviders?: DiscoveryProvider[]
  onQueryChange: (value: string) => void
  onClose: () => void
  onSelectReel: (reelId: string) => void
  /** Full feed for trending + per-provider reel strips (falls back to `results`). */
  feedReels?: ExploreReel[]
  /** Viewer city for the proximity signal (never a filter). */
  userCity?: string
}

type Phase = 'idle' | 'loading' | 'results' | 'empty' | 'error'

const MOOD_ITEMS = ['Nähe zuerst', 'Beliebt']
const RATING_OPTIONS: { label: string; val: number }[] = [
  { label: 'Alle', val: 0 },
  { label: '4,0+', val: 4.0 },
  { label: '4,5+', val: 4.5 },
  { label: '4,8+', val: 4.8 },
]
const ALT_SUGGESTIONS = ['Sanitär', 'Elektriker', 'Fliesen Bad']

const EYEBROW: CSSProperties = {
  font: '700 11px/1 var(--font-sans)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
}

// Placeholder fill for skeleton blocks. The shimmer sweep itself comes from
// the canonical `.fx-skeleton` container overlay (index.css) — one shimmer
// system app-wide instead of this screen's former scoped `scfix-shimmer`.
const SHIMMER: CSSProperties = {
  background: 'var(--skel-base)',
}

function formatCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}k`
  }
  return String(n)
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function PlayGlyph({ size }: { size: number }) {
  return (
    <span
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: size,
        height: size,
        borderRadius: 999,
        background: 'rgba(255,255,255,.18)',
        border: '1px solid rgba(255,255,255,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <svg width={size * 0.42} height={size * 0.42} viewBox="0 0 24 24" fill="#fff" stroke="none">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  )
}

function DurBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        padding: '2px 6px',
        borderRadius: 6,
        background: 'rgba(12,19,34,.55)',
        color: '#fff',
        font: '600 10px/1 var(--font-mono)',
      }}
    >
      {label}
    </span>
  )
}

function HeartIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="rgba(255,255,255,.9)" stroke="none">
      <path d="M12 21s-7-4.5-9.5-9A5.2 5.2 0 0 1 12 6a5.2 5.2 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z" />
    </svg>
  )
}

function BookmarkIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ReelCover({ reel }: { reel: ExploreReel }) {
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 120% at 30% 8%, #1E3A8A 0%, #0C1322 80%)' }} />
      {reel.thumbnailUrl && (
        <img
          src={reel.thumbnailUrl}
          alt={reel.title}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
    </>
  )
}

function TrendingCard({ reel, rank, onClick }: { reel: ExploreReel; rank: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ flex: 'none', width: 152, display: 'flex', flexDirection: 'column', gap: 8, padding: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
    >
      <div style={{ position: 'relative', width: 152, height: 96, borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <ReelCover reel={reel} />
        <span
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            width: 22,
            height: 22,
            borderRadius: 8,
            background: 'rgba(255,255,255,.92)',
            color: 'var(--slate-900)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: '700 12px/1 var(--font-sans)',
          }}
        >
          {rank}
        </span>
        <PlayGlyph size={26} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 2px' }}>
        <span style={{ font: '700 13.5px/1.25 var(--font-sans)', color: 'var(--text-strong)', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {reel.title}
        </span>
        <span style={{ font: '500 11.5px/1 var(--font-sans)', color: 'var(--text-muted)' }}>
          {reel.category ? `${reel.category} · ` : ''}
          {formatCount(reel.likes)} Likes
        </span>
      </div>
    </button>
  )
}

function ReelStripCard({ reel, onClick }: { reel: ExploreReel; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ flex: 'none', width: 142, borderRadius: 16, overflow: 'hidden', position: 'relative', aspectRatio: '9 / 14', boxShadow: 'var(--shadow-sm)', cursor: 'pointer', border: 'none', padding: 0, background: 'var(--slate-100)' }}
    >
      <ReelCover reel={reel} />
      <PlayGlyph size={38} />
      {reel.durationLabel && <DurBadge label={reel.durationLabel} />}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '9px 10px', background: 'linear-gradient(transparent, rgba(12,19,34,.9))', color: '#fff', textAlign: 'left' }}>
        <div style={{ font: '700 11.5px/1.25 var(--font-sans)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{reel.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5, font: '600 10px/1 var(--font-sans)', color: 'rgba(255,255,255,.82)' }}>
          <HeartIcon size={11} />
          {formatCount(reel.likes)}
        </div>
      </div>
    </button>
  )
}

function ReelGridCard({ reel, onClick }: { reel: ExploreReel; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ borderRadius: 18, overflow: 'hidden', position: 'relative', aspectRatio: '9 / 15', boxShadow: 'var(--shadow-sm)', cursor: 'pointer', border: 'none', padding: 0, background: 'var(--slate-100)', width: '100%' }}
    >
      <ReelCover reel={reel} />
      <PlayGlyph size={46} />
      {reel.durationLabel && <DurBadge label={reel.durationLabel} />}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '11px 11px 12px', background: 'linear-gradient(transparent, rgba(12,19,34,.92))', color: '#fff', textAlign: 'left' }}>
        <div style={{ font: '700 12.5px/1.3 var(--font-sans)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{reel.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, font: '600 10.5px/1 var(--font-sans)', color: 'rgba(255,255,255,.78)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <HeartIcon size={11} />
            {formatCount(reel.likes)}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <BookmarkIcon size={11} />
            {formatCount(reel.saves)}
          </span>
        </div>
        <div style={{ marginTop: 5, font: '500 10.5px/1 var(--font-sans)', color: 'rgba(255,255,255,.62)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {reel.craftsmanName}
        </div>
      </div>
    </button>
  )
}

function SkeletonRow() {
  return (
    <div className="fx-skeleton" style={{ position: 'relative', overflow: 'hidden', display: 'flex', gap: 12, alignItems: 'center', background: 'var(--white)', border: '1px solid var(--edge)', borderRadius: 20, padding: 12 }}>
      <span style={{ flex: 'none', width: 44, height: 44, borderRadius: 999, ...SHIMMER }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ width: '52%', height: 13, borderRadius: 7, ...SHIMMER }} />
        <span style={{ width: '72%', height: 10, borderRadius: 6, ...SHIMMER }} />
        <span style={{ width: '38%', height: 18, borderRadius: 999, ...SHIMMER }} />
      </div>
      <span style={{ flex: 'none', width: 52, height: 70, borderRadius: 13, ...SHIMMER }} />
    </div>
  )
}

function GewerkTile({ label, iconPath, onClick, layout }: { label: string; iconPath: string; onClick: () => void; layout: 'grid' | 'row' }) {
  const row = layout === 'row'
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        alignItems: 'center',
        gap: row ? 10 : 8,
        padding: row ? '12px 13px' : '14px 8px',
        borderRadius: 16,
        border: '1px solid var(--edge)',
        background: 'var(--white)',
        boxShadow: 'var(--shadow-xs)',
        cursor: 'pointer',
        textAlign: row ? 'left' : 'center',
      }}
    >
      <span style={{ flex: 'none', width: 36, height: 36, borderRadius: 12, background: 'var(--blue-50)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {splitIconPath(iconPath).map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      </span>
      <span style={{ font: `700 ${row ? 13.5 : 12.5}px/1.1 var(--font-sans)`, color: 'var(--text-strong)' }}>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ExploreSearchScreen({
  query,
  results,
  discoveryProviders,
  onQueryChange,
  onClose,
  onSelectReel,
  feedReels,
  userCity,
}: Props) {
  const navigate = useNavigate()
  const { recent, push } = useRecentSearches()

  const trimmed = query.trim()

  const [moodIndex, setMoodIndex] = useState(0)
  const [activeTab, setActiveTab] = useState<'top' | 'reels' | 'handwerker'>('top')
  const [selectedGewerk, setSelectedGewerk] = useState('Alle')
  const [minRating, setMinRating] = useState(0)
  const [nearby, setNearby] = useState(false)
  // `settledQuery` lags `trimmed` by a short delay — the gap is the loading window.
  const [settledQuery, setSettledQuery] = useState(trimmed)
  const [loadFailed, setLoadFailed] = useState(false)

  const profile: SearchProfile = moodIndex === 0 ? 'forYou' : 'inspiration'

  // Debounce the query: on settle, reset to the Top tab and commit to history.
  // (setState lives in the timeout callback, never synchronously in the body.)
  useEffect(() => {
    if (trimmed === settledQuery) return
    const t = setTimeout(
      () => {
        setSettledQuery(trimmed)
        // A new search starts fresh — carrying gewerk/rating/nearby filters into
        // the next query silently constrains it (and can trap them behind the
        // empty state, which replaces the filter header).
        setActiveTab('top')
        setSelectedGewerk('Alle')
        setMinRating(0)
        setNearby(false)
        if (trimmed.length >= 2) push(trimmed)
      },
      trimmed ? 500 : 0,
    )
    return () => clearTimeout(t)
  }, [trimmed, settledQuery, push])

  const loading = trimmed.length > 0 && trimmed !== settledQuery

  // ── engine wiring ─────────────────────────────────────────────────────────
  const rankedProviders = useMemo(
    () => rankDiscoveryProviders(discoveryProviders ?? [], { query: trimmed, profile, userLocation: userCity }),
    [discoveryProviders, trimmed, profile, userCity],
  )

  const filteredProviders = useMemo(
    () =>
      rankedProviders.filter((r) => {
        // Query relevance gate: a ranker returns ALL candidates ranked, so we
        // must drop the query-irrelevant ones — otherwise a gibberish query
        // ("qwertz") still lists every provider and the empty state never shows.
        // Relevant = a real text hit OR a direct/service/related trade match
        // (0.5 = neutral "no query trade"; 0.6 = related, 0.7 = service, 1 = direct).
        // Proximity/social are NEVER part of this gate (nearness never filters).
        if (trimmed && !(r.breakdown.text > 0 || r.breakdown.trade >= 0.6)) return false
        const p = r.candidate
        if (selectedGewerk !== 'Alle') {
          const has = p.tradeCategories.some((c) => c.toLowerCase() === selectedGewerk.toLowerCase())
          if (!has) return false
        }
        if (minRating > 0 && (p.rating == null || p.rating < minRating)) return false
        return true
      }),
    [rankedProviders, selectedGewerk, minRating, trimmed],
  )

  const rankedReels = useMemo(() => {
    const ranked = rankReels((feedReels ?? results) ?? [], { query: trimmed, profile })
    if (!trimmed) return ranked
    return ranked.filter((r) => r.breakdown.text > 0 || r.breakdown.trade >= 0.6)
  }, [feedReels, results, trimmed, profile])

  const trendingReels = useMemo(
    () => rankReels(feedReels ?? [], { profile: 'inspiration' }).slice(0, 5),
    [feedReels],
  )

  const reelsForProvider = useCallback(
    (p: DiscoveryProvider): ExploreReel[] => {
      const all = feedReels ?? []
      const byCraftsman = all.filter((r) => r.craftsmanId === p.profileId)
      if (byCraftsman.length > 0) return byCraftsman
      return all.filter((r) => r.providerId === p.id)
    },
    [feedReels],
  )

  const hasMatches = filteredProviders.length > 0 || rankedReels.length > 0

  let phase: Phase
  if (loadFailed && discoveryProviders === undefined) phase = 'error'
  else if (trimmed.length < 2) phase = 'idle' // 1-char queries score neutral everywhere — keep discovery
  else if (loading) phase = 'loading'
  else if (hasMatches) phase = 'results'
  else phase = 'empty'

  const showTabs = phase === 'results'
  const moodCaption = moodIndex === 0 ? 'Nahe Betriebe oben — nichts wird ausgeblendet' : 'Beliebte Beiträge zuerst'

  // Proximity ranking needs the viewer's city; without it every provider scores
  // the neutral 0.5, so the nearby split (and toggle) is suppressed rather than
  // dumping everyone under "Weiter entfernt".
  const hasUserCity = !!userCity && userCity.trim().length > 0
  const splitNearby = nearby && hasUserCity
  const hwPrimary = splitNearby ? filteredProviders.filter((r) => r.breakdown.proximity >= 0.7) : filteredProviders
  const hwSecondary = splitNearby ? filteredProviders.filter((r) => r.breakdown.proximity < 0.7) : []

  const tabs: { key: 'top' | 'reels' | 'handwerker'; label: string; count: number | null }[] = [
    { key: 'top', label: 'Top', count: null },
    { key: 'reels', label: 'Reels', count: rankedReels.length },
    { key: 'handwerker', label: 'Handwerker', count: filteredProviders.length },
  ]

  function openProvider(p: DiscoveryProvider) {
    navigate(`/explore/craftsman/${p.profileId}`)
    onClose()
  }

  function renderCard(r: ScoredResult<DiscoveryProvider>) {
    return (
      <HwResultCard
        key={r.candidate.id}
        result={r}
        reels={reelsForProvider(r.candidate)}
        onOpen={() => openProvider(r.candidate)}
        onSelectReel={onSelectReel}
      />
    )
  }

  return (
    <div
      className="fxsearch"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-strong)',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 'none',
          padding: '12px 14px 10px',
          paddingTop: 'max(12px, env(safe-area-inset-top))',
          background: 'var(--panel)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Zurück"
          style={{ flex: 'none', width: 40, height: 40, borderRadius: 999, border: 'none', background: 'transparent', color: 'var(--slate-700)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, height: 48, padding: '0 14px', background: 'var(--field-bg)', border: '1px solid var(--field-border)', borderRadius: 'var(--field-radius)', boxShadow: 'var(--shadow-sm)' }}>
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="var(--slate-400)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label="Reels und Handwerker durchsuchen"
            placeholder="Gewerk, Projekt, Ort oder Betrieb …"
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 15px/1 var(--font-sans)', color: 'var(--field-text)' }}
          />
          {trimmed.length > 0 && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Leeren"
              style={{ flex: 'none', width: 24, height: 24, borderRadius: 999, border: 'none', background: 'var(--slate-100)', color: 'var(--slate-500)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Result tabs ─────────────────────────────────────────────────────── */}
      {showTabs && (
        <div style={{ flex: 'none', display: 'flex', gap: 22, padding: '2px 18px 0', background: 'var(--panel)', borderBottom: '1px solid var(--edge)' }}>
          {tabs.map((tb) => {
            const active = activeTab === tb.key
            return (
              <button
                key={tb.key}
                type="button"
                onClick={() => setActiveTab(tb.key)}
                style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 7, padding: '11px 0 12px', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <span style={{ font: `${active ? 700 : 600} 15px/1 var(--font-sans)`, color: active ? 'var(--text-strong)' : 'var(--text-muted)', letterSpacing: '-0.01em' }}>{tb.label}</span>
                {tb.count != null && (
                  <span style={{ font: '700 10.5px/1 var(--font-sans)', padding: '3px 7px', borderRadius: 999, background: active ? 'var(--blue-50)' : 'var(--slate-100)', color: active ? 'var(--blue-700)' : 'var(--slate-500)' }}>{tb.count}</span>
                )}
                <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, borderRadius: 2, background: active ? 'var(--accent)' : 'transparent', transition: 'background .2s' }} />
              </button>
            )
          })}
        </div>
      )}

      {/* ── Scroll body ─────────────────────────────────────────────────────── */}
      <div className="scfix-nobar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* IDLE / Discovery */}
        {phase === 'idle' && (
          <div style={{ padding: '8px 16px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
            {recent.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--slate-400)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  <span style={EYEBROW}>Zuletzt gesucht</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {recent.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onQueryChange(r)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--border-strong)', background: 'transparent', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: 'var(--slate-600)' }}
                    >
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--slate-400)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {trendingReels.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 17l6-6 4 4 7-7" />
                    <path d="M17 7h4v4" />
                  </svg>
                  <span style={EYEBROW}>Im Trend</span>
                </div>
                <div className="scfix-nobar" style={{ display: 'flex', gap: 11, overflowX: 'auto', margin: '0 -16px', padding: '0 16px 4px' }}>
                  {trendingReels.map((r, i) => (
                    <TrendingCard key={r.candidate.id} reel={r.candidate} rank={i + 1} onClick={() => onSelectReel(r.candidate.id)} />
                  ))}
                </div>
              </div>
            )}

            <div>
              <div style={{ ...EYEBROW, marginBottom: 12 }}>Nach Gewerk stöbern</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9 }}>
                {GEWERKE_TILES.map((g) => (
                  <GewerkTile key={g.key} label={g.label} iconPath={g.iconPath} layout="grid" onClick={() => onQueryChange(g.key)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* LOADING */}
        {phase === 'loading' && (
          <div style={{ padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {/* TOP */}
        {phase === 'results' && activeTab === 'top' && (
          <div style={{ padding: '12px 16px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <SegmentedControl items={MOOD_ITEMS} value={moodIndex} onChange={setMoodIndex} />
              <span style={{ font: '500 12px/1.3 var(--font-sans)', color: 'var(--text-muted)' }}>{moodCaption}</span>
            </div>

            {filteredProviders.length > 0 && (
              <div>
                <div style={{ ...EYEBROW, marginBottom: 12 }}>Stärkste Treffer</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{filteredProviders.slice(0, 3).map(renderCard)}</div>
              </div>
            )}

            {rankedReels.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={EYEBROW}>Passende Reels</span>
                  <button
                    type="button"
                    onClick={() => setActiveTab('reels')}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', font: '600 12.5px/1 var(--font-sans)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    Alle ansehen
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <div className="scfix-nobar" style={{ display: 'flex', gap: 11, overflowX: 'auto', margin: '0 -16px', padding: '0 16px 4px' }}>
                  {rankedReels.slice(0, 5).map((r) => (
                    <ReelStripCard key={r.candidate.id} reel={r.candidate} onClick={() => onSelectReel(r.candidate.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* REELS grid */}
        {phase === 'results' && activeTab === 'reels' && (
          <div style={{ padding: '14px 16px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
              {rankedReels.map((r) => (
                <ReelGridCard key={r.candidate.id} reel={r.candidate} onClick={() => onSelectReel(r.candidate.id)} />
              ))}
            </div>
          </div>
        )}

        {/* HANDWERKER + Filter */}
        {phase === 'results' && activeTab === 'handwerker' && (
          <div>
            <div style={{ position: 'sticky', top: 0, zIndex: 2, padding: '12px 16px', background: 'var(--panel)', borderBottom: '1px solid var(--edge)', display: 'flex', flexDirection: 'column', gap: 11 }}>
              <div className="scfix-nobar" style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', padding: '0 16px' }}>
                {['Alle', ...GEWERKE_TILES.map((t) => t.key)].map((g) => (
                  <span key={g} style={{ flex: 'none' }}>
                    <Chip selected={selectedGewerk === g} size="sm" onClick={() => setSelectedGewerk(g)}>
                      {g}
                    </Chip>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <SegmentedControl items={MOOD_ITEMS} value={moodIndex} onChange={setMoodIndex} size="sm" />
                {hasUserCity && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ font: '600 12.5px/1 var(--font-sans)', color: 'var(--text-body)' }}>In der Nähe</span>
                    <Switch checked={nearby} onChange={setNearby} size="sm" />
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ font: '600 11.5px/1 var(--font-sans)', color: 'var(--text-muted)' }}>Mind.</span>
                {RATING_OPTIONS.map((o) => (
                  <span key={o.label} style={{ flex: 'none' }}>
                    <Chip selected={minRating === o.val} size="sm" onClick={() => setMinRating(o.val)}>
                      {o.label}
                    </Chip>
                  </span>
                ))}
              </div>
            </div>

            <div style={{ padding: '14px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={EYEBROW}>{filteredProviders.length === 1 ? '1 Betrieb' : `${filteredProviders.length} Betriebe`}</div>
              {hwPrimary.map(renderCard)}

              {hwSecondary.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 2px' }}>
                    <span style={{ flex: 1, height: 1, background: 'var(--edge)' }} />
                    <span style={{ font: '600 11.5px/1 var(--font-sans)', color: 'var(--text-muted)' }}>Weiter entfernt · trotzdem dabei</span>
                    <span style={{ flex: 1, height: 1, background: 'var(--edge)' }} />
                  </div>
                  {hwSecondary.map(renderCard)}
                </>
              )}
            </div>
          </div>
        )}

        {/* EMPTY */}
        {phase === 'empty' && (
          <div style={{ padding: '30px 24px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <span style={{ width: 66, height: 66, borderRadius: 999, background: 'var(--slate-100)', color: 'var(--slate-400)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
              <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
                <path d="M8 11h6" />
              </svg>
            </span>
            <div style={{ font: '700 20px/1.2 var(--font-sans)', color: 'var(--text-strong)', letterSpacing: '-0.02em', marginBottom: 8 }}>Keine Treffer für „{trimmed}“</div>
            <div style={{ font: '400 14px/1.5 var(--font-sans)', color: 'var(--text-body)', maxWidth: 280, marginBottom: 22 }}>
              Versuch einen anderen Begriff oder stöber nach Gewerk — wir finden bestimmt was Passendes.
            </div>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 320 }}>
              <div>
                <div style={{ ...EYEBROW, marginBottom: 10, textAlign: 'left' }}>Vielleicht meinst du</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {ALT_SUGGESTIONS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => onQueryChange(a)}
                      style={{ padding: '9px 15px', borderRadius: 999, border: '1px solid var(--blue-200)', background: 'var(--blue-50)', color: 'var(--blue-700)', font: '600 13px/1 var(--font-sans)', cursor: 'pointer' }}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                {GEWERKE_TILES.map((g) => (
                  <GewerkTile key={g.key} label={g.label} iconPath={g.iconPath} layout="row" onClick={() => onQueryChange(g.key)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ERROR (dormant — data is passed in; built for completeness) */}
        {phase === 'error' && (
          <div style={{ padding: '40px 24px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <span style={{ width: 66, height: 66, borderRadius: 999, background: 'var(--danger-50)', color: 'var(--danger-500)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
              <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            </span>
            <div style={{ font: '700 20px/1.2 var(--font-sans)', color: 'var(--text-strong)', letterSpacing: '-0.02em', marginBottom: 8 }}>Etwas ist schiefgelaufen</div>
            <div style={{ font: '400 14px/1.5 var(--font-sans)', color: 'var(--text-body)', maxWidth: 270, marginBottom: 22 }}>
              Die Suche ist gerade nicht erreichbar. Prüf kurz deine Verbindung und versuch es erneut.
            </div>
            <SearchButton
              variant="primary"
              onClick={() => setLoadFailed(false)}
              leadingIcon={
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              }
            >
              Erneut versuchen
            </SearchButton>
          </div>
        )}
      </div>

      {/* ── Bottom tab bar (static, visual — Reels active) ──────────────────── */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'space-around',
          padding: '9px 8px 11px',
          paddingBottom: 'max(11px, env(safe-area-inset-bottom))',
          background: 'var(--white)',
          borderTop: '1px solid var(--edge)',
        }}
      >
        <button type="button" onClick={() => { onClose(); navigate('/') }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, color: 'var(--slate-400)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          <span style={{ font: '500 11px/1 var(--font-sans)' }}>Start</span>
          <span style={{ width: 18, height: 2, borderRadius: 2, background: 'transparent' }} />
        </button>
        <button type="button" onClick={onClose} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, color: 'var(--accent)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="4" />
            <path d="M10 9v6l5-3z" fill="currentColor" stroke="none" />
          </svg>
          <span style={{ font: '600 11px/1 var(--font-sans)' }}>Reels</span>
          <span style={{ width: 18, height: 2, borderRadius: 2, background: 'var(--accent)' }} />
        </button>
        <button type="button" onClick={() => { onClose(); navigate('/messages') }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, color: 'var(--slate-400)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5Z" />
          </svg>
          <span style={{ font: '500 11px/1 var(--font-sans)' }}>Chat</span>
          <span style={{ width: 18, height: 2, borderRadius: 2, background: 'transparent' }} />
        </button>
        <button type="button" onClick={() => { onClose(); navigate('/profile') }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, color: 'var(--slate-400)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
          </svg>
          <span style={{ font: '500 11px/1 var(--font-sans)' }}>Konto</span>
          <span style={{ width: 18, height: 2, borderRadius: 2, background: 'transparent' }} />
        </button>
      </div>
    </div>
  )
}
