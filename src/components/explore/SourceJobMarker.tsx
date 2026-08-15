import type { PortfolioItem } from '../../lib/providerMedia'

type Variant = 'overlay' | 'caption'

type Props = {
  item: Pick<
    PortfolioItem,
    'sourceJobId' | 'projectTitleSnapshot' | 'tradeTagsSnapshot' | 'tradeTags' | 'locationSnapshot'
  >
  variant?: Variant
  className?: string
}

/**
 * Source-Job-Marker — Caption-Pille auf Reel-/Portfolio-Tile, sichtbar
 * wenn das Portfolio-Item aus einem Job übernommen wurde
 * (`sourceJobId` gesetzt). Inhalt: `{trade · projektTitel · stadt}` aus
 * den unveränderlichen Snapshots, die beim Übernehmen angelegt wurden.
 *
 * Privacy-OK: rein Provider-Snapshot-Felder, keine Customer-Daten.
 */
export default function SourceJobMarker({ item, variant = 'caption', className = '' }: Props) {
  if (!item.sourceJobId) return null

  const trade = pickFirstTrade(item)
  const title = item.projectTitleSnapshot?.trim()
  const location = item.locationSnapshot?.trim()
  const parts = [trade, title, location].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  if (parts.length === 0) return null

  const text = parts.join(' · ')

  if (variant === 'overlay') {
    return (
      <span
        className={`pointer-events-none inline-flex max-w-full items-center gap-1 rounded-full bg-black/55 px-2 py-[2px] text-[10px] font-medium leading-tight text-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] backdrop-blur-sm ${className}`}
        title={text}
      >
        <span className="text-[9px] leading-none">●</span>
        <span className="truncate">{text}</span>
      </span>
    )
  }

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full bg-canvas px-2 py-[2px] text-[10px] font-medium leading-tight text-ink-sub ring-1 ring-edge/60 ${className}`}
      title={text}
    >
      <span className="truncate">{text}</span>
    </span>
  )
}

function pickFirstTrade(
  item: Pick<PortfolioItem, 'tradeTagsSnapshot' | 'tradeTags'>,
): string | null {
  const fromSnapshot = item.tradeTagsSnapshot?.find((t) => t && t.trim().length > 0)
  if (fromSnapshot) return fromSnapshot.trim()
  const fromTags = item.tradeTags?.find((t) => t && t.trim().length > 0)
  return fromTags?.trim() ?? null
}
