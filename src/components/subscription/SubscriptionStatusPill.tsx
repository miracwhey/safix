import type { EffectiveSubscriptionStatus } from '../../lib/subscription/types'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted'

const TONE: Record<Tone, { bg: string; fg: string; dot: string; label: string }> = {
  success: {
    bg: 'bg-tone-success-bg',
    fg: 'text-tone-success-fg',
    dot: 'bg-tone-success-fg',
    label: 'Aktiv',
  },
  warning: {
    bg: 'bg-tone-warning-bg',
    fg: 'text-tone-warning-fg',
    dot: 'bg-tone-warning-fg',
    label: 'Zahlung ausstehend',
  },
  danger: {
    bg: 'bg-tone-danger-bg',
    fg: 'text-tone-danger-fg',
    dot: 'bg-tone-danger-fg',
    label: 'Abgelaufen',
  },
  info: {
    bg: 'bg-tone-info-bg',
    fg: 'text-tone-info-fg',
    dot: 'bg-tone-info-fg',
    label: 'Trial aktiv',
  },
  muted: {
    bg: 'bg-tone-muted-bg',
    fg: 'text-tone-muted-fg',
    dot: 'bg-tone-muted-fg',
    label: 'Gekündigt',
  },
}

export function stateToTone(state: EffectiveSubscriptionStatus): Tone { // eslint-disable-line react-refresh/only-export-components
  switch (state) {
    case 'active':         return 'success'
    case 'grace':          return 'warning'
    case 'expired':        return 'danger'
    case 'trial_active':   return 'info'
    case 'canceled':       return 'muted'
    case 'trial_available': return 'info'
  }
}

type Props = {
  tone: Tone
  label?: string
}

export function SubscriptionStatusPill({ tone, label }: Props) {
  const t = TONE[tone]
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.6px] ${t.bg} ${t.fg}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      {label ?? t.label}
    </div>
  )
}
