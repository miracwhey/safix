import { useMemo } from 'react'
import type { Job } from '../../lib/jobs'
import type { TeamMember } from '../../lib/jobs'
import {
  getTeamWorkloadDistribution,
  type WorkerWorkload,
} from '../../lib/jobs/teamWorkloadSelectors'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Inhaber',
  worker: 'Mitarbeiter',
  craftsman: 'Handwerker',
}

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

/** Single active job row inside a worker's workload bucket */
function ActiveJobRow({ job }: { job: Job }) {
  const facts = resolveCanonicalProjectFacts(job.id)
  const displayTitle = facts?.title ?? job.title

  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[job.status]}`}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-600">
        {displayTitle}
      </span>
      <span className="shrink-0 text-[11px] font-medium text-slate-400">
        {STATUS_LABEL[job.status]}
      </span>
    </div>
  )
}

/** Workload badge showing job count with colour-coded pressure */
function WorkloadBadge({ count }: { count: number }) {
  const style =
    count === 0
      ? 'bg-slate-100 text-slate-400'
      : count >= 4
        ? 'bg-rose-100 text-rose-700'
        : count >= 2
          ? 'bg-amber-100 text-amber-700'
          : 'bg-emerald-100 text-emerald-700'

  return (
    <span
      className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${style}`}
    >
      {count}
    </span>
  )
}

/** Card row for a single team member */
function WorkerRow({ workload }: { workload: WorkerWorkload }) {
  const activeJobs = workload.activeJobs.slice(0, 3)
  const overflow = workload.activeJobs.length - 3

  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60">
      {/* Header: name + role + badge */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="text-[14px] font-semibold text-slate-900 truncate block">
            {workload.memberName}
          </span>
          <span className="text-[11px] text-slate-400">
            {ROLE_LABEL[workload.memberRole] ?? workload.memberRole}
          </span>
        </div>
        <WorkloadBadge count={workload.activeJobs.length} />
      </div>

      {/* Active job list */}
      {activeJobs.length > 0 && (
        <div className="mt-2 space-y-1">
          {activeJobs.map((job) => (
            <ActiveJobRow key={job.id} job={job} />
          ))}
          {overflow > 0 && (
            <span className="text-[11px] text-slate-400">
              +{overflow} weitere
            </span>
          )}
        </div>
      )}

      {activeJobs.length === 0 && (
        <p className="mt-1.5 text-[12px] text-slate-400">Keine aktiven Jobs</p>
      )}
    </div>
  )
}

// ─── Public Component ────────────────────────────────────────────────────────

type Props = {
  jobs: Job[]
  teamMembers: TeamMember[]
}

/**
 * TeamWorkloadCard
 *
 * Shows owner-facing workload distribution for each team member:
 * - Name, role, and a colour-coded active-job count badge
 * - List of active/scheduled jobs per worker (capped at 3 + overflow count)
 * - Empty state when no team members are present
 *
 * Pure display component — receives derived data from parent; does NOT
 * call selectors internally so it stays testable and stateless.
 */
export default function TeamWorkloadCard({ jobs, teamMembers }: Props) {
  const distribution = useMemo(
    () => getTeamWorkloadDistribution(jobs, teamMembers),
    [jobs, teamMembers]
  )

  if (distribution.length === 0) {
    return (
      <div className="rounded-2xl bg-slate-50 px-4 py-4 ring-1 ring-slate-200/60">
        <p className="text-[14px] font-semibold text-slate-900">
          Keine Teammitglieder
        </p>
        <p className="mt-1 text-[13px] text-slate-500">
          Füge Mitarbeiter hinzu, um die Auslastung hier zu sehen.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {distribution.map((workload) => (
        <WorkerRow key={workload.memberId} workload={workload} />
      ))}
    </div>
  )
}
