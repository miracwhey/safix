type Props = {
  /** Render the skeleton on the right (own-bubble side) instead of the left. */
  align?: 'left' | 'right'
  /** Synthetic width tier so a row of skeletons looks varied. */
  width?: 'sm' | 'md' | 'lg'
  count?: number
}

/**
 * Loading-state placeholder for chat bubbles. Uses the canonical `.fx-skeleton`
 * sweep (index.css) — pure transform/opacity, GPU-friendly, respects
 * prefers-reduced-motion. One shimmer system app-wide.
 */
export function ChatBubbleSkeleton({ align = 'left', width = 'md', count = 1 }: Props) {
  const widthClass = WIDTH_CLASSES[width]
  const radius = align === 'right' ? 'rounded-2xl rounded-br-none' : 'rounded-2xl rounded-bl-none'
  const wrapperAlign = align === 'right' ? 'items-end' : 'items-start'

  return (
    <div className={`flex flex-col gap-2 ${wrapperAlign}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`fx-skeleton relative overflow-hidden bg-[var(--skel-base)] h-9 ${widthClass} ${radius}`}
          aria-hidden="true"
        />
      ))}
    </div>
  )
}

const WIDTH_CLASSES: Record<NonNullable<Props['width']>, string> = {
  sm: 'w-[42%]',
  md: 'w-[62%]',
  lg: 'w-[78%]',
}

/**
 * Inbox-row variant of the same shimmer — keeps the rounded card silhouette
 * so the loading list does not jump when real rows replace it.
 */
export function ChatInboxRowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2 px-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="fx-skeleton relative overflow-hidden bg-[var(--skel-base)] h-[68px] w-full rounded-2xl"
          aria-hidden="true"
        />
      ))}
    </div>
  )
}
