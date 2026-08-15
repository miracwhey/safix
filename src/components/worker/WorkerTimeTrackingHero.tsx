import { useEffect, useMemo, useRef, useState } from 'react'
import { Briefcase, MapPin, Pause, Play, Square } from 'lucide-react'

import Spinner from '../system/Spinner'
import {
  startActiveDayTimerForMemberWorkflow,
  startActiveJobTimerForMemberWorkflow,
  stopActiveDayTimerForMemberWorkflow,
  stopActiveJobTimerForMemberWorkflow,
  TimeEntryJobAssignmentError,
} from '../../lib/workflow/timeEntryWorkflow'
import {
  computeElapsedMinutes,
  deriveActiveDayState,
  deriveActiveJobState,
} from '../../lib/team/timeEntrySelectors'
import {
  TimeEntryActiveConflictError,
} from '../../lib/team/repository'
import type { TimeEntry } from '../../lib/team/timeEntryTypes'
import type { Job, TeamMember } from '../../lib/jobs/types'

type Props = {
  member: TeamMember
  providerId: string
  activeEntries: TimeEntry[]
  /** Jobs assigned to this worker that have a calendar entry today. */
  todayAssignedJobs: Job[]
}

// Live re-render at 30s intervals — fine-grained enough for an h:mm display
// without burning a useless 60fps tick on the hero card. Guards against
// post-unmount setState by short-circuiting the tick when the component is
// gone, even though clearInterval will fire one tick later in StrictMode.
function useLiveNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let mounted = true
    const id = window.setInterval(() => {
      if (mounted) setNow(new Date())
    }, intervalMs)
    return () => {
      mounted = false
      window.clearInterval(id)
    }
  }, [intervalMs])
  return now
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function formatHoursMinutes(totalMinutes: number): string {
  const safe = Math.max(0, Math.floor(totalMinutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${h}:${m.toString().padStart(2, '0')}`
}

export default function WorkerTimeTrackingHero({
  member,
  providerId,
  activeEntries,
  todayAssignedJobs,
}: Props) {
  const now = useLiveNow()

  const dayState = useMemo(
    () => deriveActiveDayState(activeEntries, member.id),
    [activeEntries, member.id],
  )
  const jobState = useMemo(
    () => deriveActiveJobState(activeEntries, member.id),
    [activeEntries, member.id],
  )

  const [pendingAction, setPendingAction] = useState<
    | null
    | { kind: 'start_day' }
    | { kind: 'stop_day' }
    | { kind: 'start_job'; jobId: string }
    | { kind: 'stop_job' }
  >(null)
  const [error, setError] = useState<string | null>(null)
  // Auto-clear previous error when a new action starts (avoids stale messages)
  const errorClearTimerRef = useRef<number | null>(null)
  // Guards async finally blocks from setState-on-unmounted-component when the
  // worker navigates away mid-flight (e.g. during a 5s slow Supabase round
  // trip on bad mobile network).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (errorClearTimerRef.current != null) window.clearTimeout(errorClearTimerRef.current)
    }
  }, [])

  function clearErrorAfter(ms: number): void {
    if (errorClearTimerRef.current != null) window.clearTimeout(errorClearTimerRef.current)
    errorClearTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setError(null)
    }, ms)
  }

  function showError(message: string): void {
    if (!mountedRef.current) return
    setError(message)
    clearErrorAfter(5000)
  }

  function clearPending(): void {
    if (mountedRef.current) setPendingAction(null)
  }

  async function handleStartDay(): Promise<void> {
    if (pendingAction) return
    setPendingAction({ kind: 'start_day' })
    setError(null)
    try {
      await startActiveDayTimerForMemberWorkflow(member.id, providerId)
    } catch (err) {
      if (err instanceof TimeEntryActiveConflictError) {
        showError('Dein Tag läuft bereits.')
      } else {
        showError('Tag konnte nicht gestartet werden.')
      }
    } finally {
      clearPending()
    }
  }

  async function handleStopDay(): Promise<void> {
    if (pendingAction) return
    setPendingAction({ kind: 'stop_day' })
    setError(null)
    try {
      await stopActiveDayTimerForMemberWorkflow(member.id)
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeEntryDurationTooShortError') {
        showError('Tag läuft erst wenige Sekunden — bitte gleich nochmal.')
      } else if (name === 'TimeEntryAtomicStopFailureError') {
        showError('Auftrag wurde gestoppt, Tag noch offen — bitte erneut beenden.')
      } else {
        showError('Tag konnte nicht beendet werden.')
      }
    } finally {
      clearPending()
    }
  }

  async function handleStartJob(jobId: string): Promise<void> {
    if (pendingAction) return
    setPendingAction({ kind: 'start_job', jobId })
    setError(null)
    try {
      await startActiveJobTimerForMemberWorkflow(member.id, providerId, jobId)
    } catch (err) {
      if (err instanceof TimeEntryActiveConflictError) {
        showError('Du hast bereits einen Auftrag laufen.')
      } else if (err instanceof TimeEntryJobAssignmentError) {
        showError('Du bist diesem Auftrag nicht zugewiesen.')
      } else {
        showError('Auftrag konnte nicht gestartet werden.')
      }
    } finally {
      clearPending()
    }
  }

  async function handleStopJob(): Promise<void> {
    if (pendingAction) return
    setPendingAction({ kind: 'stop_job' })
    setError(null)
    try {
      await stopActiveJobTimerForMemberWorkflow(member.id)
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeEntryDurationTooShortError') {
        showError('Auftrag läuft erst wenige Sekunden — bitte gleich nochmal.')
      } else {
        showError('Auftrag konnte nicht gestoppt werden.')
      }
    } finally {
      clearPending()
    }
  }

  // ── Render branches ─────────────────────────────────────────────────────
  const dayPending = pendingAction?.kind === 'start_day' || pendingAction?.kind === 'stop_day'

  if (dayState.state === 'idle') {
    return (
      <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">Tag</h2>
          <span className="text-[11px] font-medium text-slate-400">Du arbeitest noch nicht</span>
        </div>
        <button
          type="button"
          onClick={handleStartDay}
          disabled={dayPending}
          data-testid="time-tracking-start-day"
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-4 text-[15px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(37,99,235,0.55)] active:scale-[0.99] disabled:bg-slate-300 disabled:shadow-none"
        >
          {dayPending ? (
            <Spinner size="md" tone="current" inButton />
          ) : (
            <Play size={18} aria-hidden />
          )}
          {dayPending ? 'Starte…' : 'Tag starten'}
        </button>
        {error ? <p className="mt-3 text-[13px] text-rose-600">{error}</p> : null}
      </section>
    )
  }

  // dayState.state === 'active'
  const dayMinutes = computeElapsedMinutes(dayState.startedAt, now)
  const dayLocalStart = formatLocalTime(dayState.startedAt)

  return (
    <div className="space-y-3">
      <section
        className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]"
        data-testid="time-tracking-day-active"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">Tag</h2>
          <span className="text-[11px] font-medium text-emerald-700">läuft</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[24px] font-semibold tabular-nums text-slate-900">
            {formatHoursMinutes(dayMinutes)}
          </span>
          <span className="text-[12px] text-slate-500">seit {dayLocalStart} Uhr</span>
        </div>
        <button
          type="button"
          onClick={handleStopDay}
          disabled={dayPending}
          data-testid="time-tracking-stop-day"
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-[13px] font-semibold text-slate-700 active:scale-[0.99] disabled:opacity-50"
        >
          {dayPending ? (
            <Spinner size="sm" tone="current" inButton />
          ) : (
            <Square size={14} aria-hidden />
          )}
          {dayPending ? 'Beende…' : 'Tag beenden'}
        </button>
        {error ? <p className="mt-3 text-[13px] text-rose-600">{error}</p> : null}
      </section>

      {jobState.state === 'active' ? (
        <ActiveJobCard
          jobState={jobState}
          jobs={todayAssignedJobs}
          now={now}
          pending={pendingAction?.kind === 'stop_job'}
          onStop={handleStopJob}
        />
      ) : (
        <UpcomingTodayJobsSection
          jobs={todayAssignedJobs}
          pendingJobId={pendingAction?.kind === 'start_job' ? pendingAction.jobId : null}
          onStart={handleStartJob}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ActiveJobCard({
  jobState,
  jobs,
  now,
  pending,
  onStop,
}: {
  jobState: { state: 'active'; entryId: string; jobId: string; startedAt: string; note: string | null }
  jobs: Job[]
  now: Date
  pending: boolean
  onStop: () => void
}) {
  const job = jobs.find((j) => j.id === jobState.jobId)
  const minutes = computeElapsedMinutes(jobState.startedAt, now)
  const localStart = formatLocalTime(jobState.startedAt)
  return (
    <section
      className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 shadow-[0_8px_24px_-16px_rgba(251,191,36,0.45)]"
      data-testid="time-tracking-job-active"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
          <Briefcase size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
            Aktiver Auftrag
          </div>
          <div className="mt-0.5 truncate text-[14px] font-semibold text-amber-900">
            {job?.title ?? 'Unbekannter Auftrag'}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums text-amber-900">
              {formatHoursMinutes(minutes)}
            </span>
            <span className="text-[12px] text-amber-700">seit {localStart} Uhr</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onStop}
        disabled={pending}
        data-testid="time-tracking-stop-job"
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-amber-900 ring-1 ring-amber-200 active:scale-[0.99] disabled:opacity-50"
      >
        {pending ? (
          <Spinner size="sm" tone="current" inButton />
        ) : (
          <Pause size={14} aria-hidden />
        )}
        {pending ? 'Stoppe…' : 'Auftrag stoppen'}
      </button>
    </section>
  )
}

function UpcomingTodayJobsSection({
  jobs,
  pendingJobId,
  onStart,
}: {
  jobs: Job[]
  pendingJobId: string | null
  onStart: (jobId: string) => void
}) {
  if (jobs.length === 0) return null
  return (
    <section
      className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]"
      data-testid="time-tracking-upcoming-jobs"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold text-slate-900">Heute anstehend</h3>
        <span className="text-[11px] text-slate-400">aus Kalender</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {jobs.map((job) => {
          const isPending = pendingJobId === job.id
          return (
            <li key={job.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                <MapPin size={16} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-slate-900">
                  {job.title || 'Auftrag'}
                </div>
                {job.location ? (
                  <div className="truncate text-[12px] text-slate-500">{job.location}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onStart(job.id)}
                disabled={isPending}
                data-testid={`time-tracking-start-job-${job.id}`}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-100 active:scale-[0.99] disabled:opacity-50"
              >
                {isPending ? (
                  <Spinner size="sm" tone="current" inButton />
                ) : (
                  <Play size={12} aria-hidden />
                )}
                {isPending ? 'Starte…' : 'Auftrag starten'}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
