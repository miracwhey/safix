/**
 * Correction-request workflows.
 *
 * Adds the workflow-layer that previously was missing:
 *   - submitCorrectionWorkflow — Worker (or owner-as-worker) creates a request.
 *   - approveCorrectionWorkflow — Owner accepts; emits push to the worker.
 *   - rejectCorrectionWorkflow — Owner rejects with a mandatory note; emits push.
 *
 * Why a workflow layer?
 *   - UI used to call repo.add() directly, bypassing both RBAC and the
 *     notification fan-out. RLS protects the row but cannot trigger pushes.
 *   - Approve/reject are state-machine transitions plus a cross-domain push,
 *     which lives in the workflow layer per CLAUDE.md architecture rules.
 *
 * Push-emission constraint:
 *   notification_signals.job_id is NOT NULL. Corrections are team-scoped, not
 *   job-scoped — only those linked to a calendar_entry that itself carries a
 *   job_id can trigger a push. When the link is absent, the workflow logs a
 *   warning and skips the signal; the status update still succeeds.
 */

import { generateUUID } from '../shared/generateUUID'
import {
  RbacError,
  assertOwnerRole,
  resolveSession,
} from '../auth/rbacGuards'
import { getSession, type SessionState } from '../session'
import { getTeamMembers, isTeamMembersHydrated } from '../team'
import { getCalendarEntryById } from '../calendar/calendarStore'
import { addNotificationSignal } from '../notifications/notificationService'
import { getNotificationPriority } from '../notifications/notificationConfig'
import { logWarning } from '../observability'
import {
  getCorrectionRepository,
  type CorrectionKind,
  type CorrectionRequest,
  type CorrectionStatus,
} from '../corrections'
import { applyCorrectionToTarget } from './correctionApply'
import type { ProjectTimelineEventType } from '../timeline'

// ── Errors ───────────────────────────────────────────────────────────────────

export type CorrectionErrorCode =
  | 'correction_description_required'
  | 'correction_membership_unresolved'
  | 'correction_not_found'
  | 'correction_owner_note_required'
  | 'correction_state_terminal'

export class CorrectionWorkflowError extends Error {
  readonly code: CorrectionErrorCode
  constructor(code: CorrectionErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'CorrectionWorkflowError'
    this.code = code
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SubmitCorrectionInput = {
  kind: CorrectionKind
  description: string
  requestedDate?: string
  calendarEntryId?: string
  /** Block 7.2.4 — optional strukturierte Felder. Nicht-leer-getrimmte
   *  Werte werden in den Record übernommen; leere Strings werden ignoriert. */
  field?: string
  currentValue?: string
  proposedValue?: string
  reason?: string
}

// ── Internal helpers ─────────────────────────────────────────────────────────

type ResolvedMembership = {
  providerId: string
  teamMemberId: string
  workerProfileId: string
}

/**
 * Resolves the caller's team-membership for correction-request scoping.
 *
 * Returns the (provider_id, team_member_id, worker_profile_id) tuple. Falls
 * back to throwing CorrectionWorkflowError when the team store has not
 * hydrated or the caller has no membership row — never silently writes with
 * synthetic ids.
 */
function resolveCallerMembership(session: SessionState): ResolvedMembership {
  const userId = session.user?.id
  if (!userId) {
    throw new RbacError('rbac_role', 'Caller has no validated user')
  }
  if (!isTeamMembersHydrated()) {
    throw new CorrectionWorkflowError(
      'correction_membership_unresolved',
      'team store not hydrated; cannot resolve membership',
    )
  }
  const member = getTeamMembers().find((m) => m.userId === userId)
  if (!member || !member.providerId) {
    throw new CorrectionWorkflowError(
      'correction_membership_unresolved',
      'caller is not a team member of any provider',
    )
  }
  return {
    providerId: member.providerId,
    teamMemberId: member.id,
    workerProfileId: userId,
  }
}

/**
 * Verifies the owner's caller scope matches the correction's provider_id.
 * The session has already passed assertOwnerRole — here we additionally
 * confirm the owner administers the team that owns the correction.
 */
function assertCorrectionScopeOwner(
  correction: CorrectionRequest,
  session: SessionState,
): void {
  const userId = session.user?.id
  if (!userId) {
    throw new RbacError('rbac_owner', 'Caller has no validated user')
  }
  if (!isTeamMembersHydrated()) {
    throw new RbacError(
      'rbac_owner',
      'team store not hydrated; cannot confirm owner scope',
    )
  }
  const ownerMembership = getTeamMembers().find(
    (m) => m.userId === userId && m.providerId === correction.providerId,
  )
  if (!ownerMembership) {
    throw new RbacError(
      'rbac_owner',
      "Caller is not the owner of this correction's team",
    )
  }
}

/**
 * Emits a notification_signals row for the given correction lifecycle event.
 * Skips emission when the correction has no resolvable jobId — the row is
 * still functional, we just cannot fire a push (notification_signals.job_id
 * is NOT NULL).
 */
function emitCorrectionSignal(
  correction: CorrectionRequest,
  type: ProjectTimelineEventType,
): void {
  if (!correction.calendarEntryId) {
    logWarning('correction.push.skipped_no_calendar_entry', {
      correctionId: correction.id,
      type,
    })
    return
  }
  const entry = getCalendarEntryById(correction.calendarEntryId)
  if (!entry?.jobId) {
    logWarning('correction.push.skipped_no_job_link', {
      correctionId: correction.id,
      calendarEntryId: correction.calendarEntryId,
      type,
    })
    return
  }
  const priority = getNotificationPriority(type)
  if (!priority) {
    logWarning('correction.push.skipped_no_priority', {
      correctionId: correction.id,
      type,
    })
    return
  }
  addNotificationSignal({
    id: generateUUID(),
    jobId: entry.jobId,
    type,
    priority,
    read: false,
    occurredAt: Date.now(),
    recipientRole: 'craftsman',
    // A.2 — inline-action meta for correction_created only.
    // Populates the six fields the Edge-Fn gate (hasInlineActionPayloadFields)
    // requires to render aps.category=CORRECTION_DECISION Lockscreen buttons.
    // 24 h TTL: owner has one day to act from the Lockscreen; stale signals fall
    // back to the normal navigate-to-job-detail flow (dispatcher reason='expired').
    ...(type === 'correction_created' && {
      entityId: correction.id,
      entityType: 'correction',
      actionType: 'decision',
      roleTarget: 'craftsman',
      expectedStatus: 'open',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }),
  })
}

// ── Submit ───────────────────────────────────────────────────────────────────

export async function submitCorrectionWorkflow(
  input: SubmitCorrectionInput,
  session?: SessionState,
): Promise<CorrectionRequest> {
  const s = resolveSession(session ?? getSession())
  const description = input.description.trim()
  if (description.length === 0) {
    throw new CorrectionWorkflowError(
      'correction_description_required',
      'description must not be empty',
    )
  }
  const membership = resolveCallerMembership(s)

  const now = Date.now()
  const trimmedField = input.field?.trim()
  const trimmedCurrentValue = input.currentValue?.trim()
  const trimmedProposedValue = input.proposedValue?.trim()
  const trimmedReason = input.reason?.trim()

  const request: CorrectionRequest = {
    id: `cr-${now}-${Math.random().toString(36).slice(2, 7)}`,
    providerId: membership.providerId,
    workerTeamMemberId: membership.teamMemberId,
    workerProfileId: membership.workerProfileId,
    kind: input.kind,
    description,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...(input.requestedDate && input.requestedDate.trim()
      ? { requestedDate: input.requestedDate.trim() }
      : {}),
    ...(input.calendarEntryId ? { calendarEntryId: input.calendarEntryId } : {}),
    ...(trimmedField ? { field: trimmedField } : {}),
    ...(trimmedCurrentValue ? { currentValue: trimmedCurrentValue } : {}),
    ...(trimmedProposedValue ? { proposedValue: trimmedProposedValue } : {}),
    ...(trimmedReason ? { reason: trimmedReason } : {}),
  }

  await getCorrectionRepository().add(request)
  emitCorrectionSignal(request, 'correction_created')
  return request
}

// ── Approve / Reject helpers ─────────────────────────────────────────────────

const TRANSITIONABLE: ReadonlySet<CorrectionStatus> = new Set([
  'open',
  'in_review',
])

function loadCorrection(id: string): CorrectionRequest {
  const correction = getCorrectionRepository().getById(id)
  if (!correction) {
    throw new CorrectionWorkflowError(
      'correction_not_found',
      `correction ${id} not found`,
    )
  }
  return correction
}

// ── Approve ──────────────────────────────────────────────────────────────────

export async function approveCorrectionWorkflow(
  id: string,
  options?: { ownerNote?: string },
  session?: SessionState,
): Promise<CorrectionRequest> {
  const s = resolveSession(session ?? getSession())
  assertOwnerRole(s)

  const correction = loadCorrection(id)
  assertCorrectionScopeOwner(correction, s)

  // Idempotency: already-resolved → no-op.
  if (correction.status === 'resolved') {
    return correction
  }
  // Cannot transition from rejected → resolved. The owner must reject again
  // or the worker must resubmit.
  if (!TRANSITIONABLE.has(correction.status)) {
    throw new CorrectionWorkflowError(
      'correction_state_terminal',
      `correction ${id} is in terminal state ${correction.status}`,
    )
  }

  const now = Date.now()
  const trimmedNote =
    options?.ownerNote && options.ownerNote.trim().length > 0
      ? options.ownerNote.trim()
      : undefined

  await getCorrectionRepository().update(id, (r) => ({
    ...r,
    status: 'resolved',
    updatedAt: now,
    ...(trimmedNote ? { ownerNote: trimmedNote } : {}),
  }))

  // Block 7.2.7b — Auto-Apply: best-effort, Status-Update gewinnt immer.
  // applyCorrectionToTarget wirft NICHT (interner try/catch maps Repo-Errors
  // auf skipReason='repository_error'). Trace-Update ist der zweite Repo-Call,
  // damit applied_at den finalen Apply-Zeitpunkt reflektiert.
  const afterStatus = loadCorrection(id)
  const apply = await applyCorrectionToTarget(afterStatus)
  const traceTs = Date.now()
  await getCorrectionRepository().update(id, (r) => ({
    ...r,
    ...(apply.applied
      ? {
          appliedAt: traceTs,
          ...(apply.targetEntryId ? { appliedTargetEntryId: apply.targetEntryId } : {}),
        }
      : apply.skipReason
        ? { applySkipReason: apply.skipReason }
        : {}),
  }))

  const updated = loadCorrection(id)
  emitCorrectionSignal(updated, 'correction_resolved')
  return updated
}

// ── Reject ───────────────────────────────────────────────────────────────────

export async function rejectCorrectionWorkflow(
  id: string,
  ownerNote: string,
  session?: SessionState,
): Promise<CorrectionRequest> {
  const s = resolveSession(session ?? getSession())
  assertOwnerRole(s)

  const trimmedNote = ownerNote.trim()
  if (trimmedNote.length === 0) {
    throw new CorrectionWorkflowError(
      'correction_owner_note_required',
      'rejection requires a non-empty note',
    )
  }

  const correction = loadCorrection(id)
  assertCorrectionScopeOwner(correction, s)

  // Idempotency: already-rejected → no-op (note is preserved).
  if (correction.status === 'rejected') {
    return correction
  }
  if (!TRANSITIONABLE.has(correction.status)) {
    throw new CorrectionWorkflowError(
      'correction_state_terminal',
      `correction ${id} is in terminal state ${correction.status}`,
    )
  }

  const now = Date.now()
  await getCorrectionRepository().update(id, (r) => ({
    ...r,
    status: 'rejected',
    ownerNote: trimmedNote,
    updatedAt: now,
  }))

  const updated = loadCorrection(id)
  emitCorrectionSignal(updated, 'correction_rejected')
  return updated
}
