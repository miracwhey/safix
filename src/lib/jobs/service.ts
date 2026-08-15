import type { JobStatus } from '../shared/coreTypes'
import {
  getJobs,
  getJobById,
  getTeamMembers,
  subscribeJobs,
  reloadJobsFromService,
} from './jobsStore'
import { getJobRepository } from './repository'
import {
  getDerivedDocumentationStatus,
  getNextStep,
  getJobStatusLabel,
  getPaymentStateLabel,
} from './helpers'
import { canTransitionJob } from './stateMachine'
import { filterSupersededJobs } from './canonicalJobResolver'
import { logError } from '../observability'
import type {
  DisputeJobStatus,
  Job,
  JobActivity,
  JobActivityType,
  PaymentState,
} from './types'

function createActivity(
  type: JobActivityType,
  text: string,
  createdAtLabel = 'Gerade eben'
): JobActivity {
  return {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    text,
    createdAtLabel,
  }
}

export { getNextStep }

/**
 * Returns `true` once the job repository has completed its initial data
 * load.  Used by screens to distinguish "not loaded yet" from "genuinely
 * does not exist" without resorting to a timeout.
 */
export function isJobRepositoryHydrated(): boolean {
  return getJobRepository().isHydrated()
}

export function isCompletedJob(job: Job): boolean {
  return job.status === 'completed' || job.status === 'cancelled'
}

export function isActiveJob(job: Job): boolean {
  return job.status !== 'completed' && job.status !== 'cancelled' && job.status !== 'new'
}

export function getActiveJobs(): Job[] {
  return filterSupersededJobs(getJobs().filter(isActiveJob))
}

export function getCompletedJobs(): Job[] {
  return getJobs().filter(isCompletedJob)
}

export function sortJobsByPriority(items: Job[]): Job[] {
  const priority: Record<JobStatus, number> = {
    in_progress: 0,
    waiting_payment: 1,
    scheduled: 2,
    new: 3,
    booked: 3,
    completed: 4,
    cancelled: 5,
  }

  return [...items].sort((a, b) => {
    const statusDiff = priority[a.status] - priority[b.status]
    if (statusDiff !== 0) return statusDiff
    return a.title.localeCompare(b.title, 'de')
  })
}

export { subscribeJobs, getJobs, getJobById, getTeamMembers, reloadJobsFromService }

export function addJob(job: Job): Promise<void> {
  return getJobRepository().add(job)
}

export function linkJobToProject(jobId: string, projectId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.projectId === projectId) return job
    return { ...job, projectId }
  })
}

export function linkJobToSourceOffer(jobId: string, sourceOfferId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.sourceOfferId === sourceOfferId) return job
    return { ...job, sourceOfferId }
  })
}

export function removeJob(jobId: string): Promise<void> {
  return getJobRepository().remove(jobId)
}

/**
 * Updates the canonical display amount on a Job.
 * Called when an accepted ChangeOrder changes the commercial total.
 * Idempotent: no-op if amount already matches.
 */
export function updateJobAmount(jobId: string, amount: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.amount === amount) return job
    return { ...job, amount }
  })
}

export function updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
  // Pre-validate outside the repository updater so illegal transitions
  // throw a rejected promise instead of silently returning the unchanged job.
  const current = getJobById(jobId)
  if (!current) return Promise.resolve()
  if (current.status === status) return Promise.resolve()

  if (!canTransitionJob(current.status, status)) {
    const err = new Error(
      `Illegal job status transition: ${current.status} → ${status} (job ${jobId})`
    )
    logError('jobs.illegal_status_transition', err, {
      jobId,
      from: current.status,
      to: status,
    })
    return Promise.reject(err)
  }

  return getJobRepository().update(
    jobId,
    (job) => {
      // Re-check inside updater for race-condition safety
      if (job.status === status) return job

      return {
        ...job,
        status,
        documentationStatus: getDerivedDocumentationStatus(
          status,
          job.documentationStatus,
          job.photoCount,
          job.notes.length
        ),
        activities: [
          ...job.activities,
          createActivity(
            'status',
            `Status wurde auf „${getJobStatusLabel(status)}" gesetzt.`
          ),
        ],
      }
    },
    // H12 CAS: the pre-check above read `current` from the local cache —
    // the repository turns it into a real compare-and-set against the DB
    // (UPDATE … WHERE status = expectedStatus) so a stale cache can never
    // clobber a row another writer already moved on.
    { expectedStatus: current.status }
  )
}

export function updateJobPaymentState(
  jobId: string,
  paymentState: PaymentState
): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.paymentState === paymentState) return job

    return {
      ...job,
      paymentState,
      activities: [
        ...job.activities,
        createActivity(
          'payment',
          `Zahlung wurde als „${getPaymentStateLabel(paymentState)}" markiert.`
        ),
      ],
    }
  })
}

export function toggleAssignedMember(jobId: string, memberId: string): Promise<void> {
  // Cross-company guard: reject if the member belongs to a different company than the job.
  // Both job.providerId and member.providerId are the canonical providers.id UUID.
  // If either side is unset (legacy data), the guard is skipped — no false rejections.
  const job = getJobById(jobId)
  if (job?.providerId) {
    const member = getTeamMembers().find((m) => m.id === memberId)
    if (member?.providerId && member.providerId !== job.providerId) {
      return Promise.reject(
        new Error(
          `[toggleAssignedMember] member ${memberId} belongs to a different company than job ${jobId}`,
        ),
      )
    }
  }

  return getJobRepository().update(jobId, (j) => {
    const assigned = j.assignedMemberIds.includes(memberId)
      ? j.assignedMemberIds.filter((id) => id !== memberId)
      : [...j.assignedMemberIds, memberId]

    return {
      ...j,
      assignedMemberIds: assigned,
    }
  })
}

/** @deprecated Owner-Notes → `src/lib/owner/ownerNotesWorkflow.ts`. */
export function addJobNote(jobId: string, note: string): Promise<void> {
  const trimmed = note.trim()
  if (!trimmed) return Promise.resolve()

  return getJobRepository().update(jobId, (job) => {
    const nextNotes = [...job.notes, trimmed]

    return {
      ...job,
      notes: nextNotes,
      documentationStatus: getDerivedDocumentationStatus(
        job.status,
        job.documentationStatus,
        job.photoCount,
        nextNotes.length
      ),
      activities: [
        ...job.activities,
        createActivity('note', 'Neue Notiz wurde hinzugefügt.'),
      ],
    }
  })
}

export function updateJobProposalFields(
  jobId: string,
  fields: { amount?: string; description?: string; proposalTimingNote?: string }
): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    const updated: Job = { ...job }
    if (fields.amount !== undefined) updated.amount = fields.amount.trim()
    if (fields.description !== undefined) updated.description = fields.description.trim()
    if (fields.proposalTimingNote !== undefined)
      updated.proposalTimingNote = fields.proposalTimingNote.trim()

    return {
      ...updated,
      activities: [
        ...job.activities,
        createActivity('system', 'Angebotsentwurf wurde gespeichert.'),
      ],
    }
  })
}

export function markProposalSent(jobId: string, sentAt = Date.now()): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.proposalSentAt) return job

    return {
      ...job,
      proposalSentAt: sentAt,
      activities: [
        ...job.activities,
        createActivity('system', 'Angebot wurde an den Kunden übermittelt.'),
      ],
    }
  })
}

export function markProposalAccepted(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.proposalAcceptedAt) return job

    const acceptedAt = Date.now()
    return {
      ...job,
      proposalAcceptedAt: acceptedAt,
      activities: [
        ...job.activities,
        createActivity('system', 'Angebot wurde vom Kunden angenommen.'),
      ],
    }
  })
}

/**
 * @deprecated Kept only for tests / rollback paths. Production code should
 * use `updateJobWorkMarkedComplete` (worker step) and
 * `updateJobWorkConfirmedComplete` (admin step) which match the
 * Block 7.2.1b admin-confirm-gate.
 */
export function updateJobWorkCompleted(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.workCompletedAt) return job

    return {
      ...job,
      workCompletedAt: Date.now(),
      activities: [
        ...job.activities,
        createActivity('system', 'Handwerker hat die Arbeit als abgeschlossen markiert.'),
      ],
    }
  })
}

/**
 * Worker (or solo-owner) reports the job as finished. Sets only
 * `workMarkedCompleteAt`. The admin-confirm step is required before any
 * downstream side-effects (acceptance, tranche release, status change).
 *
 * Idempotent: a second call while still in the marked-only state is a
 * no-op.
 */
export function updateJobWorkMarkedComplete(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.workMarkedCompleteAt) return job

    return {
      ...job,
      workMarkedCompleteAt: Date.now(),
      activities: [
        ...job.activities,
        createActivity('system', 'Arbeit wurde als fertig gemeldet — wartet auf Bestätigung.'),
      ],
    }
  })
}

/**
 * Owner confirms the worker's completion report. Sets
 * `workConfirmedCompleteAt` AND the legacy alias `workCompletedAt` so
 * existing consumers that still read `workCompletedAt` keep working
 * during the transition window.
 *
 * Idempotent.
 */
export function updateJobWorkConfirmedComplete(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.workConfirmedCompleteAt) return job

    const now = Date.now()
    return {
      ...job,
      workConfirmedCompleteAt: now,
      workCompletedAt: job.workCompletedAt ?? now,
      activities: [
        ...job.activities,
        createActivity('system', 'Arbeit wurde vom Betrieb bestätigt.'),
      ],
    }
  })
}

/**
 * Owner rejects the worker's completion report. Clears
 * `workMarkedCompleteAt` so the worker can mark again after correction.
 * Job status is unchanged (stays `in_progress`).
 */
export function updateJobWorkMarkedCompleteCleared(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (!job.workMarkedCompleteAt) return job
    if (job.workConfirmedCompleteAt) return job

    return {
      ...job,
      workMarkedCompleteAt: undefined,
      activities: [
        ...job.activities,
        createActivity('system', 'Bestätigung abgelehnt — Arbeit muss erneut gemeldet werden.'),
      ],
    }
  })
}

type PaymentReleasedActor = 'customer' | 'operator' | 'system' | 'provider' | 'consensus'

function _paymentReleasedActivityText(actor: PaymentReleasedActor): string {
  switch (actor) {
    case 'customer':  return 'Kunde hat die Zahlung freigegeben.'
    case 'operator':  return 'Zahlung durch Streitentscheid freigegeben.'
    case 'system':    return 'Zahlung automatisch freigegeben.'
    case 'provider':  return 'Zahlung freigegeben.'
    // P4 Teil A — two-party consensus split: both parties agreed the split ratio.
    case 'consensus': return 'Zahlung durch einvernehmliche Einigung freigegeben.'
  }
}

export function updateJobPaymentReleased(
  jobId: string,
  actor: PaymentReleasedActor = 'customer'
): Promise<void> {
  const activityText = _paymentReleasedActivityText(actor)
  return getJobRepository().update(jobId, (job) => {
    if (job.paymentReleasedAt) return job

    return {
      ...job,
      paymentReleasedAt: Date.now(),
      activities: [
        ...job.activities,
        createActivity('payment', activityText),
      ],
    }
  })
}

export function updateJobDisputeStatus(
  jobId: string,
  disputeStatus: DisputeJobStatus
): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    if (job.disputeStatus === disputeStatus) return job

    return {
      ...job,
      disputeStatus,
      activities: [
        ...job.activities,
        createActivity('system', `Streitfall-Status: ${disputeStatus}`),
      ],
    }
  })
}

export function addJobPhoto(jobId: string): Promise<void> {
  return getJobRepository().update(jobId, (job) => {
    const nextPhotoCount = job.photoCount + 1

    return {
      ...job,
      photoCount: nextPhotoCount,
      documentationStatus: getDerivedDocumentationStatus(
        job.status,
        job.documentationStatus,
        nextPhotoCount,
        job.notes.length
      ),
      activities: [
        ...job.activities,
        createActivity(
          'photo',
          'Ein neues Foto wurde zur Dokumentation hinzugefügt.'
        ),
      ],
    }
  })
}
