/**
 * Absence workflows — Block 3.
 *
 * Three defense layers, mirroring the time-entry pattern (Block 2):
 *   1. UI gate: Worker only sees the "Krank melden" CTA on their own home;
 *      Owner only sees the "Krankschein anfordern" action in the team-hub.
 *   2. Workflow gate: `assertWorkerOrOwnerForMember` for member-scoped writes,
 *      `assertOwnerRole` for the owner-only sick-note-request flip.
 *   3. RLS / DB constraints: `absences_*` policies, the consistency CHECKs,
 *      and the worker-cancel WITH CHECK that pins status='cancelled'.
 *
 * Side-effect contract:
 *   - `reportAbsenceWorkflow` auto-stops an active day-timer (atomic) before
 *     inserting the absence row; this keeps weekly hours aggregates honest
 *     (a worker can't be both "on the clock" and "krankgemeldet" at the
 *     same instant).
 *   - After the absence row lands, the workflow fires the absence-notify
 *     server endpoint best-effort. Notification fan-out failure does NOT
 *     undo the absence — the absence is the source of truth, the
 *     notifications are derived signals.
 */

import type { SessionState } from '../session'
import { assertOwnerRole, assertWorkerOrOwnerForMember, resolveSession } from '../auth/rbacGuards'
import { logError } from '../observability'
import { supabase } from '../supabase'
import { stripImageExifIfPossible } from '../media/preUploadPipeline'
import {
  AbsenceNotFoundError,
  getAbsenceRepository,
  getTimeEntryRepository,
} from '../team/repository'
import { deriveActiveDayState, deriveActiveJobState } from '../team/timeEntrySelectors'
import type { Absence, AbsenceType } from '../team/absenceTypes'

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class AbsenceDateRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbsenceDateRangeError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Common workflow options
// ─────────────────────────────────────────────────────────────────────────────

export type ReportAbsenceOptions = {
  type: AbsenceType
  startDate: string
  endDate: string
  reasonNote?: string | null
  session?: SessionState
  now?: Date
  /** Skip the absence-notify side-effect (used by tests). */
  skipNotify?: boolean
}

export type AbsenceWorkflowResult = {
  absence: Absence
  /** Set when the report auto-stopped an active day or job timer. */
  autoStoppedDayEntryId?: string
  autoStoppedJobEntryId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Report absence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worker (or Owner-on-behalf) reports an absence for the given member.
 *
 * Auto-stops any active day-timer + job-timer first (atomic policy). This is
 * intentionally tolerant: if the timer-stop fails, we still try the absence
 * INSERT — the worker is reporting sick *now*, and a stale active timer will
 * be reconciled later by the owner-reject path.
 */
export async function reportAbsenceWorkflow(
  memberId: string,
  providerId: string,
  options: ReportAbsenceOptions,
): Promise<AbsenceWorkflowResult> {
  assertWorkerOrOwnerForMember(memberId, options.session, providerId)

  if (options.endDate < options.startDate) {
    throw new AbsenceDateRangeError('endDate must be ≥ startDate')
  }

  const result: AbsenceWorkflowResult = { absence: undefined as unknown as Absence }

  // ─── Step 1: atomic auto-stop active timers ─────────────────────────────
  const teRepo = getTimeEntryRepository()
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const entries = teRepo.getAll()

  const activeJob = deriveActiveJobState(entries, memberId)
  if (activeJob.state === 'active') {
    try {
      const minutes = Math.max(1, Math.floor((now.getTime() - new Date(activeJob.startedAt).getTime()) / 60_000))
      await teRepo.update(activeJob.entryId, {
        status: 'closed',
        endedAt: nowIso,
        durationMinutes: minutes,
      })
      result.autoStoppedJobEntryId = activeJob.entryId
    } catch (err) {
      logError('absenceWorkflow.auto_stop_job_failed', err as Error, { memberId, providerId })
    }
  }

  const activeDay = deriveActiveDayState(entries, memberId)
  if (activeDay.state === 'active') {
    try {
      const minutes = Math.max(1, Math.floor((now.getTime() - new Date(activeDay.startedAt).getTime()) / 60_000))
      await teRepo.update(activeDay.entryId, {
        status: 'closed',
        endedAt: nowIso,
        durationMinutes: minutes,
      })
      result.autoStoppedDayEntryId = activeDay.entryId
    } catch (err) {
      logError('absenceWorkflow.auto_stop_day_failed', err as Error, { memberId, providerId })
    }
  }

  // ─── Step 2: INSERT absence row ─────────────────────────────────────────
  const absence = await getAbsenceRepository().create({
    providerId,
    memberId,
    type: options.type,
    startDate: options.startDate,
    endDate: options.endDate,
    reasonNote: options.reasonNote ?? null,
  })
  result.absence = absence

  // ─── Step 3: trigger notification fan-out (fire-and-forget, fail-soft) ──
  if (!options.skipNotify) {
    void triggerAbsenceNotify(absence.id, 'reported').catch((err) => {
      logError('absenceWorkflow.notify_failed', err as Error, { absenceId: absence.id })
    })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel absence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worker withdraws their own absence (status='active' → 'cancelled').
 *
 * MVP scope: Owner cannot cancel another member's absence. Owner-driven
 * cancellation is V2.
 */
export async function cancelAbsenceWorkflow(
  absenceId: string,
  options: { session?: SessionState; now?: Date; skipNotify?: boolean } = {},
): Promise<Absence> {
  const repo = getAbsenceRepository()
  const existing = repo.getById(absenceId)
  if (!existing) throw new AbsenceNotFoundError(absenceId)

  assertWorkerOrOwnerForMember(existing.memberId, options.session, existing.providerId)

  const cancelledAt = (options.now ?? new Date()).toISOString()
  const updated = await repo.update(absenceId, {
    status: 'cancelled',
    cancelledAt,
  })

  if (!options.skipNotify) {
    void triggerAbsenceNotify(absenceId, 'cancelled').catch((err) => {
      logError('absenceWorkflow.notify_cancel_failed', err as Error, { absenceId })
    })
  }

  return updated
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner: request sick note
// ─────────────────────────────────────────────────────────────────────────────

export async function requestSickNoteWorkflow(
  absenceId: string,
  options: { session?: SessionState; now?: Date } = {},
): Promise<Absence> {
  assertOwnerRole(options.session)
  const repo = getAbsenceRepository()
  const existing = repo.getById(absenceId)
  if (!existing) throw new AbsenceNotFoundError(absenceId)

  const requestedAt = (options.now ?? new Date()).toISOString()
  return repo.update(absenceId, {
    sickNoteRequested: true,
    sickNoteRequestedAt: requestedAt,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: notification trigger
// ─────────────────────────────────────────────────────────────────────────────

async function triggerAbsenceNotify(
  absenceId: string,
  kind: 'reported' | 'cancelled',
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) {
    // No session = worker isn't authenticated. The INSERT can't have
    // succeeded either, so we should never reach here in practice.
    // Defensive log + return — do not throw, fan-out is best-effort.
    logError('absenceWorkflow.notify_no_session', new Error('no auth session'), { absenceId })
    return
  }
  const url = '/api/team/absence-notify'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ absenceId, kind }),
  })
  if (!response.ok) {
    throw new Error(`absence-notify ${response.status}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker: submit sick note document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads an AU-Bescheinigung (photo or PDF) to Supabase Storage and links
 * the storage path to the absence row.
 *
 * Storage path: {providerId}/{memberId}/{absenceId}.{ext}
 * Bucket: sick-notes (private, RLS-guarded by team_member scope)
 *
 * Upsert semantics: re-uploading replaces the previous file so the worker can
 * correct a bad scan without creating orphaned objects.
 */
export async function submitSickNoteWorkflow(
  absenceId: string,
  file: File,
  options: { session?: SessionState } = {},
): Promise<Absence> {
  const repo = getAbsenceRepository()
  const existing = repo.getById(absenceId)
  if (!existing) throw new AbsenceNotFoundError(absenceId)

  assertWorkerOrOwnerForMember(existing.memberId, options.session, existing.providerId)

  // Derive extension from MIME type first, fall back to original filename.
  const mimeExt: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  // Strip EXIF/GPS from image sick notes before upload (PDFs pass through
  // unchanged) — a photographed AU-Bescheinigung carries the employee's home
  // GPS in the camera roll; this is Art.-9 health data and must not leak it.
  const safeFile = await stripImageExifIfPossible(file)
  const ext = mimeExt[safeFile.type] ?? safeFile.name.split('.').pop() ?? 'jpg'
  const path = `${existing.providerId}/${existing.memberId}/${absenceId}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('sick-notes')
    .upload(path, safeFile, { upsert: true, contentType: safeFile.type })

  if (uploadError) {
    logError('absenceWorkflow.sick_note_upload_failed', uploadError as Error, { absenceId })
    throw uploadError
  }

  const submittedAt = new Date().toISOString()
  return repo.update(absenceId, {
    sickNoteUrl: path,
    sickNoteSubmittedAt: submittedAt,
  })
}

// Re-export resolveSession alias for tests that need to construct a session.
export { resolveSession }
