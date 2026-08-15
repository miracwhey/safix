/**
 * Block D Slice 3 — Lock indicator pill.
 *
 * Renders inside the composer body (NOT floating above the viewport) so it
 * stays within the phone-body bounds on iOS. Slides in once the user pulls
 * past 40px upward; turns green once the 80px lock threshold is reached.
 */

type Props = {
  /** Pull distance in px (negative dy from the recorder). Always >= 0. */
  pullPx: number
  /** Distance past which the lock is armed (becomes green). */
  armThresholdPx: number
}

export function LockIndicator({ pullPx, armThresholdPx }: Props) {
  const visiblePx = Math.max(0, Math.min(pullPx, armThresholdPx))
  const armed = pullPx >= armThresholdPx
  const opacity = Math.min(1, visiblePx / 24)
  const translateY = -visiblePx

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 -translate-x-1/2 select-none"
      style={{
        bottom: 78,
        opacity,
        transform: `translateX(-50%) translateY(${translateY}px)`,
        transition: armed ? 'transform 140ms ease-out' : 'none',
      }}
    >
      <div
        className={`flex h-9 w-9 items-center justify-center rounded-full text-[14px] shadow-[0_2px_10px_-2px_rgba(15,23,42,0.18)] ${
          armed ? 'bg-emerald-500 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200/80'
        }`}
      >
        <LockIcon />
      </div>
    </div>
  )
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
