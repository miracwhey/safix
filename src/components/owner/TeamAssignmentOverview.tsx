import { useMemo } from 'react'
import type { Job } from '../../lib/jobs'
import type { TeamMember } from '../../lib/jobs'
import {
  getUnassignedJobs,
  getUpcomingWorkPressure,
} from '../../lib/jobs/teamWorkloadSelectors'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<Job['status'], string> = {
  new: 'bg-sky-400',
  booked: 'bg-sky-400',
  scheduled: 'bg-blue-400',
  in_progress: 'bg-emerald-400',
  waiting_payment: 'bg-amber-400',
  completed: 'bg-slate-300',
  cancelled: 'bg-rose-300',
}

const STATUS_LABEL: Record<Job['status'], string> = {
  new: 'Neu',
  booked: 'Gebucht',
  scheduled: 'Geplant',
  in_progress: 'In Arbeit',
  waiting_payment: 'Zahlung',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
}

function SectionHeading({
  icon,
  label,
  count,
}: {
  icon: string
  label: string
  count: number
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[15px] leading-none">{icon}</span>
      <span className="text-[13px] font-semibold text-slate-700">{label}</span>
      {count > 0 && (
        <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-slate-100 px-1.5 text-[11px] font-bold text-slate-600">
          {count}
        </span>
      )}
    </div>
  )
}

/** Resolves assigned member names for a job */
function resolveAssigneeNames(
  job: Job,
  memberMap: Map<string, string>
): string {
  if (job.assignedMemberIds.length === 0) return '—'
  return job.assignedMemberIds
    .map((id) => memberMap.get(id) ?? id)
    .join(', ')
}

/** A single row in the assignment overview */
function AssignmentRow({
  job,
  assigneeLabel,
  dimmed,
}: {
  job: Job
  assigneeLabel: string
  dimmed?: boolean
}) {
  const facts = resolveCanonicalProjectFacts(job.id)
  const displayTitle = facts?.title ?? job.title
  const displayCustomer = facts?.customer ?? job.customer
  const displayDateLabel = facts?.dateLabel ?? job.dateLabel

  return (
    <div
      className={`flex items-center gap-3 rounded-2xl px-4 py-3 ring-1 transition ${
        dimmed
          ? 'bg-rose-50 ring-rose-200/70'
          : 'bg-slate-50 ring-slate-200/60'
      }`}
    >
      {/* Status dot */}
      <span
        className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[job.status]}`}
      />

      {/* Job info */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-slate-900">
          {displayTitle}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-slate-500">
          {displayCustomer} · {displayDateLabel}
        </div>
      </div>

      {/* Right: status + assignee */}
      <div className="shrink-0 text-right">
        <div
          className={`text-[12px] font-semibold ${
            dimmed ? 'text-rose-600' : 'text-slate-600'
          }`}
        >
          {STATUS_LABEL[job.status]}
        </div>
        <div
          className={`mt-0.5 max-w-[100px] truncate text-[11px] ${
            dimmed ? 'text-rose-400' : 'text-slate-400'
          }`}
        >
          {dimmed ? '⚠ Nicht zugeteilt' : assigneeLabel}
        </div>
      </div>
    </div>
  )
}

// ─── Public Component ─────────────────────────────────────────────────────────

type Props = {
  jobs: Job[]
  teamMembers: TeamMember[]
}

/**
 * TeamAssignmentOverview
 *
 * Owner-facing component that gives a clear view of:
 * - All current active job assignments (in_progress + scheduled)
 * - Unassigned jobs that still need a worker allocated
 * - Upcoming jobs with their assigned worker names
 *
 * Pure display component — receives jobs + teamMembers from parent via store
 * subscriptions. Does not mutate state.
 */
export default function TeamAssignmentOverview({ jobs, teamMembers }: Props) {
  // Build a quick lookup: memberId → name
  const memberMap = useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m.name])),
    [teamMembers]
  )

  // Active jobs (in_progress)
  const activeJobs = useMemo(
    () => jobs.filter((job) => job.status === 'in_progress'),
    [jobs]
  )

  // Upcoming / scheduled
  const upcomingJobs = useMemo(() => getUpcomingWorkPressure(jobs), [jobs])

  // Unassigned (no member IDs, not completed)
  const unassignedJobs = useMemo(() => getUnassignedJobs(jobs), [jobs])

  const hasContent =
    activeJobs.length > 0 ||
    upcomingJobs.length > 0 ||
    unassignedJobs.length > 0

  if (!hasContent) {
    return (
      <p className="text-[14px] text-slate-400">
        Aktuell keine laufenden oder geplanten Aufträge.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      {/* ── Unassigned — needs staffing ── */}
      {unassignedJobs.length > 0 && (
        <div className="space-y-2">
          <SectionHeading
            icon="⚠️"
            label="Nicht zugeteilt"
            count={unassignedJobs.length}
          />
          {unassignedJobs.map((job) => (
            <AssignmentRow
              key={job.id}
              job={job}
              assigneeLabel="—"
              dimmed
            />
          ))}
        </div>
      )}

      {/* ── Active jobs in progress ── */}
      {activeJobs.length > 0 && (
        <div className="space-y-2">
          <SectionHeading
            icon="🔨"
            label="In Durchführung"
            count={activeJobs.length}
          />
          {activeJobs.map((job) => (
            <AssignmentRow
              key={job.id}
              job={job}
              assigneeLabel={resolveAssigneeNames(job, memberMap)}
            />
          ))}
        </div>
      )}

      {/* ── Upcoming / scheduled ── */}
      {upcomingJobs.length > 0 && (
        <div className="space-y-2">
          <SectionHeading
            icon="📅"
            label="Demnächst geplant"
            count={upcomingJobs.length}
          />
          {upcomingJobs.map((job) => (
            <AssignmentRow
              key={job.id}
              job={job}
              assigneeLabel={resolveAssigneeNames(job, memberMap)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
