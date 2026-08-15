import type { WorkerDayState, WorkerQuickAction } from '../../lib/worker/types'

export type { WorkerQuickAction }

type Props = {
  dayState: WorkerDayState
  onAction: (action: WorkerQuickAction) => void
}

type PrimaryBtnProps = {
  label: string
  onClick: () => void
  variant?: 'dark' | 'emerald'
}

function PrimaryBtn({ label, onClick, variant = 'dark' }: PrimaryBtnProps) {
  const cls =
    variant === 'emerald'
      ? 'bg-emerald-600 text-white shadow-[0_12px_28px_-16px_rgba(5,150,105,0.4)]'
      : 'bg-[#0F172A] text-white shadow-[0_12px_28px_-16px_rgba(15,23,42,0.5)]'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-[20px] px-4 py-4 text-[15px] font-semibold transition active:scale-[0.98] ${cls}`}
    >
      {label}
    </button>
  )
}

export default function WorkerStartActionsCard({ dayState, onAction }: Props) {
  // States with no real operative action: don't render dead text under a "Schnellzugriff" header.
  // assignment_open_item → OpenItemsSection below handles it
  // day_complete → TodaySummarySection below handles it
  // workday_calm → no worker-safe routes exist to navigate to
  if (
    dayState === 'workday_calm' ||
    dayState === 'assignment_open_item' ||
    dayState === 'day_complete'
  ) {
    return null
  }

  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Schnellzugriff
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {/* ── Not started: first assignment today waiting ──────────────── */}
        {dayState === 'not_started' && (
          <PrimaryBtn
            label="Einsatz starten"
            onClick={() => onAction('start_assignment')}
          />
        )}

        {/* ── Between assignments: one done, more scheduled ────────────── */}
        {dayState === 'workday_no_assignment' && (
          <PrimaryBtn
            label="Einsatz starten"
            onClick={() => onAction('start_assignment')}
          />
        )}

        {/* ── Assignment active ─────────────────────────────────────────── */}
        {dayState === 'assignment_active' && (
          <PrimaryBtn
            label="Einsatz abschließen"
            onClick={() => onAction('close_assignment')}
          />
        )}
      </div>
    </div>
  )
}
