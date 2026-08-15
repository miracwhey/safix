/**
 * ProScreenGuard — Block E v2
 *
 * Screen-level subscription gate. Wraps a full screen and shows a locked
 * placeholder if the owner is on the free tier (trial_available) or expired.
 *
 * Active states (trial_active, active, grace, canceled) pass through.
 * Non-owner scope (workers, customers) always passes through.
 */

import { useNavigate } from 'react-router-dom'
import { Lock, X } from 'lucide-react'
import { useSubscription } from '../../hooks/useSubscription'
import { useSmartBack } from '../../hooks/useSmartBack'
import type { EffectiveSubscriptionStatus } from '../../lib/subscription/types'

const PRO_ACCESS_STATES: ReadonlySet<EffectiveSubscriptionStatus> = new Set([
  'trial_active',
  'active',
  'grace',
  'canceled',
])

/** Decorative blurred-preview skeleton rows */
function BlurredPreview() {
  return (
    <div className="absolute inset-0 overflow-hidden opacity-20" aria-hidden>
      <div className="mt-[72px] space-y-3 px-4">
        {[80, 100, 60, 90, 70, 110, 50, 85].map((w, i) => (
          <div
            key={i}
            className="h-[18px] rounded-full bg-ink"
            style={{ width: `${w}%`, opacity: 0.6 - i * 0.04 }}
          />
        ))}
        <div className="mt-6 h-[72px] rounded-[14px] bg-ink opacity-30" />
        <div className="h-[56px] rounded-[14px] bg-ink opacity-20" />
      </div>
    </div>
  )
}

type Props = {
  featureName: string
  featureDescription?: string
  children: React.ReactNode
}

export default function ProScreenGuard({ featureName, featureDescription, children }: Props) {
  const subscription = useSubscription()
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/dashboard')

  // Non-owners always pass through
  if (subscription.scope === 'not_applicable') return <>{children}</>

  // Loading — neutral skeleton (never expose Pro content before gate resolves)
  if (subscription.isLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-canvas">
        <div className="h-[calc(env(safe-area-inset-top,0px)+52px)]" />
        <div className="space-y-3 px-4 pt-4">
          {[80, 100, 60, 90, 70, 110, 50].map((w, i) => (
            <div
              key={i}
              className="h-[18px] animate-pulse rounded-full bg-surface-alt"
              style={{ width: `${w}%` }}
            />
          ))}
          <div className="mt-6 h-[72px] animate-pulse rounded-[14px] bg-surface-alt" />
          <div className="h-[56px] animate-pulse rounded-[14px] bg-surface-alt" />
        </div>
      </div>
    )
  }

  const state = subscription.effectiveState

  // Active Pro state — pass through
  if (state && PRO_ACCESS_STATES.has(state)) return <>{children}</>

  const isExpired = state === 'expired'

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-canvas">
      {/* Blurred preview background */}
      <BlurredPreview />

      {/* Gradient veil */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(244,245,248,0.98) 42%)',
        }}
        aria-hidden
      />

      {/* Top bar */}
      <div className="relative z-10 flex h-[calc(env(safe-area-inset-top,0px)+52px)] items-end justify-between bg-transparent px-4 pb-2">
        <div className="w-9" />
        <span className="text-[13px] font-medium text-ink-sub">{featureName}</span>
        <button
          type="button"
          onClick={goBack}
          aria-label="Schließen"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/6 transition active:bg-black/12"
        >
          <X size={16} className="text-ink" aria-hidden />
        </button>
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-7 pb-32 text-center">
        {/* Lock icon + PRO badge */}
        <div className="relative">
          <div
            className="flex h-[72px] w-[72px] items-center justify-center rounded-[22px] bg-brand"
            style={{ boxShadow: 'var(--shadow-brand-glow)' }}
          >
            <Lock size={28} className="text-white" aria-hidden />
          </div>
          <div className="absolute -right-1.5 -top-1.5 rounded-full bg-pro-gold px-2 py-0.5 text-[10px] font-bold text-ink">
            PRO
          </div>
        </div>

        {/* Eyebrow */}
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[1.6px] text-ink-sub">
          SaFix Pro · {featureName}
        </p>

        {/* Headline */}
        <h1 className="mt-2 text-[24px] font-bold tracking-[-0.5px] text-ink">
          {isExpired
            ? 'Dein Abo ist abgelaufen.'
            : 'Diese Funktion ist Teil von SaFix Pro.'}
        </h1>

        {/* Body */}
        <p className="mt-3 max-w-[280px] text-[14px] leading-relaxed text-ink-sub">
          {featureDescription ??
            (isExpired
              ? 'Reaktiviere SaFix Pro, um weiterhin alle Funktionen zu nutzen.'
              : 'Nutze alle Pro-Funktionen: Angebote, Rechnungen, Team, Finance.')}
        </p>
      </div>

      {/* Bottom CTAs */}
      <div className="relative z-10 space-y-2 px-4 pb-[max(36px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => navigate('/craftsman/subscription')}
          className="w-full rounded-[14px] bg-brand py-[15px] text-[15px] font-semibold text-white transition active:scale-[0.98]"
          style={{ boxShadow: 'var(--shadow-brand-glow)' }}
        >
          {isExpired ? 'Pro reaktivieren' : 'SaFix Pro holen'}
        </button>

        <button
          type="button"
          onClick={goBack}
          className="w-full py-[13px] text-[14px] font-medium text-ink-sub transition hover:text-ink"
        >
          Zurück
        </button>
      </div>
    </div>
  )
}
