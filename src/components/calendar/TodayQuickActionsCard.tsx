import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { CalendarEntry } from '../../lib/calendar'

type Props = {
  activeEntry: CalendarEntry | null
  isLoading?: boolean
  onStartJob: () => void
  onSetWaitingPayment: () => void
  onAddPhoto: () => void
  onCreateInvoice: () => void
  onMarkDepositPaid: () => void
}

export default function TodayQuickActionsCard({
  activeEntry,
  isLoading,
  onStartJob,
  onSetWaitingPayment,
  onAddPhoto,
  onCreateInvoice,
  onMarkDepositPaid,
}: Props) {
  const buttonClass =
    'w-full rounded-[20px] bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99] disabled:opacity-50 disabled:active:scale-100'

  return (
    <CraftsmanSectionCard
      eyebrow="Aktionen"
      title="Schnellaktionen"
      subtitle={
        activeEntry
          ? `Aktiver Fokus: ${activeEntry.title}`
          : 'Sobald heute ein Einsatz vorliegt, kannst du ihn hier direkt steuern.'
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          className={buttonClass}
          onClick={onStartJob}
          disabled={!activeEntry || !activeEntry.jobId || isLoading}
        >
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
          disabled={!activeEntry || !activeEntry.jobId || isLoading}
        >
          <div className="text-[15px] font-semibold text-slate-900">
            Zahlung anstoßen
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Status auf Wartet
          </div>
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={onAddPhoto}
          disabled={!activeEntry}
        >
          <div className="text-[15px] font-semibold text-slate-900">
            Foto hinzufügen
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Dokumentation erhöhen
          </div>
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={onCreateInvoice}
          disabled={!activeEntry || !activeEntry.jobId || isLoading}
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
          disabled={!activeEntry || !activeEntry.jobId || isLoading}
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
