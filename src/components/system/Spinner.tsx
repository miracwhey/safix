/**
 * The one spinner. A quiet rotating arc — the canonical loading indicator for
 * every FixUp surface (Loading-Patterns handoff 2026-07-06, Variante A).
 *
 * Replaces the ~40 ad-hoc inline border-circle / Loader2 / SVG / unicode
 * spinners that had drifted into 7 colors and arbitrary sizes. Rotation only
 * (transform), so it stays on the WKWebView GPU compositor.
 *
 * Sizes:  sm 16 · md 24 · lg 40  (readable down to 16 px inside a button)
 * Tones:  brand · neutral · onDark · current (inherits text color)
 *
 * Standalone it exposes role="status"; pass `label` to show text and announce
 * it. Inside a button, keep it label-less (the button text carries meaning).
 */

type Size = 'sm' | 'md' | 'lg'
type Tone = 'brand' | 'neutral' | 'onDark' | 'current'

type Props = {
  size?: Size
  tone?: Tone
  /** Visible + announced caption under the arc. Omit inside buttons. */
  label?: string
  /** Faster turn for in-button pending (0.7s vs 0.8s standalone). */
  inButton?: boolean
  className?: string
}

const PX: Record<Size, number> = { sm: 16, md: 24, lg: 40 }
// Thinner stroke as the arc grows, so weight reads consistently across sizes.
const STROKE: Record<Size, number> = { sm: 3, md: 2.6, lg: 2.4 }

const TONE_COLOR: Record<Tone, string> = {
  brand: 'text-brand',
  neutral: 'text-slate-400',
  onDark: 'text-white',
  current: '',
}

// Track-ring opacity per tone — a touch stronger on dark so the ring reads.
const TRACK_OPACITY: Record<Tone, number> = {
  brand: 0.16,
  neutral: 0.22,
  onDark: 0.24,
  current: 0.2,
}

function Arc({ size, tone, inButton }: { size: Size; tone: Tone; inButton: boolean }) {
  const px = PX[size]
  const sw = STROKE[size]
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      className={`block ${TONE_COLOR[tone]}`}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={sw} opacity={TRACK_OPACITY[tone]} />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        className="fx-spin"
        style={inButton ? { ['--spin-dur' as string]: '0.7s' } : undefined}
      />
    </svg>
  )
}

export default function Spinner({
  size = 'md',
  tone = 'brand',
  label,
  inButton = false,
  className,
}: Props) {
  if (!label) {
    // Inside a button the label + disabled state already convey "pending", so
    // the spinner is decorative — announcing "Wird geladen…" on top would be a
    // redundant second status. Standalone, it is the status.
    return (
      <span
        className={`inline-flex ${className ?? ''}`}
        {...(inButton
          ? { 'aria-hidden': true }
          : { role: 'status', 'aria-label': 'Wird geladen…' })}
      >
        <Arc size={size} tone={tone} inButton={inButton} />
      </span>
    )
  }

  return (
    <span
      className={`inline-flex flex-col items-center gap-2 ${className ?? ''}`}
      role="status"
    >
      <Arc size={size} tone={tone} inButton={inButton} />
      <span
        className={`text-[13px] font-medium ${tone === 'onDark' ? 'text-white/60' : 'text-slate-400'}`}
      >
        {label}
      </span>
    </span>
  )
}
