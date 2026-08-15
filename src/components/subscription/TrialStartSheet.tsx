/**
 * TrialStartSheet — Block E v2
 *
 * Confirmation sheet for first Pro action in trial_available state.
 * Shows timeline: today → trial-end → jederzeit kündbar.
 * monthlyPriceString is optional — provided by ProActionGuard when StoreKit
 * packages are loaded. If absent, the "Abo beginnt" line omits the price.
 *
 * Apple compliance: no hardcoded price strings.
 */

import { Sparkles } from 'lucide-react'

type Props = {
  isStarting: boolean
  error: string | null
  onConfirm: () => void
  onDismiss: () => void
  /** StoreKit-localized monthly price, e.g. "149,99 €/Monat". Optional. */
  monthlyPriceString?: string | null
}

function trialEndDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 14)
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function TrialStartSheet({
  isStarting,
  error,
  onConfirm,
  onDismiss,
  monthlyPriceString,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[0.5px]">
      <div className="w-full max-w-[420px] rounded-t-[20px] bg-white pb-[max(32px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_30px_rgba(0,0,0,0.18)]">
        {/* Drag handle */}
        <div className="mx-auto mb-[18px] h-1 w-9 rounded-full bg-edge" />

        <div className="px-[22px]">
          {/* Header row */}
          <div className="flex items-center gap-4">
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: 'linear-gradient(135deg, #2563EB, #1D4ED8)' }}
            >
              <Sparkles size={26} className="text-pro-gold" aria-hidden />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.6px] text-ink-sub">
                SaFix Pro · Trial
              </p>
              <h2 className="text-[22px] font-bold tracking-[-0.3px] text-ink">
                14 Tage kostenlos
              </h2>
            </div>
          </div>

          {/* Body */}
          <p className="mt-4 text-[14px] leading-relaxed text-ink-sub">
            Du startest jetzt deinen kostenlosen Testzeitraum und erhältst Zugang zu allen
            Pro-Funktionen — ohne Zahlungspflicht.
          </p>

          {/* Timeline */}
          <div className="relative mt-5 rounded-xl bg-canvas p-5 ring-1 ring-edge">
            {/* Connecting line */}
            <div
              className="absolute left-[28px] top-[30px] w-px bg-edge"
              style={{ height: 'calc(100% - 52px)' }}
              aria-hidden
            />

            <ol className="space-y-5">
              <TimelineItem
                dotClass="bg-brand"
                label="Heute"
                body="Trial startet · keine Zahlung erforderlich"
              />
              <TimelineItem
                dotClass="bg-edge"
                label={trialEndDate()}
                body={
                  monthlyPriceString
                    ? `Abo beginnt automatisch · ab ${monthlyPriceString}`
                    : 'Abo beginnt automatisch, falls nicht gekündigt'
                }
              />
              <TimelineItem
                dotClass="bg-edge"
                label="Jederzeit"
                body="Kündigung in den Apple-Einstellungen"
              />
            </ol>
          </div>

          {error && (
            <div className="mt-3 rounded-xl bg-tone-danger-bg px-4 py-3 text-[13px] text-tone-danger-fg ring-1 ring-tone-danger-fg/20">
              {error}
            </div>
          )}

          {/* CTAs */}
          <div className="mt-5 space-y-2">
            <button
              type="button"
              disabled={isStarting}
              onClick={onConfirm}
              className="w-full rounded-[14px] bg-brand py-[15px] text-[15px] font-semibold text-white transition disabled:opacity-50 active:scale-[0.98]"
              style={{ boxShadow: 'var(--shadow-brand-glow)' }}
            >
              {isStarting ? 'Wird gestartet…' : 'Testzeitraum starten'}
            </button>

            <button
              type="button"
              disabled={isStarting}
              onClick={onDismiss}
              className="w-full py-[13px] text-[14px] font-medium text-ink-sub transition hover:text-ink"
            >
              Nicht jetzt
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TimelineItem({
  dotClass,
  label,
  body,
}: {
  dotClass: string
  label: string
  body: string
}) {
  return (
    <li className="relative flex gap-4 pl-2">
      <span
        className={`relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white ${dotClass}`}
        aria-hidden
      />
      <div>
        <p className="text-[13px] font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-sub">{body}</p>
      </div>
    </li>
  )
}
