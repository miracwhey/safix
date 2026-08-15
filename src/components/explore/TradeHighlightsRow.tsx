import type { TradeHighlight } from '../../lib/explore/tradeHighlightsSelector'

type Props = {
  highlights: TradeHighlight[]
  /** Trade currently active in the Portfolio-Tab filter (for highlight ring). */
  activeTrade?: string | null
  onSelect: (trade: string) => void
}

/**
 * Werkbereich-Bubbles — runde Bubbles mit Gradient-Ring (amber→rose→fuchsia)
 * für distinct trade categories. Cover = erstes Portfolio-Item dieses Gewerks
 * (Fallback: Initial-Bubble). Tap → wechselt auf Portfolio-Tab + filtert.
 */
export default function TradeHighlightsRow({ highlights, activeTrade, onSelect }: Props) {
  if (highlights.length === 0) return null

  return (
    <div
      className="flex gap-3 overflow-x-auto px-4 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="list"
      aria-label="Werkbereich-Highlights"
    >
      {highlights.map((highlight) => {
        const isActive = activeTrade !== null && activeTrade !== undefined &&
          activeTrade.toLowerCase() === highlight.trade.toLowerCase()
        return (
          <button
            key={highlight.trade}
            type="button"
            role="listitem"
            onClick={() => onSelect(highlight.trade)}
            className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 focus:outline-none"
          >
            <span
              className={`relative inline-flex h-[60px] w-[60px] items-center justify-center rounded-full p-[2px] transition-transform active:scale-[0.96] ${
                isActive
                  ? 'bg-gradient-to-br from-amber-400 via-rose-500 to-fuchsia-500'
                  : 'bg-gradient-to-br from-amber-300 via-rose-400 to-fuchsia-400'
              }`}
              aria-hidden
            >
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-white">
                {highlight.coverPublicUrl ? (
                  <img
                    src={highlight.coverPublicUrl}
                    alt=""
                    className="h-full w-full rounded-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-[18px] font-semibold text-ink-sub">
                    {pickInitial(highlight.trade)}
                  </span>
                )}
              </span>
            </span>
            <span
              className={`max-w-[68px] truncate text-[11px] leading-none ${
                isActive ? 'font-semibold text-ink' : 'font-medium text-ink-sub'
              }`}
            >
              {highlight.trade}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function pickInitial(trade: string): string {
  const trimmed = trade.trim()
  return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : '·'
}
