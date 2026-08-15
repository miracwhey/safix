import type { Job, TeamMember } from './types'

// ---------------------------------------------------------------------------
// Execution Status
// ---------------------------------------------------------------------------

/**
 * Operational execution status — a craftsman-centric lifecycle label that maps
 * the underlying JobStatus to the five stages of real-world execution:
 *
 * - `assigned`         – job accepted but not yet scheduled or started
 * - `scheduled`        – job has a confirmed appointment date
 * - `in_progress`      – craftsman is actively working on the job
 * - `awaiting_payment` – work is complete, waiting for customer payment
 * - `completed`        – job is fully done and payment released
 */
export type ExecutionStatus =
  | 'assigned'
  | 'scheduled'
  | 'in_progress'
  | 'awaiting_payment'
  | 'completed'

export type ExecutionStatusConfig = {
  label: string
  dot: string
  badge: string
  icon: string
}

export const EXECUTION_STATUS_CONFIG: Record<
  ExecutionStatus,
  ExecutionStatusConfig
> = {
  assigned: {
    label: 'Zugewiesen',
    dot: 'bg-sky-500',
    badge: 'bg-sky-50 text-sky-700 ring-sky-200',
    icon: '📋',
  },
  scheduled: {
    label: 'Geplant',
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 text-blue-700 ring-blue-200',
    icon: '📅',
  },
  in_progress: {
    label: 'In Arbeit',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    icon: '🔨',
  },
  awaiting_payment: {
    label: 'Zahlung ausstehend',
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    icon: '💰',
  },
  completed: {
    label: 'Abgeschlossen',
    dot: 'bg-slate-400',
    badge: 'bg-slate-100 text-slate-600 ring-slate-200',
    icon: '✅',
  },
}

/**
 * Maps a Job's current status to the craftsman-facing execution status.
 * Pure function — does not read from any store.
 */
export function deriveExecutionStatus(job: Job): ExecutionStatus {
  switch (job.status) {
    case 'completed':
      return 'completed'
    case 'waiting_payment':
      return 'awaiting_payment'
    case 'in_progress':
      return 'in_progress'
    case 'scheduled':
      return 'scheduled'
    case 'new':
    default:
      return 'assigned'
  }
}

// ---------------------------------------------------------------------------
// Assignment visibility
// ---------------------------------------------------------------------------

/**
 * Returns the names of all team members assigned to a job.
 * Falls back to '—' when no members are assigned.
 */
export function resolveAssigneeLabel(
  job: Job,
  teamMembers: TeamMember[]
): string {
  if (job.assignedMemberIds.length === 0) return '—'
  const memberMap = new Map(teamMembers.map((m) => [m.id, m.name]))
  const names = job.assignedMemberIds
    .map((id) => memberMap.get(id))
    .filter((name): name is string => !!name)
  return names.length > 0 ? names.join(', ') : '—'
}

/**
 * Returns the count of team members currently assigned to a job.
 */
export function getAssigneeCount(job: Job): number {
  return job.assignedMemberIds.length
}

// ---------------------------------------------------------------------------
// Execution Summary
// ---------------------------------------------------------------------------

export type ExecutionSummary = {
  /** Jobs currently being executed */
  inProgress: Job[]
  /** Jobs waiting for customer payment release */
  awaitingPayment: Job[]
  /** Jobs with a confirmed scheduled appointment */
  scheduled: Job[]
  /** New/accepted jobs without a schedule yet */
  assigned: Job[]
  /** Total count of active (non-completed) jobs */
  totalActive: number
  /** Count of active jobs that have at least one assigned team member */
  assignedMemberCount: number
  /** Count of active jobs without any assigned team member */
  unassignedCount: number
}

/**
 * Computes an execution summary from the current job list.
 * Completed jobs are excluded.
 * Pure selector — does not read from any store.
 */
export function deriveExecutionSummary(jobs: Job[]): ExecutionSummary {
  const inProgress: Job[] = []
  const awaitingPayment: Job[] = []
  const scheduled: Job[] = []
  const assigned: Job[] = []
  let assignedMemberCount = 0
  let unassignedCount = 0

  for (const job of jobs) {
    if (job.status === 'completed' || job.status === 'cancelled') continue

    const hasMembers = job.assignedMemberIds.length > 0
    if (hasMembers) {
      assignedMemberCount++
    } else {
      unassignedCount++
    }

    switch (job.status) {
      case 'in_progress':
        inProgress.push(job)
        break
      case 'waiting_payment':
        awaitingPayment.push(job)
        break
      case 'scheduled':
        scheduled.push(job)
        break
      case 'new':
      default:
        assigned.push(job)
        break
    }
  }

  const totalActive =
    inProgress.length +
    awaitingPayment.length +
    scheduled.length +
    assigned.length

  return {
    inProgress,
    awaitingPayment,
    scheduled,
    assigned,
    totalActive,
    assignedMemberCount,
    unassignedCount,
  }
}

// ---------------------------------------------------------------------------
// Scheduling next-step hint
// ---------------------------------------------------------------------------

/**
 * Returns a short German-language hint describing the next operational step
 * for a job based on its execution status.
 *
 * When an optional `fundingStatus` is provided (from the linked funding request),
 * the hint reflects the escrow/funding lifecycle instead of defaulting to
 * scheduling hints for accepted proposals.
 */
export function deriveExecutionNextStep(job: Job, fundingStatus?: string): string {
  switch (job.status) {
    case 'new':
    case 'booked':
      if (job.proposalAcceptedAt) {
        // Accepted proposal — funding-aware next step
        if (fundingStatus === 'funded') {
          return 'Arbeit starten'
        }
        if (fundingStatus === 'funding_started' || fundingStatus === 'funding_initiated') {
          return 'Kundeneinzahlung wird verarbeitet'
        }
        if (fundingStatus === 'sent' || fundingStatus === 'created') {
          return 'Warte auf Kundeneinzahlung'
        }
        return 'Zahlungsaufforderung senden'
      }
      if (job.assignedMemberIds.length === 0) {
        return 'Mitarbeiter zuweisen'
      }
      if (!job.proposalSentAt) {
        return 'Angebot erstellen'
      }
      return 'Termin vereinbaren'
    case 'scheduled':
      return 'Einsatz starten wenn vor Ort'
    case 'in_progress':
      return 'Arbeit dokumentieren & abschließen'
    case 'waiting_payment':
      return 'Auf Zahlungsfreigabe warten'
    case 'completed':
      return 'Abgeschlossen'
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Assignment integrity
// ---------------------------------------------------------------------------

/**
 * Describes the assignment integrity health for the active job list.
 *
 * A job is considered an assignment gap when it is actively being executed
 * (status: `in_progress` or `scheduled`) but has no team members assigned to it.
 * This is a pilot risk because work is happening without clear ownership.
 *
 * `new` jobs are excluded: unassigned new inquiries are expected during intake.
 */
export type AssignmentIntegrityWarning = {
  /** Total active jobs that are `in_progress` or `scheduled` with no assigned member */
  gapCount: number
  /** Jobs that are in_progress without an assigned member — highest severity */
  inProgressUnassigned: Job[]
  /** Jobs that are scheduled without an assigned member — elevated severity */
  scheduledUnassigned: Job[]
  /** True when at least one in_progress job has no assigned member */
  hasActiveGap: boolean
  /** True when there is any assignment gap at all */
  hasAnyGap: boolean
}

/**
 * Derives assignment integrity warnings from the current job list.
 *
 * Pure function — does not read from any store.
 */
export function deriveAssignmentIntegrityWarning(
  jobs: Job[]
): AssignmentIntegrityWarning {
  const inProgressUnassigned: Job[] = []
  const scheduledUnassigned: Job[] = []

  for (const job of jobs) {
    if (job.status === 'completed' || job.status === 'cancelled') continue
    if (job.assignedMemberIds.length > 0) continue

    if (job.status === 'in_progress') {
      inProgressUnassigned.push(job)
    } else if (job.status === 'scheduled') {
      scheduledUnassigned.push(job)
    }
  }

  const gapCount = inProgressUnassigned.length + scheduledUnassigned.length

  return {
    gapCount,
    inProgressUnassigned,
    scheduledUnassigned,
    hasActiveGap: inProgressUnassigned.length > 0,
    hasAnyGap: gapCount > 0,
  }
}
