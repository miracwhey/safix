import type { WorkerDayState, AssignmentSnapshot } from '../../lib/worker/types'

export type { WorkerDayState, AssignmentSnapshot }

type Props = {
  dayState: WorkerDayState
  currentAssignment: AssignmentSnapshot | null
  nextAssignment: AssignmentSnapshot | null
  /** Called when the user taps the main card in states that have a navigation target. */
  onTap?: () => void
}

function DarkMetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-white/8 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold text-white">{value}</div>
    </div>
  )
}

function LightMetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-slate-50 px-4 py-3 ring-1 ring-slate-100">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold text-slate-900">{value}</div>
    </div>
  )
}

/** Extracts end time from "08:00–14:00" or "08:00 – 14:00" → "14:00" */
function parseEndTime(timeWindow: string): string {
  const parts = timeWindow.split('\u2013').map((s) => s.trim())
  return parts.length === 2 ? parts[1] : timeWindow
}

export default function WorkerStartMainCard({ dayState, currentAssignment, nextAssignment, onTap }: Props) {
  // ── Active assignment ─────────────────────────────────────────────────────
  if (dayState === 'assignment_active' && currentAssignment) {
    return (
      <div
        role={onTap ? 'button' : undefined}
        tabIndex={onTap ? 0 : undefined}
        onClick={onTap}
        onKeyDown={onTap ? (e) => { if (e.key === 'Enter' || e.key === ' ') onTap() } : undefined}
        className={`rounded-[28px] bg-[#0F172A] p-5 shadow-[0_24px_48px_-20px_rgba(15,23,42,0.55)]${onTap ? ' cursor-pointer transition active:scale-[0.98]' : ''}`}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
            Aktiv jetzt
          </span>
          {currentAssignment.runningMinutes !== undefined && (
            <span className="ml-auto text-[12px] text-white/40">
              seit {currentAssignment.runningMinutes} Min.
            </span>
          )}
          {onTap && (
            <span className="ml-auto text-[12px] text-white/30">Details →</span>
          )}
        </div>

        <div className="mt-3 text-[20px] font-semibold leading-snug text-white">
          {currentAssignment.title}
        </div>
        <div className="mt-0.5 text-[14px] text-slate-400">{currentAssignment.customer}</div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <DarkMetaCell label="Ende" value={parseEndTime(currentAssignment.timeWindow)} />
          <DarkMetaCell label="Ort" value={currentAssignment.location} />
        </div>
      </div>
    )
  }

  // ── Open documentation/completion item ────────────────────────────────────
  if (dayState === 'assignment_open_item' && currentAssignment) {
    return (
      <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 rounded-full bg-orange-400" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-orange-600">
            Doku offen
          </span>
        </div>

        <div className="mt-3 text-[20px] font-semibold leading-snug text-slate-900">
          {currentAssignment.title}
        </div>
        <div className="mt-0.5 text-[14px] text-slate-500">{currentAssignment.customer}</div>

        <button
          type="button"
          onClick={onTap}
          disabled={!onTap}
          className="mt-4 w-full rounded-[18px] bg-orange-50 px-4 py-3 ring-1 ring-orange-100 text-left transition active:scale-[0.98] active:bg-orange-100 disabled:cursor-default"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-500">
            Fehlt noch
          </div>
          <div className="flex items-center justify-between mt-0.5">
            <div className="text-[14px] font-semibold text-slate-900">
              Dokumentation abschließen
            </div>
            {onTap && <span className="text-[13px] text-orange-400">→</span>}
          </div>
        </button>
      </div>
    )
  }

  // ── Workday started, next assignment waiting ──────────────────────────────
  if (dayState === 'workday_no_assignment' && nextAssignment) {
    return (
      <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
        <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Nächster Einsatz
        </div>

        <div className="mt-3 text-[20px] font-semibold leading-snug text-slate-900">
          {nextAssignment.title}
        </div>
        <div className="mt-0.5 text-[14px] text-slate-500">{nextAssignment.customer}</div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <LightMetaCell label="Zeitfenster" value={nextAssignment.timeWindow} />
          <LightMetaCell label="Ort" value={nextAssignment.location} />
        </div>
      </div>
    )
  }

  // ── Calm — nothing today ─────────────────────────────────────────────────
  if (dayState === 'workday_calm') {
    return (
      <div className="rounded-[28px] bg-blue-50 p-5 ring-1 ring-blue-100 shadow-[0_18px_40px_-28px_rgba(37,99,235,0.14)]">
        <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-blue-600">
          Tagesstatus
        </div>

        <div className="mt-3 text-[20px] font-semibold leading-snug text-slate-900">
          {nextAssignment ? 'Freier Tag' : 'Kein Einsatz geplant'}
        </div>

        <div className="mt-1 text-[14px] text-slate-500">
          {nextAssignment
            ? 'Heute nichts geplant — der nächste Einsatz wartet bereits.'
            : 'Aktuell sind keine Einsätze eingeplant.'}
        </div>
      </div>
    )
  }

  // ── Day cleanly completed ─────────────────────────────────────────────────
  if (dayState === 'day_complete') {
    return (
      <div className="rounded-[28px] bg-emerald-50 p-5 ring-1 ring-emerald-100 shadow-[0_18px_40px_-28px_rgba(5,150,105,0.14)]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-emerald-600">
            Abgeschlossen
          </span>
        </div>

        <div className="mt-3 text-[20px] font-semibold leading-snug text-slate-900">
          Guter Arbeitstag
        </div>
        <div className="mt-1 text-[14px] text-slate-500">
          Alle Einsätze erledigt.
        </div>
      </div>
    )
  }

  // ── Not started (default) ─────────────────────────────────────────────────
  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        Arbeitstag
      </div>

      <div className="mt-3 text-[20px] font-semibold leading-snug text-slate-900">
        Noch nicht gestartet
      </div>

      {nextAssignment ? (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
            Erster Einsatz heute
          </div>
          <div className="mt-2 rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-100">
            <div className="text-[15px] font-semibold text-slate-900">{nextAssignment.title}</div>
            <div className="mt-0.5 text-[13px] text-slate-500">
              {nextAssignment.timeWindow} · {nextAssignment.customer}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[14px] text-slate-500">
          Für heute sind noch keine Einsätze eingeplant.
        </div>
      )}
    </div>
  )
}
