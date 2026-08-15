import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  isLoading?: boolean
  onStartJob: () => void
  onSetWaitingPayment: () => void
  onCreateInvoice: () => void
  onMarkDepositPaid: () => void
}

export default function JobOperationsCard({
  isLoading,
  onStartJob,
  onSetWaitingPayment,
  onCreateInvoice,
  onMarkDepositPaid,
}: Props) {
  const buttonClass =
    'w-full rounded-[20px] bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99] disabled:opacity-50 disabled:active:scale-100'

  return (
    <CraftsmanSectionCard
      eyebrow="Operation"
      title="Schnellaktionen"
      subtitle="Hier steuerst du die wichtigsten operativen Schritte direkt im Auftrag."
    >
      <div className="grid grid-cols-2 gap-3">
        <button type="button" className={buttonClass} onClick={onStartJob} disabled={isLoading}>
          <div className="text-[15px] font-semibold text-slate-900">
            Job starten
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Status auf In Arbeit
          </div>
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={onSetWaitingPayment}
          disabled={isLoading}
        >
          <div className="text-[15px] font-semibold text-slate-900">
            Zahlung anstoßen
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Wartet auf Zahlung
          </div>
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={onCreateInvoice}
          disabled={isLoading}
        >
          <div className="text-[15px] font-semibold text-slate-900">
            Rechnung anlegen
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Invoice vorbereiten
          </div>
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={onMarkDepositPaid}
          disabled={isLoading}
        >
          <div className="text-[15px] font-semibold text-slate-900">
            Einzahlung bestätigt
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Payment auf bezahlt
          </div>
        </button>
      </div>
    </CraftsmanSectionCard>
  )
}
