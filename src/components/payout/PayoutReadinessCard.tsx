import type { PayoutReadinessStatus } from '../../lib/payout/types'

type PayoutReadinessCardProps = {
  status: PayoutReadinessStatus
  onSetup: () => void
  disabled?: boolean
}

type StatusConfig = {
  bg: string
  ring: string
  shadow: string
  eyebrow: string
  eyebrowColor: string
  title: string
  titleColor: string
  description: string
  descriptionColor: string
  buttonLabel: string | null
  buttonClass: string | null
}

function getStatusConfig(status: PayoutReadinessStatus): StatusConfig {
  switch (status) {
    case 'no_account':
      return {
        bg: 'bg-amber-50',
        ring: 'ring-amber-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(217,119,6,0.25)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-amber-600/80',
        title: 'Stripe-Auszahlung einrichten',
        titleColor: 'text-amber-900',
        description: 'Verbinde dein Stripe-Konto, um Auszahlungen zu empfangen.',
        descriptionColor: 'text-amber-700/80',
        buttonLabel: 'Jetzt starten',
        buttonClass: 'bg-amber-500 text-white hover:bg-amber-600 active:scale-[0.97]',
      }
    case 'onboarding_required':
      return {
        bg: 'bg-yellow-50',
        ring: 'ring-yellow-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(202,138,4,0.25)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-yellow-700/80',
        title: 'Onboarding erforderlich',
        titleColor: 'text-yellow-900',
        description: 'Dein Stripe-Konto ist noch nicht vollständig eingerichtet.',
        descriptionColor: 'text-yellow-700/80',
        buttonLabel: 'Setup starten',
        buttonClass: 'bg-yellow-500 text-white hover:bg-yellow-600 active:scale-[0.97]',
      }
    case 'onboarding_in_progress':
      return {
        bg: 'bg-blue-50',
        ring: 'ring-blue-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(37,99,235,0.2)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-blue-600/80',
        title: 'Einrichtung läuft...',
        titleColor: 'text-blue-900',
        description: 'Dein Stripe-Onboarding ist in Bearbeitung. Bitte schließe die offenen Schritte ab.',
        descriptionColor: 'text-blue-700/80',
        buttonLabel: 'Bei Stripe fortsetzen',
        buttonClass: 'bg-blue-500 text-white hover:bg-blue-600 active:scale-[0.97]',
      }
    case 'pending_verification':
      return {
        bg: 'bg-indigo-50',
        ring: 'ring-indigo-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(99,102,241,0.2)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-indigo-600/80',
        title: 'Verifizierung läuft',
        titleColor: 'text-indigo-900',
        description: 'Deine Daten werden geprüft. Dies dauert in der Regel 1–2 Werktage.',
        descriptionColor: 'text-indigo-700/80',
        buttonLabel: 'Status prüfen',
        buttonClass: 'bg-indigo-500 text-white hover:bg-indigo-600 active:scale-[0.97]',
      }
    case 'payout_ready':
      return {
        bg: 'bg-emerald-50',
        ring: 'ring-emerald-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(5,150,105,0.2)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-emerald-600/80',
        title: 'Auszahlungen aktiv ✓',
        titleColor: 'text-emerald-900',
        description: 'Dein Stripe-Konto ist vollständig eingerichtet.',
        descriptionColor: 'text-emerald-700/80',
        buttonLabel: null,
        buttonClass: null,
      }
    case 'payout_blocked':
      return {
        bg: 'bg-rose-50',
        ring: 'ring-rose-200',
        shadow: 'shadow-[0_18px_40px_-28px_rgba(225,29,72,0.2)]',
        eyebrow: 'Auszahlungen',
        eyebrowColor: 'text-rose-600/80',
        title: 'Auszahlungen gesperrt',
        titleColor: 'text-rose-900',
        description: 'Dein Stripe-Konto hat offene Anforderungen.',
        descriptionColor: 'text-rose-700/80',
        buttonLabel: 'Anforderungen öffnen',
        buttonClass: 'bg-rose-500 text-white hover:bg-rose-600 active:scale-[0.97]',
      }
  }
}

export default function PayoutReadinessCard({ status, onSetup, disabled = false }: PayoutReadinessCardProps) {
  const cfg = getStatusConfig(status)

  return (
    <div
      className={`rounded-[22px] p-4 ring-1 ${cfg.bg} ${cfg.ring} ${cfg.shadow}`}
    >
      <div className={`text-[12px] font-semibold uppercase tracking-[0.14em] ${cfg.eyebrowColor}`}>
        {cfg.eyebrow}
      </div>
      <div className={`mt-2 text-[17px] font-semibold leading-snug ${cfg.titleColor}`}>
        {cfg.title}
      </div>
      <div className={`mt-1 text-[13px] ${cfg.descriptionColor}`}>
        {cfg.description}
      </div>
      {cfg.buttonLabel !== null && (
        <button
          type="button"
          onClick={onSetup}
          disabled={disabled}
          className={`mt-3 rounded-full px-4 py-1.5 text-[13px] font-semibold transition ${cfg.buttonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {cfg.buttonLabel}
        </button>
      )}
    </div>
  )
}
