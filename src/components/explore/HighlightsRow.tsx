import { Plus } from 'lucide-react'
import type { ProviderHighlight } from '../../lib/highlights/highlightRepository'

type Props = {
  highlights: ProviderHighlight[]
  /** Called with the index of the tapped highlight. */
  onOpen: (index: number) => void
  /** Show "+" add button at the end (own profile). */
  isOwner?: boolean
  onAddNew?: () => void
}

export default function HighlightsRow({ highlights, onOpen, isOwner, onAddNew }: Props) {
  if (highlights.length === 0 && !isOwner) return null

  if (highlights.length === 0 && isOwner) {
    return (
      <div className="px-4 pb-1 pt-0.5">
        <button
          type="button"
          onClick={onAddNew}
          className="flex items-center gap-1.5 text-[13px] font-medium text-ink-muted transition active:opacity-60"
        >
          <Plus size={14} className="text-ink-muted" aria-hidden />
          Highlights erstellen
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex gap-4 overflow-x-auto px-4 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="list"
      aria-label="Highlights"
    >
      {highlights.map((hl, idx) => (
        <HighlightBubble key={hl.id} highlight={hl} onTap={() => onOpen(idx)} />
      ))}

      {isOwner && (
        <button
          type="button"
          onClick={onAddNew}
          className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 focus:outline-none"
          aria-label="Neues Highlight erstellen"
        >
          <span className="inline-flex h-[62px] w-[62px] items-center justify-center rounded-full border-2 border-dashed border-edge transition-transform active:scale-[0.96]">
            <Plus size={20} className="text-ink-muted" aria-hidden />
          </span>
          <span className="max-w-[68px] truncate text-[11px] font-medium leading-none text-ink-muted">
            Neu
          </span>
        </button>
      )}
    </div>
  )
}

function HighlightBubble({
  highlight,
  onTap,
}: {
  highlight: ProviderHighlight
  onTap: () => void
}) {
  const coverUrl = highlight.coverPublicUrl ?? highlight.items[0]?.publicUrl ?? null

  return (
    <button
      type="button"
      role="listitem"
      onClick={onTap}
      className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 focus:outline-none"
    >
      <span className="relative inline-flex h-[62px] w-[62px] items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-rose-500 to-fuchsia-500 p-[3px] transition-transform active:scale-[0.96]">
        <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 border-white bg-white">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              className="h-full w-full rounded-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="text-[18px] font-semibold text-ink-sub">
              {pickInitial(highlight.title)}
            </span>
          )}
        </span>
      </span>
      <span className="max-w-[68px] truncate text-[11px] font-medium leading-none text-ink-sub">
        {highlight.title}
      </span>
    </button>
  )
}

function pickInitial(title: string): string {
  const t = title.trim()
  return t.length > 0 ? t.charAt(0).toUpperCase() : '·'
}
