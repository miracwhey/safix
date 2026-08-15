/**
 * Time-Entry workflows — Block 2.
 *
 * Three defense layers, mirroring the 7.2.1c pattern used elsewhere:
 *   1. UI gate: WorkerHomeScreen / CraftsmanTeamHubScreen control who sees the action.
 *   2. Workflow gate: `assertWorkerOrOwnerForMember` here, plus `assertOwnerRole`
 *      for the reject path.
 *   3. RLS / DB constraints: `time_entries_*` policies + the unique partial
 *      indices `time_entries_active_{day,job}_unique`.
 *
 * The workflow exposes member-centric entry points (e.g. `startActiveDayTimerForMember`)
 * so the UI never juggles entry IDs across the day↔job atomic-stop dance.
 *
 * Atomic stop policy: when the worker beends the day timer while a job timer
 * is still running, the workflow closes the job timer first and then the day
 * timer in a tight sequence. There is no DB-side transaction; both writes are
 * idempotent (status='active' → 'closed' only) so a partial failure leaves the
 * system in a recoverable state (the worker may retry).
 */

import type { SessionState } from '../session'
import { assertOwnerRole, assertWorkerOrOwnerForMember, resolveSession } from '../auth/rbacGuards'
import { getJobs } from '../jobs'
import {
  getTimeEntryRepository,
  TimeEntryNotFoundError,
} from '../team/repository'
import {
  computeElapsedMinutes,
  deriveActiveDayState,
  deriveActiveJobState,
} from '../team/timeEntrySelectors'
import type { TimeEntry } from '../team/timeEntryTypes'

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class TimeEntryJobAssignmentError extends Error {
  readonly memberId: string
  readonly jobId: string
  constructor(memberId: string, jobId: string) {
    super(`Member ${memberId} is not assigned to job ${jobId}`)
    this.name = 'TimeEntryJobAssignmentError'
    this.memberId = memberId
    this.jobId = jobId
  }
}

export class TimeEntryNoActiveTimerError extends Error {
  readonly memberId: string
  readonly kind: 'day' | 'job'
  constructor(memberId: string, kind: 'day' | 'job') {
    super(`No active ${kind} timer for member ${memberId}`)
    this.name = 'TimeEntryNoActiveTimerError'
    this.memberId = memberId
    this.kind = kind
  }
}

/**
 * Stop refused because elapsed time rounds down to <1 minute.
 *
 * Without this guard, `Math.max(1, computeElapsedMinutes(...))` would
 * inject a phantom minute the worker did not actually work — silently
 * inflating weekly totals on misclick / fat-finger stop. Worker can
 * retry once a real minute has elapsed, or owner can reject if the
 * timer was started by mistake (worker DELETE policy on active rows
 * also covers the immediate-undo case).
 */
export class TimeEntryDurationTooShortError extends Error {
  readonly memberId: string
  readonly kind: 'day' | 'job'
  constructor(memberId: string, kind: 'day' | 'job') {
    super(`Cannot stop ${kind} timer — less than one minute elapsed`)
    this.name = 'TimeEntryDurationTooShortError'
    this.memberId = memberId
    this.kind = kind
  }
}

/**
 * Day-stop succeeded only partially: the auto-closed job timer landed,
 * but the day-close write failed. The worker must retry the day-stop;
 * the system is in a recoverable state (job is correctly closed, day
 * timer remains active until next attempt).
 */
export class TimeEntryAtomicStopFailureError extends Error {
  readonly memberId: string
  readonly cause: unknown
  constructor(memberId: string, cause: unknown) {
    super(`Day-stop failed after job auto-close for member ${memberId}; retry day-stop`)
    this.name = 'TimeEntryAtomicStopFailureError'
    this.memberId = memberId
    this.cause = cause
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Common workflow options
// ─────────────────────────────────────────────────────────────────────────────

type StartOptions = {
  note?: string | null
  session?: SessionState
  now?: Date
}

type StopOptions = {
  session?: SessionState
  now?: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Day timer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts an active 'day' timer for the member. Throws TimeEntryActiveConflictError
 * if one is already running.
 */
export async function startActiveDayTimerForMemberWorkflow(
  memberId: string,
  providerId: string,
  options: StartOptions = {},
): Promise<TimeEntry> {
  assertWorkerOrOwnerForMember(memberId, options.session, providerId)
  const startedAt = (options.now ?? new Date()).toISOString()
  return getTimeEntryRepository().create({
    memberId,
    providerId,
    kind: 'day',
    jobId: null,
    startedAt,
    note: options.note ?? null,
  })
}

/**
 * Stops the active 'day' timer for the member.
 *
 * Atomic auto-stop: if a 'job' timer is also active, it is closed first
 * (otherwise the worker would have a job-timer running without a day-timer,
 * which the Hub UI would render as inconsistent state).
 */
export async function stopActiveDayTimerForMemberWorkflow(
  memberId: string,
  options: StopOptions = {},
): Promise<{ day: TimeEntry; job?: TimeEntry }> {
  assertWorkerOrOwnerForMember(memberId, options.session)
  const repo = getTimeEntryRepository()
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()

  // Pre-validate BOTH timers before writing anything.  Without this, the day
  // and job pre-images can drift (e.g. day already closed by realtime, but job
  // is still active locally) and we end up with half-applied state.
  const activeJob = deriveActiveJobState(repo.getAll(), memberId)
  const activeDay = deriveActiveDayState(repo.getAll(), memberId)
  if (activeDay.state !== 'active') {
    throw new TimeEntryNoActiveTimerError(memberId, 'day')
  }
  const dayMinutes = computeElapsedMinutes(activeDay.startedAt, now)
  if (dayMinutes < 1) {
    throw new TimeEntryDurationTooShortError(memberId, 'day')
  }
  const jobMinutes =
    activeJob.state === 'active'
      ? computeElapsedMinutes(activeJob.startedAt, now)
      : null
  if (jobMinutes !== null && jobMinutes < 1) {
    throw new TimeEntryDurationTooShortError(memberId, 'job')
  }

  let alsoClosedJob: TimeEntry | undefined
  if (activeJob.state === 'active' && jobMinutes !== null) {
    alsoClosedJob = await repo.update(activeJob.entryId, {
      status: 'closed',
      endedAt: nowIso,
      durationMinutes: jobMinutes,
    })
  }

  // Day-close after job-close.  If the job is closed but the day write fails,
  // the worker is left in an inconsistent intermediate state — surface that
  // explicitly so the UI can show "Tag erneut beenden" instead of a generic
  // "fehlgeschlagen" toast.
  let dayEntry: TimeEntry
  try {
    dayEntry = await repo.update(activeDay.entryId, {
      status: 'closed',
      endedAt: nowIso,
      durationMinutes: dayMinutes,
    })
  } catch (err) {
    if (alsoClosedJob) {
      throw new TimeEntryAtomicStopFailureError(memberId, err)
    }
    throw err
  }
  return { day: dayEntry, job: alsoClosedJob }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job timer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts an active 'job' timer for the member.
 *
 * Pre-check: the member must be in the job's `assignedMemberIds` array.
 * Without that check, the DB-side policy `time_entries_worker_insert` would
 * reject with a generic RLS error — the explicit error here gives the UI a
 * clean message ("Du bist diesem Auftrag nicht zugewiesen.").
 *
 * The "is the job on today's calendar?" check is intentionally NOT enforced
 * here. The Plan classifies that as a soft warning to be surfaced by the UI
 * (e.g. "morgen geplant — trotzdem starten?"); the workflow stays liberal so
 * the worker can self-correct in unusual situations.
 */
export async function startActiveJobTimerForMemberWorkflow(
  memberId: string,
  providerId: string,
  jobId: string,
  options: StartOptions = {},
): Promise<TimeEntry> {
  assertWorkerOrOwnerForMember(memberId, options.session, providerId)
  const job = getJobs().find((j) => j.id === jobId)
  if (!job) {
    throw new Error(`Job ${jobId} not found`)
  }
  if (!job.assignedMemberIds.includes(memberId)) {
    throw new TimeEntryJobAssignmentError(memberId, jobId)
  }
  const startedAt = (options.now ?? new Date()).toISOString()
  return getTimeEntryRepository().create({
    memberId,
    providerId,
    kind: 'job',
    jobId,
    startedAt,
    note: options.note ?? null,
  })
}

/**
 * Stops the active 'job' timer for the member. Leaves the day timer alone —
 * the worker may pause between jobs without ending their day.
 */
export async function stopActiveJobTimerForMemberWorkflow(
  memberId: string,
  options: StopOptions = {},
): Promise<TimeEntry> {
  assertWorkerOrOwnerForMember(memberId, options.session)
  const repo = getTimeEntryRepository()
  const now = options.now ?? new Date()
  const active = deriveActiveJobState(repo.getAll(), memberId)
  if (active.state !== 'active') {
    throw new TimeEntryNoActiveTimerError(memberId, 'job')
  }
  const minutes = computeElapsedMinutes(active.startedAt, now)
  if (minutes < 1) {
    throw new TimeEntryDurationTooShortError(memberId, 'job')
  }
  return repo.update(active.entryId, {
    status: 'closed',
    endedAt: now.toISOString(),
    durationMinutes: minutes,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner-only: reject a closed entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner reviews a closed entry and rejects it with a free-text reason.
 *
 * Active entries cannot be rejected — the worker must stop the timer first
 * (DB CHECK constraint `closed_has_end` would also block it). Owner can
 * re-confirm a previously rejected entry via the same workflow with a
 * different status path; that is out of scope for Block 2.
 */
export async function rejectTimeEntryWorkflow(
  entryId: string,
  reason: string,
  options: StopOptions = {},
): Promise<TimeEntry> {
  assertOwnerRole(options.session)
  const trimmed = (reason ?? '').trim()
  if (!trimmed) {
    throw new Error('Reject reason is required')
  }
  const repo = getTimeEntryRepository()
  const entry = repo.getById(entryId)
  if (!entry) {
    throw new TimeEntryNotFoundError(entryId)
  }
  if (entry.status !== 'closed') {
    throw new Error(`Cannot reject entry in status '${entry.status}' — must be 'closed'`)
  }
  const session = resolveSession(options.session)
  return repo.update(entryId, {
    status: 'rejected',
    rejectedReason: trimmed,
    rejectedBy: session.user?.id ?? null,
  })
}
