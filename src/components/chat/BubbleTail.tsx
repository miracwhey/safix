/**
 * Bubble tail (Schweif) — an INTEGRAL spur, not a detached hook.
 *
 * A small triangle at the bottom sender-side corner, filled with the EXACT
 * bubble colour and overlapping the squared corner so it reads as one
 * continuous shape (no detached "hook"). Placed in the bubble's non-clipping
 * `relative` anchor (media cards are overflow-hidden, so the spur is a sibling,
 * not a child) and painted on top — same colour means a seamless extension.
 *   • own  → bottom-right, brand-blue
 *   • peer → bottom-left, surface-white
 */

type Props = {
  side: 'left' | 'right'
  tone: 'own' | 'peer'
}

export function BubbleTail({ side, tone }: Props) {
  const bg = tone === 'own' ? '#2563EB' : '#FFFFFF'
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        bottom: 0,
        width: 12,
        height: 13,
        background: bg,
        ...(side === 'right'
          ? { right: -5, clipPath: 'polygon(0 0, 0 100%, 100% 100%)' }
          : { left: -5, clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }),
      }}
    />
  )
}
