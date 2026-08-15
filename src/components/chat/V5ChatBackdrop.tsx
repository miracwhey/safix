/**
 * V5 Chat backdrop — „Klar & Glas" steelivory.
 *
 * Fixed, non-interactive background layer for the customer ↔ craftsman chat
 * thread: a warm ivory canvas with a subtle accent wash, a tiled craftsman
 * doodle pattern (hammer / wrench / ruler / gear — WhatsApp-vibe, on-brand) and
 * a soft vignette that pushes the pattern back so the message bubbles read as
 * floating above it. Pure visual — translated 1:1 from the approved V5 mockup
 * (`Chat Versionen (standalone)`, V5 LEAD, combo `steelivory`).
 *
 * Rendered behind the message list; the edge-to-edge header (AppShell `header`
 * slot, z-30) and the bubbles (z-10) sit on top.
 */

const STEEL = '#1D3866'

type Variant = 'doodle' | 'grid' | 'clean'

export function V5ChatBackdrop({
  accent = STEEL,
  variant = 'doodle',
  /** 0–25 → pattern opacity 0–0.25. 12 = clearly visible, still calm. */
  strength = 12,
}: {
  accent?: string
  variant?: Variant
  strength?: number
}) {
  return (
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
      {/* Ivory canvas + subtle accent wash */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(900px 700px at 50% -20%, ${accent}1f, transparent 55%),
            radial-gradient(700px 600px at 100% 110%, ${accent}14, transparent 60%),
            linear-gradient(180deg, #F4F0E9 0%, #EFE9E0 100%)
          `,
        }}
      />

      {variant !== 'clean' && <DoodlePattern variant={variant} strength={strength} />}

      {/* Soft inner vignette — pushes the pattern back, lifts bubbles forward. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 50% 50%, transparent 60%, rgba(15,23,42,0.05) 100%)',
        }}
      />
    </div>
  )
}

function DoodlePattern({ variant, strength }: { variant: Variant; strength: number }) {
  const stroke = '#1E293B'
  const op = Math.max(0, Math.min(25, strength)) / 100

  if (variant === 'grid') {
    const minorOp = op * 0.55
    const majorOp = op * 1.0
    return (
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="v5grid-minor" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke={stroke} strokeOpacity={minorOp} strokeWidth="0.6" />
          </pattern>
          <pattern id="v5grid-major" width="80" height="80" patternUnits="userSpaceOnUse">
            <rect width="80" height="80" fill="url(#v5grid-minor)" />
            <path d="M 80 0 L 0 0 0 80" fill="none" stroke={stroke} strokeOpacity={majorOp} strokeWidth="0.9" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#v5grid-major)" />
      </svg>
    )
  }

  // Default: scattered craftsman doodles + small dots.
  return (
    <svg className="absolute inset-0 h-full w-full" aria-hidden>
      <defs>
        <pattern
          id="v5doodle"
          width="150"
          height="150"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-4) scale(0.9)"
        >
          <g
            fill="none"
            stroke={stroke}
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={op}
          >
            <g transform="translate(8,14) rotate(-28)">
              <rect x="0" y="0" width="15" height="9" rx="1.5" />
              <line x1="15" y1="4.5" x2="34" y2="4.5" />
            </g>
            <g transform="translate(78,8) rotate(38)">
              <circle cx="5" cy="5" r="5" />
              <path d="M9 7 L22 14 L19 18 L7 11" />
            </g>
            <g transform="translate(120,30)">
              <path d="M0 0 L22 0 L0 18 Z" />
              <line x1="3" y1="3" x2="15" y2="3" />
            </g>
            <g transform="translate(6,58)">
              <rect x="0" y="0" width="48" height="8" />
              <line x1="6" y1="0" x2="6" y2="4" />
              <line x1="12" y1="0" x2="12" y2="3" />
              <line x1="18" y1="0" x2="18" y2="4" />
              <line x1="24" y1="0" x2="24" y2="3" />
              <line x1="30" y1="0" x2="30" y2="4" />
              <line x1="36" y1="0" x2="36" y2="3" />
              <line x1="42" y1="0" x2="42" y2="4" />
            </g>
            <g transform="translate(86,52) rotate(20)">
              <path d="M-3.5 0 L3.5 0 L3.5 4 L0 20 L-3.5 4 Z" />
              <line x1="-3.5" y1="2" x2="3.5" y2="2" />
            </g>
            <g transform="translate(128,74)">
              <circle cx="0" cy="0" r="4" />
              <circle cx="0" cy="0" r="9" />
              <line x1="0" y1="-13" x2="0" y2="-10" />
              <line x1="0" y1="10" x2="0" y2="13" />
              <line x1="-13" y1="0" x2="-10" y2="0" />
              <line x1="10" y1="0" x2="13" y2="0" />
              <line x1="-9" y1="-9" x2="-7" y2="-7" />
              <line x1="7" y1="7" x2="9" y2="9" />
              <line x1="-9" y1="9" x2="-7" y2="7" />
              <line x1="7" y1="-7" x2="9" y2="-9" />
            </g>
            <g transform="translate(18,104) rotate(-14)">
              <rect x="0" y="0" width="18" height="7" rx="1" />
              <line x1="18" y1="3.5" x2="26" y2="3.5" />
              <line x1="26" y1="-2" x2="26" y2="9" />
            </g>
            <g transform="translate(74,98) rotate(-28)">
              <rect x="0" y="0" width="15" height="9" rx="1.5" />
              <line x1="15" y1="4.5" x2="34" y2="4.5" />
            </g>
            <g transform="translate(120,116) rotate(38)">
              <circle cx="5" cy="5" r="5" />
              <path d="M9 7 L22 14 L19 18 L7 11" />
            </g>
            <g transform="translate(48,128)">
              <path d="M0 0 L18 0 L0 15 Z" />
            </g>
            <circle cx="62" cy="36" r="0.9" fill={stroke} stroke="none" />
            <circle cx="40" cy="84" r="0.9" fill={stroke} stroke="none" />
            <circle cx="108" cy="56" r="0.9" fill={stroke} stroke="none" />
            <circle cx="10" cy="132" r="0.9" fill={stroke} stroke="none" />
            <circle cx="100" cy="100" r="0.9" fill={stroke} stroke="none" />
            <circle cx="142" cy="40" r="0.9" fill={stroke} stroke="none" />
            <g stroke={stroke} strokeWidth="1">
              <path d="M58 64 h3 M59.5 62.5 v3" />
              <path d="M138 96 h3 M139.5 94.5 v3" />
              <path d="M30 36 h3 M31.5 34.5 v3" />
              <path d="M96 134 h3 M97.5 132.5 v3" />
            </g>
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#v5doodle)" />
    </svg>
  )
}
