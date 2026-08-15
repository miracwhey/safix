import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { JobSchedule } from '../../lib/operations'

type Props = {
  schedule: JobSchedule | undefined
  onSchedule: () => void
  onConfirmSchedule: () => void
  onReschedule: () => void
  onCancelSchedule: () => void
  onMarkExecutionStarted: () => void
  onMarkExecutionCompleted: () => void
}

function formatWindowLabel(schedule: JobSchedule): string {
  const start = new Date(schedule.scheduledStart).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const end = new Date(schedule.scheduledEnd).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${start} – ${end} Uhr (${schedule.executionWindow} Min.)`
}

function getStatusLabel(status: JobSchedule['schedulingStatus']): string {
  if (status === 'scheduled') return 'Eingeplant'
  if (status === 'execution_started') return 'Ausführung läuft'
  if (status === 'execution_completed') return 'Ausführung abgeschlossen'
  if (status === 'cancelled') return 'Abgesagt'
  return status
}

function getStatusAccentClass(status: JobSchedule['schedulingStatus']): string {
  if (status === 'scheduled') return 'text-blue-600'
  if (status === 'execution_started') return 'text-violet-600'
  if (status === 'execution_completed') return 'text-emerald-600'
  if (status === 'cancelled') return 'text-slate-400'
  return 'text-slate-600'
}

const buttonClass =
  'flex-1 min-w-[140px] rounded-[20px] bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99]'

export default function JobScheduleCard({
  schedule,
  onSchedule,
  onConfirmSchedule,
  onReschedule,
  onCancelSchedule,
  onMarkExecutionStarted,
  onMarkExecutionCompleted,
}: Props) {
  const subtitle = schedule
    ? `Status: ${getStatusLabel(schedule.schedulingStatus)}`
    : 'Noch kein Ausführungsfenster hinterlegt.'

  return (
    <CraftsmanSectionCard
      eyebrow="Zeitplanung"
      title="Ausführungsfenster"
      subtitle={subtitle}
    >
      <div className="space-y-4">
        {schedule ? (
          <div className="space-y-2 text-[14px] text-slate-600">
            <div>
              Zeitfenster:{' '}
              <span className="font-semibold">{formatWindowLabel(schedule)}</span>
            </div>
            <div>
              Status:{' '}
              <span className={`font-semibold ${getStatusAccentClass(schedule.schedulingStatus)}`}>
                {getStatusLabel(schedule.schedulingStatus)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {!schedule ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onSchedule}
            >
              <div className="text-[15px] font-semibold text-slate-900">
                Einplanen
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Zeitfenster anlegen
              </div>
            </button>
          ) : null}

        {/* Both confirm and start-execution are available when status === 'scheduled'.
            Confirming is a soft acknowledgement (logs a timeline event, no status change).
            Starting execution transitions the schedule to execution_started. */}
          {schedule?.schedulingStatus === 'scheduled' ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onConfirmSchedule}
            >
              <div className="text-[15px] font-semibold text-emerald-700">
                Termin bestätigen
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Verbindlich zusagen
              </div>
            </button>
          ) : null}

          {schedule?.schedulingStatus === 'scheduled' ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onReschedule}
            >
              <div className="text-[15px] font-semibold text-amber-700">
                Termin verschieben
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Neuen Zeitpunkt setzen
              </div>
            </button>
          ) : null}

          {schedule?.schedulingStatus === 'scheduled' ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onMarkExecutionStarted}
            >
              <div className="text-[15px] font-semibold text-violet-700">
                Ausführung starten
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Planmäßig beginnen
              </div>
            </button>
          ) : null}

          {(schedule?.schedulingStatus === 'scheduled' ||
            schedule?.schedulingStatus === 'execution_started') ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onCancelSchedule}
            >
              <div className="text-[15px] font-semibold text-rose-700">
                Termin absagen
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Ausführungsfenster stornieren
              </div>
            </button>
          ) : null}

          {schedule?.schedulingStatus === 'execution_started' ? (
            <button
              type="button"
              className={buttonClass}
              onClick={onMarkExecutionCompleted}
            >
              <div className="text-[15px] font-semibold text-emerald-700">
                Ausführung abschließen
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Planmäßig fertig
              </div>
            </button>
          ) : null}

          {schedule?.schedulingStatus === 'execution_completed' ? (
            <div className="rounded-[20px] bg-emerald-50 px-4 py-4 ring-1 ring-emerald-200/60">
              <div className="text-[15px] font-semibold text-emerald-700">
                Ausführung fertig
              </div>
              <div className="mt-1 text-[13px] text-emerald-600">
                Planmäßig abgeschlossen
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
