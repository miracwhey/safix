import { useMemo, useState } from 'react'
import { Heart, Image as ImageIcon, Play } from 'lucide-react'
import type { PortfolioItem } from '../../lib/providerMedia'
import { getPlaybackBlockReason, selectVideoSource } from '../../lib/media/playbackCompat'
import SourceJobMarker from './SourceJobMarker'

const ALL_FILTER = '__all__'

type Props = {
  items: PortfolioItem[]
  /** Optional pre-selected trade filter (e.g. activated via TradeHighlightsRow). */
  activeFilter?: string | null
  onActiveFilterChange?: (trade: string | null) => void
  /** Like counts keyed by portfolio item id. */
  likeCounts?: Record<string, number>
  onSelect?: (item: PortfolioItem) => void
}

/**
 * Portfolio-Tab — Filter-Chip-Reihe + 3-Spalten-Reels-Grid (aspect 3/4).
 * Kacheln zeigen Cover, Media-Typ-Badge (Video/Foto), Like-Count und einen
 * optionalen Source-Job-Marker.
 *
 * Filter-Strategie: kontrolliert über `activeFilter` (vom Profile-Screen
 * via TradeHighlightsRow gesetzt) plus internen Fallback für den
 * Uncontrolled-Use-Case. Der externe Wert hat Vorrang — kein
 * useEffect-State-Sync, sondern ein „adjusting state on prop change"-Pattern
 * direkt im Render-Body, damit die `react-hooks/set-state-in-effect`-Lint
 * nicht greift.
 */
export default function ProfilePortfolioGrid({
  items,
  activeFilter,
  onActiveFilterChange,
  likeCounts,
  onSelect,
}: Props) {
  const filterChips = useMemo(() => buildFilterChips(items), [items])

  const [internalFilter, setInternalFilter] = useState<string>(() =>
    activeFilter && filterChips.includes(activeFilter) ? activeFilter : ALL_FILTER,
  )
  const [lastSeenActiveFilter, setLastSeenActiveFilter] = useState<string | null | undefined>(
    activeFilter,
  )

  // React-Pattern „Adjusting State on Prop Change": kein useEffect, kein
  // cascading render. Nur synchronisieren, wenn sich der Prop-Wert wirklich
  // verändert hat.
  if (activeFilter !== lastSeenActiveFilter) {
    setLastSeenActiveFilter(activeFilter)
    if (activeFilter && filterChips.includes(activeFilter)) {
      setInternalFilter(activeFilter)
    } else if (activeFilter === null) {
      setInternalFilter(ALL_FILTER)
    }
  }

  const filter = internalFilter

  const filteredItems = useMemo(() => {
    if (filter === ALL_FILTER) return items
    const target = filter.toLowerCase()
    return items.filter((item) => {
      const tags = [
        ...(item.tradeTagsSnapshot ?? []),
        ...(item.tradeTags ?? []),
      ].map((t) => t.toLowerCase())
      return tags.includes(target)
    })
  }, [items, filter])

  function selectFilter(next: string) {
    setInternalFilter(next)
    onActiveFilterChange?.(next === ALL_FILTER ? null : next)
  }

  if (items.length === 0) {
    return (
      <div className="px-4 pt-6">
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-edge px-4 py-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-canvas">
            <ImageIcon size={16} className="text-ink-muted" aria-hidden />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-ink-sub">Noch keine Arbeitsproben</p>
            <p className="text-[11px] text-ink-muted">
              Sobald der Handwerker Projekte zeigt, erscheinen sie hier.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Filter-Chips */}
      <div className="flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <FilterChip
          label="Alle"
          active={filter === ALL_FILTER}
          onClick={() => selectFilter(ALL_FILTER)}
        />
        {filterChips.map((trade) => (
          <FilterChip
            key={trade}
            label={trade}
            active={filter.toLowerCase() === trade.toLowerCase()}
            onClick={() => selectFilter(trade)}
          />
        ))}
      </div>

      {/* Grid — 3-Spalten Reels-Layout (aspect 3/4), kein äußeres Padding */}
      {filteredItems.length === 0 ? (
        <div className="px-4 pb-4 text-[13px] text-ink-muted">
          Für „{filter}" liegen noch keine Arbeitsproben vor.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-[3px] bg-slate-100">
          {filteredItems.map((item) => (
            <PortfolioTile
              key={item.id}
              item={item}
              likeCount={likeCounts?.[item.id] ?? 0}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold transition ${
        active
          ? 'bg-ink text-white'
          : 'bg-canvas text-ink-sub ring-1 ring-edge hover:bg-surface'
      }`}
    >
      {label}
    </button>
  )
}

function PortfolioTile({
  item,
  likeCount,
  onSelect,
}: {
  item: PortfolioItem
  likeCount: number
  onSelect?: (item: PortfolioItem) => void
}) {
  const Tag: 'button' | 'div' = onSelect ? 'button' : 'div'
  const isVideo = item.mediaType === 'video'
  const blockReason = isVideo ? getPlaybackBlockReason(item) : null

  return (
    <Tag
      type={onSelect ? ('button' as const) : undefined}
      onClick={onSelect ? () => onSelect(item) : undefined}
      className={`relative aspect-[3/4] overflow-hidden bg-slate-900 ${
        onSelect ? 'transition-transform active:scale-[0.98]' : ''
      }`}
    >
      {item.publicUrl ? (
        isVideo ? (
          <video
            src={selectVideoSource(item) ?? undefined}
            poster={item.posterUrl ?? undefined}
            className="h-full w-full object-cover"
            muted
            preload="metadata"
            playsInline
          />
        ) : (
          <img
            src={item.publicUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-white/50">
          Kein Bild
        </div>
      )}

      {/* Gradient overlay */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />

      {/* Draft badge top-left */}
      {item.published === false ? (
        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-[2px] text-[9px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
          Entwurf
        </span>
      ) : null}

      {/* Media-Typ-Badge top-right */}
      {item.published !== false ? (
        isVideo && blockReason ? (
          <span
            className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-[2px] text-[9px] font-semibold text-white backdrop-blur-sm"
            aria-label={blockReason.message}
          >
            {blockReason.shortLabel}
          </span>
        ) : isVideo ? (
          <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play size={10} aria-hidden fill="currentColor" />
          </span>
        ) : (
          <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <ImageIcon size={10} aria-hidden />
          </span>
        )
      ) : null}

      {/* Like count bottom-left */}
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-[3px] rounded-full bg-black/45 px-1.5 py-[2px] text-[9px] font-semibold text-white backdrop-blur-sm">
        <Heart size={9} aria-hidden />
        <span className="tabular-nums">{likeCount}</span>
      </span>

      {/* Source-Job-Marker bottom-right */}
      {item.sourceJobId ? (
        <SourceJobMarker
          item={item}
          variant="overlay"
          className="absolute bottom-1.5 right-1.5 max-w-[68%]"
        />
      ) : null}
    </Tag>
  )
}

function buildFilterChips(items: PortfolioItem[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const item of items) {
    const tags = [...(item.tradeTagsSnapshot ?? []), ...(item.tradeTags ?? [])]
    for (const tag of tags) {
      const trimmed = tag.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push(trimmed)
    }
  }
  return ordered
}

