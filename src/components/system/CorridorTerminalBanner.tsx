/**
 * CorridorTerminalBanner — prominent terminal-state takeover for corridor screens.
 *
 * Replaces the pattern of hiding operational sections and leaving a tiny
 * banner at the bottom.  This component goes near the top of a terminal-state
 * screen and clearly communicates that the entity's lifecycle has ended.
 *
 * Tones:
 *   - 'completed' : emerald — calm success / concluded
 *   - 'cancelled' : rose — terminated / withdrawn
 *   - 'blocked'   : amber — suspended / waiting on external resolution
 */

type Tone = 'completed' | 'cancelled' | 'blocked'

type Props = {
  icon: React.ReactNode
  title: string
  subtitle?: string
  tone: Tone
  children?: React.ReactNode
}

const TONE_STYLES: Record<Tone, { card: string; title: string; subtitle: string }> = {
  completed: {
    card: 'bg-emerald-50 ring-emerald-200/70',
    title: 'text-emerald-900',
    subtitle: 'text-emerald-700/70',
  },
  cancelled: {
    card: 'bg-rose-50 ring-rose-200/70',
    title: 'text-rose-900',
    subtitle: 'text-rose-700/70',
  },
  blocked: {
    card: 'bg-amber-50 ring-amber-200/70',
    title: 'text-amber-900',
    subtitle: 'text-amber-700/70',
  },
}

export default function CorridorTerminalBanner({
  icon,
  title,
  subtitle,
  tone,
  children,
}: Props) {
  const s = TONE_STYLES[tone]

  return (
    <div
      className={`rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.12)] ${s.card}`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[24px] leading-none">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className={`text-[16px] font-semibold ${s.title}`}>{title}</h3>
          {subtitle && (
            <p className={`mt-1 text-[13px] leading-relaxed ${s.subtitle}`}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
