import { Link } from 'react-router-dom'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { JobSchedule } from '../../lib/operations'
import { getScheduleReadinessLabel } from '../../lib/operations'
import type { Job } from '../../lib/jobs'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Single schedule row
// ---------------------------------------------------------------------------

type ScheduleRowProps = {
  schedule: JobSchedule
  job: Job | undefined
  accentClass: string
  badgeLabel: string
}

function ScheduleRow({ schedule, job, accentClass, badgeLabel }: ScheduleRowProps) {
  const facts = job ? resolveCanonicalProjectFacts(job.id) : null
  const title = facts?.title ?? job?.title ?? `Auftrag ${schedule.jobId}`
  const customer = facts?.customer ?? job?.customer ?? '—'

  return (
    <Link
      to={`/craftsman/jobs/${schedule.jobId}`}
      className="block rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-slate-900 truncate">
            {title}
          </div>
          <div className="mt-0.5 text-[13px] text-slate-500">{customer}</div>
          <div className="mt-1 text-[12px] text-slate-400">
            {formatShortDate(schedule.scheduledStart)} –{' '}
            {formatTime(schedule.scheduledEnd)} Uhr
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold ${accentClass}`}
        >
          {badgeLabel}
        </span>
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Unscheduled job row
// ---------------------------------------------------------------------------

type UnscheduledRowProps = {
  job: Job
}

function UnscheduledRow({ job }: UnscheduledRowProps) {
  const facts = resolveCanonicalProjectFacts(job.id)
  const displayTitle = facts?.title ?? job.title
  const displayCustomer = facts?.customer ?? job.customer
  const displayLocation = facts?.location ?? job.location

  return (
    <Link
      to={`/craftsman/jobs/${job.id}`}
      className="block rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-slate-900 truncate">
            {displayTitle}
          </div>
          <div className="mt-0.5 text-[13px] text-slate-500">{displayCustomer}</div>
          <div className="mt-1 text-[12px] text-slate-400">{displayLocation}</div>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-500">
          Nicht geplant
        </span>
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Empty state helper
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
      <div className="text-[14px] text-slate-500">{message}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

type Props = {
  overdueSchedules: JobSchedule[]
  todaySchedules: JobSchedule[]
  startingSoonSchedules: JobSchedule[]
  upcomingSchedules: JobSchedule[]
  unscheduledJobs: Job[]
  getJobForSchedule: (jobId: string) => Job | undefined
}

/**
 * Operational scheduling lifecycle surface. Shows schedules bucketed by
 * readiness state (overdue → today → starting soon → upcoming) and surfaces
 * any active jobs that have not yet been scheduled.
 */
export default function SchedulingLifecycleSection({
  overdueSchedules,
  todaySchedules,
  startingSoonSchedules,
  upcomingSchedules,
  unscheduledJobs,
  getJobForSchedule,
}: Props) {
  const totalCount =
    overdueSchedules.length +
    todaySchedules.length +
    startingSoonSchedules.length +
    upcomingSchedules.length

  return (
    <>
      {/* Summary counters */}
      <CraftsmanSectionCard
        eyebrow="Terminübersicht"
        title="Scheduling-Status"
        subtitle="Übersicht aller Ausführungsfenster nach aktuellem Lifecycle-Status."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[20px] bg-rose-50 p-4 ring-1 ring-rose-100">
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-rose-600">
              Überfällig
            </div>
            <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
              {overdueSchedules.length}
            </div>
          </div>

          <div className="rounded-[20px] bg-blue-50 p-4 ring-1 ring-blue-100">
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-blue-600">
              Heute
            </div>
            <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
              {todaySchedules.length}
            </div>
          </div>

          <div className="rounded-[20px] bg-amber-50 p-4 ring-1 ring-amber-100">
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
              Bald
            </div>
            <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
              {startingSoonSchedules.length}
            </div>
          </div>

          <div className="rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Geplant
            </div>
            <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
              {upcomingSchedules.length}
            </div>
          </div>
        </div>
      </CraftsmanSectionCard>

      {/* Overdue */}
      {overdueSchedules.length > 0 && (
        <CraftsmanSectionCard
          eyebrow="Dringend"
          title="Überfällige Termine"
          subtitle="Diese Ausführungsfenster sind abgelaufen und müssen nachgeplant oder abgeschlossen werden."
        >
          <div className="space-y-3">
            {overdueSchedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                job={getJobForSchedule(s.jobId)}
                accentClass="bg-rose-100 text-rose-700"
                badgeLabel={getScheduleReadinessLabel('overdue')}
              />
            ))}
          </div>
        </CraftsmanSectionCard>
      )}

      {/* Today */}
      <CraftsmanSectionCard
        eyebrow="Heute"
        title="Heutige Einsätze"
        subtitle="Alle Ausführungsfenster, die heute stattfinden sollen."
      >
        <div className="space-y-3">
          {todaySchedules.length === 0 ? (
            <EmptyState message="Keine Einsätze für heute eingeplant." />
          ) : (
            todaySchedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                job={getJobForSchedule(s.jobId)}
                accentClass="bg-blue-100 text-blue-700"
                badgeLabel="Heute"
              />
            ))
          )}
        </div>
      </CraftsmanSectionCard>

      {/* Starting soon */}
      {startingSoonSchedules.length > 0 && (
        <CraftsmanSectionCard
          eyebrow="Bald"
          title="Beginnt bald"
          subtitle="Einsätze, die innerhalb der nächsten 2 Stunden starten."
        >
          <div className="space-y-3">
            {startingSoonSchedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                job={getJobForSchedule(s.jobId)}
                accentClass="bg-amber-100 text-amber-700"
                badgeLabel={getScheduleReadinessLabel('starting_soon')}
              />
            ))}
          </div>
        </CraftsmanSectionCard>
      )}

      {/* Upcoming */}
      {totalCount > 0 && upcomingSchedules.length > 0 && (
        <CraftsmanSectionCard
          eyebrow="Vorschau"
          title="Kommende Einsätze"
          subtitle="Alle weiteren geplanten Ausführungsfenster in der Zukunft."
        >
          <div className="space-y-3">
            {upcomingSchedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                job={getJobForSchedule(s.jobId)}
                accentClass="bg-slate-100 text-slate-600"
                badgeLabel={getScheduleReadinessLabel('upcoming')}
              />
            ))}
          </div>
        </CraftsmanSectionCard>
      )}

      {/* Unscheduled active jobs */}
      {unscheduledJobs.length > 0 && (
        <CraftsmanSectionCard
          eyebrow="Handlungsbedarf"
          title="Nicht eingeplant"
          subtitle="Aktive Aufträge ohne Ausführungsfenster — bitte terminieren."
        >
          <div className="space-y-3">
            {unscheduledJobs.map((job) => (
              <UnscheduledRow key={job.id} job={job} />
            ))}
          </div>
        </CraftsmanSectionCard>
      )}
    </>
  )
}
