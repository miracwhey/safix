import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import {
  getScheduleForJob,
  subscribeOperations,
  getScheduleReadiness,
  getScheduleReadinessLabel,
  type ScheduleReadiness,
} from '../../lib/operations'
import { useStoreSync } from '../../lib/reactive'
import type { JobSchedule } from '../../lib/operations'

type Props = {
  jobId: string
}

type ReadinessStyle = {
  card: string
  badge: string
  dot: string
  icon: string
}

function getReadinessStyle(readiness: ScheduleReadiness): ReadinessStyle {
  switch (readiness) {
    case 'starting_soon':
      return {
        card: 'bg-amber-50 ring-amber-200/80',
        badge: 'bg-amber-100 text-amber-700 ring-amber-200',
        dot: 'bg-amber-500',
        icon: '⏰',
      }
    case 'active':
      return {
        card: 'bg-emerald-50 ring-emerald-200/80',
        badge: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
        dot: 'bg-emerald-500',
        icon: '🔨',
      }
    case 'overdue':
      return {
        card: 'bg-rose-50 ring-rose-200/80',
        badge: 'bg-rose-100 text-rose-700 ring-rose-200',
        dot: 'bg-rose-500',
        icon: '⚠️',
      }
    case 'completed':
      return {
        card: 'bg-white ring-slate-200/70',
        badge: 'bg-slate-100 text-slate-500 ring-slate-200',
        dot: 'bg-emerald-400',
        icon: '✅',
      }
    case 'cancelled':
      return {
        card: 'bg-white ring-slate-200/70',
        badge: 'bg-slate-100 text-slate-500 ring-slate-200',
        dot: 'bg-slate-300',
        icon: '❌',
      }
    case 'upcoming':
    default:
      return {
        card: 'bg-blue-50 ring-blue-100',
        badge: 'bg-blue-100 text-blue-700 ring-blue-200',
        dot: 'bg-blue-400',
        icon: '📅',
      }
  }
}

function formatScheduleDate(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDurationLabel(startMs: number, endMs: number): string {
  const minutes = Math.round((endMs - startMs) / 60_000)
  if (minutes < 60) return `${minutes} Min.`
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  if (remaining === 0) return `${hours} Std.`
  return `${hours} Std. ${remaining} Min.`
}

type ScheduleViewModel = {
  readiness: ScheduleReadiness
  readinessLabel: string
  startLabel: string
  durationLabel: string
  schedule: JobSchedule
}

function buildViewModel(jobId: string): ScheduleViewModel | null {
  const job = getJobById(jobId)
  if (!job) return null

  const schedule = getScheduleForJob(jobId)
  if (!schedule) return null

  const readiness = getScheduleReadiness(schedule, Date.now())
  const readinessLabel = getScheduleReadinessLabel(readiness)

  return {
    readiness,
    readinessLabel,
    startLabel: formatScheduleDate(schedule.scheduledStart),
    durationLabel: formatDurationLabel(schedule.scheduledStart, schedule.scheduledEnd),
    schedule,
  }
}

function CustomerSchedulingCardView({ vm }: { vm: ScheduleViewModel }) {
  const styles = getReadinessStyle(vm.readiness)

  return (
    <section
      className={`rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.18)] ${styles.card}`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className={`h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
          <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Termin
          </span>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${styles.badge}`}
        >
          {vm.readinessLabel}
        </span>
      </div>

      {/* Icon + date row */}
      <div className="mt-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white ring-1 ring-slate-200/70 shadow-[0_6px_16px_-10px_rgba(2,6,23,0.22)]">
          <span className="text-[18px] leading-none">{styles.icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug text-slate-900">
            {vm.startLabel}
          </p>
          <p className="mt-0.5 text-[13px] text-slate-400">
            Dauer: {vm.durationLabel}
          </p>
        </div>
      </div>

      {/* State-specific context note */}
      {vm.readiness === 'starting_soon' && (
        <div className="mt-3 rounded-[18px] bg-amber-100 px-3.5 py-2.5 ring-1 ring-amber-200">
          <p className="text-[13px] font-medium text-amber-800">
            Der Termin beginnt in Kürze. Stelle jetzt sicher, dass der Zugang zum Objekt frei ist und du erreichbar bist.
          </p>
        </div>
      )}

      {vm.readiness === 'active' && (
        <div className="mt-3 rounded-[18px] bg-emerald-100 px-3.5 py-2.5 ring-1 ring-emerald-200">
          <p className="text-[13px] font-medium text-emerald-800">
            Die Ausführung läuft aktuell. Du wirst nach Abschluss benachrichtigt.
          </p>
        </div>
      )}

      {vm.readiness === 'overdue' && (
        <div className="mt-3 rounded-[18px] bg-rose-100 px-3.5 py-2.5 ring-1 ring-rose-200">
          <p className="text-[13px] font-medium text-rose-800">
            {/* "SaFix" is the product/platform name used throughout the app */}
            Der geplante Ausführungszeitpunkt liegt in der Vergangenheit. SaFix klärt den nächsten Schritt.
          </p>
        </div>
      )}

      {vm.readiness === 'upcoming' && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-slate-500">
          Plane voraus: Stelle sicher, dass du am Termintag erreichbar bist und der Zugang zum Objekt gewährleistet ist.
        </p>
      )}
    </section>
  )
}

/**
 * Customer-facing scheduling card for a project/job.
 *
 * Shows the upcoming appointment date, readiness state, and duration.
 * Renders nothing when no schedule exists for the job.
 */
export default function CustomerSchedulingCard({ jobId }: Props) {
  const [vm, setVm] = useState<ScheduleViewModel | null>(() =>
    buildViewModel(jobId)
  )

  useStoreSync(
    [subscribeJobs, subscribeOperations],
    () => setVm(buildViewModel(jobId))
  )

  if (!vm) return null

  return <CustomerSchedulingCardView vm={vm} />
}
