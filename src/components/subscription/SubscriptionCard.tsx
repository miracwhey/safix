/**
 * SubscriptionCard — Block E v2
 *
 * Tappable card on ProfileScreen (Konto tab). Shows current Pro status.
 * Tapping navigates to ProSubscriptionScreen for management or purchase.
 *
 * active/trial_active states → gradient header (brand)
 * grace/warning → tone-warning header
 * canceled/muted → tone-muted header
 * expired/danger → tone-danger header
 * trial_available → gradient header (promo)
 */

import { Sparkles } from 'lucide-react'
import type { EffectiveSubscriptionStatus, SubscriptionRow } from '../../lib/subscription/types'

type Props = {
  effectiveState: EffectiveSubscriptionStatus
  row: SubscriptionRow | null
  onPress: () => void
}

export default function SubscriptionCard({ effectiveState, row, onPress }: Props) {
  const cfg = getConfig(effectiveState, row)

  return (
    <button
      type="button"
      onClick={onPress}
      className="w-full overflow-hidden rounded-container bg-surface ring-1 ring-edge shadow-elevated transition active:scale-[0.99]"
    >
      {/* Header strip */}
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ background: cfg.headerBg }}
      >
        <div className="flex items-center gap-3">
          {/* Icon box */}
          <div
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          >
            <Sparkles size={16} className={cfg.iconClass} aria-hidden />
          </div>

          {/* Labels */}
          <div className="text-left">
            <p className={`text-[13px] font-bold uppercase tracking-[0.6px] opacity-78 ${cfg.textClass}`}>
              SaFix Pro
            </p>
            <p className={`text-[16px] font-semibold leading-snug ${cfg.textClass}`}>
              {cfg.headline}
            </p>
            <p className={`text-[12.5px] opacity-75 ${cfg.textClass}`}>{cfg.subline}</p>
          </div>
        </div>

        {/* CTA pill */}
        <div
          className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${cfg.pillClass}`}
        >
          {cfg.ctaLabel}
        </div>
      </div>
    </button>
  )
}

type Config = {
  headerBg: string
  textClass: string
  iconClass: string
  headline: string
  subline: string
  ctaLabel: string
  pillClass: string
}

function getConfig(state: EffectiveSubscriptionStatus, row: SubscriptionRow | null): Config {
  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString('de-DE', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null

  const gradientBg = 'linear-gradient(95deg, #2563EB, #1D4ED8)'
  const whitePill = 'bg-white/20 text-white'
  const whiteText = 'text-white'

  switch (state) {
    case 'trial_available':
      return {
        headerBg: gradientBg,
        textClass: whiteText,
        iconClass: 'text-pro-gold',
        headline: '14 Tage kostenlos testen',
        subline: 'Angebote · Rechnungen · Auszahlungen',
        ctaLabel: 'Entdecken',
        pillClass: whitePill,
      }

    case 'trial_active': {
      const ends = fmt(row?.trial_ends_at ?? null)
      return {
        headerBg: gradientBg,
        textClass: whiteText,
        iconClass: 'text-pro-gold',
        headline: 'Trial aktiv',
        subline: ends ? `Endet am ${ends}` : '14 Tage kostenlos',
        ctaLabel: 'Verwalten',
        pillClass: whitePill,
      }
    }

    case 'active': {
      const renews = fmt(row?.current_period_end ?? null)
      return {
        headerBg: gradientBg,
        textClass: whiteText,
        iconClass: 'text-pro-gold',
        headline: 'SaFix Pro · Aktiv',
        subline: renews ? `Verlängert sich am ${renews}` : 'Alle Funktionen freigeschaltet',
        ctaLabel: 'Verwalten',
        pillClass: whitePill,
      }
    }

    case 'grace':
      return {
        headerBg: 'var(--color-tone-warning-bg)',
        textClass: 'text-tone-warning-fg',
        iconClass: 'text-tone-warning-fg',
        headline: 'Zahlung ausstehend',
        subline: 'Zahlungsmethode prüfen',
        ctaLabel: 'Beheben',
        pillClass: 'bg-tone-warning-fg/10 text-tone-warning-fg',
      }

    case 'canceled': {
      const until = fmt(row?.current_period_end ?? null)
      return {
        headerBg: 'var(--color-tone-muted-bg)',
        textClass: 'text-tone-muted-fg',
        iconClass: 'text-tone-muted-fg',
        headline: 'Abo endet',
        subline: until ? `Aktiv bis ${until}` : 'Abo wurde gekündigt',
        ctaLabel: 'Verwalten',
        pillClass: 'bg-tone-muted-fg/10 text-tone-muted-fg',
      }
    }

    case 'expired':
      return {
        headerBg: 'var(--color-tone-danger-bg)',
        textClass: 'text-tone-danger-fg',
        iconClass: 'text-tone-danger-fg',
        headline: 'Abo abgelaufen',
        subline: 'Reaktivieren',
        ctaLabel: 'Reaktivieren',
        pillClass: 'bg-tone-danger-fg/10 text-tone-danger-fg',
      }
  }
}
