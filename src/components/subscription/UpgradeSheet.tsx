/**
 * UpgradeSheet — Block E v2
 *
 * Shown when a blocked (expired or trial_available) owner triggers a Pro action.
 * Navigates to ProSubscriptionScreen for IAP purchase — does not handle purchase itself.
 *
 * actionLabel: optional action-specific text, e.g. "Angebot senden".
 * monthlyPriceString: optional StoreKit-localized price for feature mini-box footer.
 */

import { useNavigate } from 'react-router-dom'
import { Check, Sparkles } from 'lucide-react'

const PRO_FEATURES_SHORT = [
  'Anfragen & Angebote',
  'Rechnungen schreiben',
  'Auszahlungen empfangen',
  'Team & Kalender',
  'Finance-Dashboard',
]

type Props = {
  onDismiss: () => void
  isExpired?: boolean
  /** Action that was blocked, shown in headline. */
  actionLabel?: string
  /** StoreKit-localized price, e.g. "149,99 €/Monat". Optional. */
  monthlyPriceString?: string | null
}

export default function UpgradeSheet({
  onDismiss,
  isExpired = false,
  actionLabel,
  monthlyPriceString,
}: Props) {
  const navigate = useNavigate()

  function handleGetPro() {
    onDismiss()
    navigate('/craftsman/subscription')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/38 backdrop-blur-[0.5px]">
      <div className="w-full max-w-[420px] rounded-t-[20px] bg-white pb-[max(32px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_30px_rgba(0,0,0,0.18)]">
        {/* Drag handle */}
        <div className="mx-auto mb-[18px] h-1 w-9 rounded-full bg-edge" />

        <div className="px-[22px]">
          {/* Badge */}
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2px] text-brand">
            <Sparkles size={11} aria-hidden />
            Pro-Funktion
          </div>

          {/* Headline */}
          <h2 className="mt-3 text-[22px] font-bold tracking-[-0.4px] text-ink">
            {actionLabel
              ? `Um „${actionLabel}" zu nutzen, brauchst du Pro.`
              : isExpired
                ? 'Reaktiviere SaFix Pro, um weiterzumachen.'
                : 'Diese Funktion ist Teil von SaFix Pro.'}
          </h2>

          <p className="mt-2 text-[14px] leading-relaxed text-ink-sub">
            {isExpired
              ? 'Dein Testzeitraum oder Abo ist abgelaufen.'
              : 'Schalte alle Funktionen frei und bringe deinen Betrieb voran.'}
          </p>

          {/* Feature mini-box */}
          <div className="mt-5 rounded-xl bg-canvas p-4 ring-1 ring-edge">
            <ul className="space-y-2">
              {PRO_FEATURES_SHORT.map((f) => (
                <li key={f} className="flex items-center gap-2.5">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-tint">
                    <Check size={11} className="text-brand" aria-hidden />
                  </div>
                  <span className="text-[13px] font-medium text-ink">{f}</span>
                </li>
              ))}
            </ul>
            {monthlyPriceString && (
              <p className="mt-3 text-right text-[12px] text-ink-sub">
                Ab {monthlyPriceString}
              </p>
            )}
          </div>

          {/* CTAs */}
          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={handleGetPro}
              className="w-full rounded-[14px] bg-brand py-[15px] text-[15px] font-semibold text-white transition active:scale-[0.98]"
              style={{ boxShadow: 'var(--shadow-brand-glow)' }}
            >
              {isExpired ? 'Pro reaktivieren' : 'SaFix Pro holen'}
            </button>

            <button
              type="button"
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
