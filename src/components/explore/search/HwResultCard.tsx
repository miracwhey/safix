/**
 * HwResultCard — a single provider result.
 *
 * Driven directly by a `ScoredResult<DiscoveryProvider>` from the search engine.
 * Renders the avatar, name + verified badge, rating + count, city + trade, the
 * engine's match-reason "why" badges, and (when supplied) a strip of up to 3
 * reel thumbnails for this provider.
 *
 * Reality gaps vs. the mock: no km distance (shows `city ?? 'Ort offen'`), no
 * "N Aufträge" segment (omitted — no data).
 */

import type { CSSProperties } from 'react'
import type { ScoredResult } from '../../../lib/search'
import type { DiscoveryProvider } from '../../../lib/discovery/discoveryTypes'
import type { ExploreReel } from '../../../lib/explore/exploreTypes'
import { Avatar } from './searchPrimitives'

const META_TEXT: CSSProperties = {
  font: '600 12px/1 var(--font-sans)',
  color: 'var(--text-muted)',
}

const EYEBROW: CSSProperties = {
  font: '700 10px/1 var(--font-sans)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 8,
}

function isPrimaryReason(label: string): boolean {
  return label.startsWith('Gewerk') || label.includes('→')
}

export default function HwResultCard({
  result,
  reels,
  onOpen,
  onSelectReel,
}: {
  result: ScoredResult<DiscoveryProvider>
  reels: ExploreReel[]
  onOpen: () => void
  onSelectReel: (reelId: string) => void
}) {
  const p = result.candidate
  const name = p.companyName || p.displayName || 'Handwerker'
  const trade = p.tradeCategories.find(Boolean)
  const city = p.city ?? 'Ort offen'
  const ratingStr = p.rating != null ? p.rating.toFixed(1).replace('.', ',') : null
  const badges = result.matchReasons.slice(0, 3)
  const strip = reels.slice(0, 3)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
        background: 'var(--white)',
        border: '1px solid var(--edge)',
        borderRadius: 20,
        boxShadow: 'var(--shadow-sm)',
        padding: 13,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* ── identity row (tap → open provider) ─────────────────────────────── */}
      <button
        type="button"
        onClick={onOpen}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'none',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Avatar name={name} avatarUrl={p.avatarUrl} size={44} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span
              style={{
                font: '700 15.5px/1.2 var(--font-sans)',
                color: 'var(--text-strong)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
            {p.verified && (
              <span
                aria-label="Verifiziert"
                style={{
                  flex: 'none',
                  width: 15,
                  height: 15,
                  borderRadius: 999,
                  background: 'var(--blue-500)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            )}
            {ratingStr && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="#F59E0B" stroke="none">
                  <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21.5l1.2-6.5L2.5 9.4l6.6-.9z" />
                </svg>
                <span style={{ font: '700 12.5px/1 var(--font-sans)', color: 'var(--text-strong)' }}>{ratingStr}</span>
                {p.ratingCount > 0 && (
                  <span style={{ font: '500 12px/1 var(--font-sans)', color: 'var(--text-muted)' }}>({p.ratingCount})</span>
                )}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, ...META_TEXT, minWidth: 0 }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--slate-400)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span style={{ fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{city}</span>
            {trade && <span style={{ flex: 'none' }}>· {trade}</span>}
          </div>
        </div>
      </button>

      {/* ── why-badges (match reasons) ─────────────────────────────────────── */}
      {badges.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {badges.map((b, i) => {
            const primary = isPrimaryReason(b.label)
            return (
              <span
                key={`${b.label}-${i}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 9px',
                  borderRadius: 999,
                  font: '600 11px/1 var(--font-sans)',
                  whiteSpace: 'nowrap',
                  background: primary ? 'var(--blue-50)' : 'var(--slate-50)',
                  color: primary ? 'var(--blue-700)' : 'var(--slate-600)',
                  border: primary ? 'none' : '1px solid var(--edge)',
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: 999, flex: 'none', background: primary ? 'var(--blue-500)' : 'var(--slate-400)' }} />
                {b.label}
              </span>
            )
          })}
        </div>
      )}

      {/* ── reels strip (hidden when none) ─────────────────────────────────── */}
      {strip.length > 0 && (
        <div>
          <div style={EYEBROW}>Reels</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {strip.map((reel) => (
              <button
                key={reel.id}
                type="button"
                onClick={() => onSelectReel(reel.id)}
                style={{
                  position: 'relative',
                  aspectRatio: '1 / 1',
                  borderRadius: 11,
                  overflow: 'hidden',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: 'var(--slate-100)',
                }}
              >
                {reel.thumbnailUrl && (
                  <img
                    src={reel.thumbnailUrl}
                    alt={reel.title}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )}
                <span
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    background: 'rgba(255,255,255,.2)',
                    border: '1px solid rgba(255,255,255,.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backdropFilter: 'blur(3px)',
                  }}
                >
                  <svg width={11} height={11} viewBox="0 0 24 24" fill="#fff" stroke="none">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                {reel.durationLabel && (
                  <span
                    style={{
                      position: 'absolute',
                      bottom: 5,
                      right: 5,
                      padding: '2px 5px',
                      borderRadius: 5,
                      background: 'rgba(12,19,34,.6)',
                      color: '#fff',
                      font: '600 9px/1 var(--font-mono)',
                    }}
                  >
                    {reel.durationLabel}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
