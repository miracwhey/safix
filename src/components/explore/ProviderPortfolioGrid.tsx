import { useState } from 'react'
import { Play } from 'lucide-react'
import type { PortfolioItem } from '../../lib/providerMedia'

type Props = {
  items: PortfolioItem[]
  columns?: 2 | 3
  /**
   * When true (default), only published items are rendered.
   * When false (owner view), unpublished items are shown with a draft badge.
   */
  publicView?: boolean
  /** Called when the user taps a tile. Owner screens use this for edit/delete. */
  onItemTap?: (item: PortfolioItem) => void
}

export default function ProviderPortfolioGrid({
  items,
  columns = 3,
  publicView = true,
  onItemTap,
}: Props) {
  const visibleItems = publicView ? items.filter((i) => i.published) : items
  if (visibleItems.length === 0) return null

  const gridCols = columns === 2 ? 'grid-cols-2' : 'grid-cols-3'

  return (
    <div className={`grid ${gridCols} gap-[2px]`}>
      {visibleItems.map((item) => (
        <PortfolioTile
          key={item.id}
          item={item}
          publicView={publicView}
          onTap={onItemTap ? () => onItemTap(item) : undefined}
        />
      ))}
    </div>
  )
}

function PortfolioTile({
  item,
  publicView,
  onTap,
}: {
  item: PortfolioItem
  publicView: boolean
  onTap?: () => void
}) {
  const [errored, setErrored] = useState(false)
  // Grid overlay text: title wins over caption. description never shown in grid.
  const overlayText = item.title ?? item.caption

  const content = (
    <div
      className="relative bg-slate-100"
      style={{ aspectRatio: '1 / 1' }}
    >
      {item.mediaType === 'video' ? (
        <VideoTile publicUrl={item.publicUrl} posterUrl={item.posterUrl} />
      ) : item.publicUrl && !errored ? (
        <img
          src={item.publicUrl}
          alt={overlayText ?? 'Arbeitsprobe'}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-slate-200">
          <span className="text-[11px] text-slate-400">
            {errored ? 'Fehler' : 'Kein Bild'}
          </span>
        </div>
      )}

      {/* Caption overlay — only when text exists */}
      {overlayText ? (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-6">
          <p className="truncate text-[10px] font-medium text-white">{overlayText}</p>
        </div>
      ) : null}

      {/* Draft badge for owner view */}
      {!publicView && !item.published && (
        <div className="absolute top-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5">
          <span className="text-[9px] font-bold uppercase tracking-wide text-white">Entwurf</span>
        </div>
      )}
    </div>
  )

  if (onTap) {
    return (
      <button
        type="button"
        onClick={onTap}
        className="block w-full text-left transition active:opacity-80"
      >
        {content}
      </button>
    )
  }

  return content
}

function VideoTile({
  publicUrl,
  posterUrl,
}: {
  publicUrl: string | null
  posterUrl: string | null
}) {
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-slate-800">
      {publicUrl ? (
        <video
          src={publicUrl}
          poster={posterUrl ?? undefined}
          className="h-full w-full object-cover"
          muted
          playsInline
          // `metadata` matches the public-facing grids and lets the browser
          // fetch enough to render the first frame even when no poster has
          // been generated yet (legacy items pre-Block-3). `none` would
          // leave the tile black until the user taps it.
          preload="metadata"
        />
      ) : null}
      {/* Play indicator always visible over video */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm">
          <Play size={16} className="text-white fill-white translate-x-[1px]" aria-hidden />
        </div>
      </div>
    </div>
  )
}
