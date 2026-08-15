import { Heart, Pin, Play } from 'lucide-react'
import type { PortfolioItem } from '../../lib/providerMedia'
import { getPlaybackBlockReason, selectVideoSource } from '../../lib/media/playbackCompat'
import SourceJobMarker from './SourceJobMarker'

type Props = {
  items: PortfolioItem[]
  /** Optional likeCount lookup keyed by provider_media.id. */
  likeCounts?: Record<string, number>
  onSelect?: (item: PortfolioItem) => void
}

/**
 * Reels-Tab — 3-Spalten 9:16 Grid (Insta×TikTok-Style), Datenquelle ist die
 * existierende `portfolioItems`-Liste. Pro Tile:
 *  - Cover (publicUrl) als Hintergrund
 *  - Play-Icon top-right wenn Video
 *  - Pin-Badge top-left auf dem ersten Tile (Sortier-Indikator)
 *  - Like-Count bottom-left
 *  - Source-Job-Marker als Bottom-Overlay wenn `sourceJobId` gesetzt
 *
 * Tap bleibt MVP-no-op falls kein onSelect übergeben wird (kein Lightbox-Player
 * in Block 2 — Tap-Interaktion kommt mit der Reel-Phase nach).
 */
export default function ProfileReelsGrid({ items, likeCounts, onSelect }: Props) {
  if (items.length === 0) {
    return (
      <div className="px-4 pt-6">
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-edge px-4 py-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-canvas">
            <Play size={16} className="text-ink-muted" aria-hidden />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-ink-sub">Noch keine Reels</p>
            <p className="text-[11px] text-ink-muted">
              Sobald der Handwerker Inhalte teilt, erscheinen sie hier.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-[2px] bg-slate-100">
      {items.map((item, idx) => {
        const likeCount = likeCounts?.[item.id] ?? 0
        const isVideo = item.mediaType === 'video'
        const blockReason = isVideo ? getPlaybackBlockReason(item) : null
        const Tag: 'button' | 'div' = onSelect ? 'button' : 'div'
        return (
          <Tag
            key={item.id}
            type={onSelect ? ('button' as const) : undefined}
            onClick={onSelect ? () => onSelect(item) : undefined}
            className={`relative aspect-[9/16] overflow-hidden bg-slate-200 ${
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
                  alt={item.title ?? item.caption ?? ''}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-muted">
                Kein Bild
              </div>
            )}

            {idx === 0 ? (
              <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-[2px] text-[9px] font-semibold text-white backdrop-blur-sm">
                <Pin size={10} aria-hidden />
                <span>Pin</span>
              </span>
            ) : null}

            {item.published === false ? (
              <span className="absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-[2px] text-[9px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
                Entwurf
              </span>
            ) : isVideo && blockReason ? (
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
            ) : null}

            <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[2px] text-[10px] font-semibold text-white backdrop-blur-sm">
              <Heart size={10} aria-hidden />
              <span className="tabular-nums">{likeCount}</span>
            </span>

            {item.sourceJobId ? (
              <SourceJobMarker
                item={item}
                variant="overlay"
                className="absolute bottom-1.5 right-1.5 max-w-[68%]"
              />
            ) : null}
          </Tag>
        )
      })}
    </div>
  )
}
