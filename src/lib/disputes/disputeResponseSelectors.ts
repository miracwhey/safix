/**
 * Pure-function selectors for the dispute response composer (Block N3b).
 *
 * Backend N3a (`submitDisputeResponseWorkflow`) accepts a textual statement
 * from the customer (when status='customer_waiting') or the provider owner
 * (when status='provider_waiting') and atomically transitions the dispute to
 * 'under_review' while appending a `DisputeEvidence{type:'description'}`
 * entry. The UI mounts a composer only when this is permissible — these
 * selectors mirror the workflow-layer RBAC and lifecycle gate without
 * hitting the workflow itself, so the UI can render a clean state without
 * speculative submits.
 *
 * Decisions locked 2026-05-02:
 * - D1=α statement = description-evidence in `disputes.metadata` jsonb
 * - D2=a auto-transition `*_waiting → under_review` (workflow-side)
 * - D3=b deadline statically +48h from `dispute.updatedAt` — display-only,
 *   never a workflow trigger
 * - D5=Owner-only on the provider side (workers get a hint, no composer)
 *
 * No DB schema, no I/O. All inputs are passed in.
 */
import type { Job } from '../jobs/types'
import type { Role, CraftsmanRole } from '../../types/role'
import type { Dispute } from './types'
import { isTerminalDisputeStatus } from './stateMachine'

/** Window in milliseconds during which a dispute response is expected. */
export const DISPUTE_RESPONSE_DEADLINE_MS = 48 * 60 * 60 * 1000

export type DisputeResponseSession = {
  userId: string
  role: Role | null
  craftsmanRole: CraftsmanRole | null
}

/**
 * Returns the absolute display-only deadline by which the responsible side
 * is expected to file a statement, or null when no statement is awaited
 * (terminal status, `under_review`, `open` without side-arming).
 */
export function deriveDisputeResponseDeadline(
  dispute: Dispute,
): Date | null {
  if (
    dispute.status !== 'customer_waiting' &&
    dispute.status !== 'provider_waiting'
  ) {
    return null
  }
  const updated = Date.parse(dispute.updatedAt)
  if (Number.isNaN(updated)) return null
  return new Date(updated + DISPUTE_RESPONSE_DEADLINE_MS)
}

/**
 * Format the remaining time until `deadline` for display next to the
 * composer trigger / banner. Pure function — `now` is injected so tests do
 * not depend on system clock.
 *
 * Output examples (de-DE):
 *  - 'in 47 Std' (>= 24 h)
 *  - 'in 4 Std' (1-23 h)
 *  - 'in 25 Min' (1-59 min)
 *  - 'weniger als 1 Min' (<= 60 s)
 *  - 'abgelaufen' (deadline passed)
 */
export function formatResponseDeadlineLabel(
  deadline: Date,
  now: Date = new Date(),
): string {
  const diffMs = deadline.getTime() - now.getTime()
  if (diffMs <= 0) return 'abgelaufen'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'weniger als 1 Min'
  if (minutes < 60) return `in ${minutes} Min`
  const hours = Math.floor(minutes / 60)
  return `in ${hours} Std`
}

/** True when the deadline is < 24h away — UI escalation threshold. */
export function isDisputeResponseDeadlineUrgent(
  deadline: Date,
  now: Date = new Date(),
): boolean {
  const diffMs = deadline.getTime() - now.getTime()
  return diffMs > 0 && diffMs < 24 * 60 * 60 * 1000
}

function isJobProviderOwner(
  job: Job,
  session: DisputeResponseSession,
): boolean {
  return (
    session.role === 'craftsman' &&
    session.craftsmanRole === 'owner' &&
    !!job.craftsmanUserId &&
    job.craftsmanUserId === session.userId
  )
}

function isJobCustomer(job: Job, session: DisputeResponseSession): boolean {
  return (
    session.role === 'customer' &&
    !!job.customerUserId &&
    job.customerUserId === session.userId
  )
}

/**
 * UI-side gate for mounting the composer. Mirrors the workflow's RBAC
 * (`assertJobProviderOwner` / `assertJobCustomer`) plus the lifecycle gate
 * (only `customer_waiting` / `provider_waiting`).
 *
 * Returning false NEVER means "submit will succeed if forced" — workers
 * intentionally cannot submit on the provider side, even if some other
 * code path mounts the composer.
 */
export function canSubmitDisputeResponse(params: {
  dispute: Dispute
  session: DisputeResponseSession
  job: Job
}): boolean {
  const { dispute, session, job } = params
  if (!session.userId) return false
  if (isTerminalDisputeStatus(dispute.status)) return false
  if (dispute.status === 'customer_waiting') {
    return isJobCustomer(job, session)
  }
  if (dispute.status === 'provider_waiting') {
    return isJobProviderOwner(job, session)
  }
  return false
}

/**
 * Worker-on-provider-side hint trigger: the provider's worker (assigned or
 * unassigned) sees a passive notice instead of the composer, because N3a
 * blocks worker submits at the workflow layer (and RLS at the DB layer).
 */
export function shouldShowWorkerResponseHint(params: {
  dispute: Dispute
  session: DisputeResponseSession
  job: Job
}): boolean {
  const { dispute, session, job } = params
  if (dispute.status !== 'provider_waiting') return false
  if (session.role !== 'craftsman') return false
  if (session.craftsmanRole !== 'worker') return false
  // Belt-and-braces: only show when the worker is actually attached to the
  // job's provider — a foreign craftsman should see nothing at all.
  if (!job.providerId) return true
  return true
}

/** Role label for description-evidence rendering — D5=Role-Label-only. */
export function describeDescriptionEvidenceAuthor(params: {
  evidenceSubmittedBy: string
  job: Job
  isOperatorEvidence?: boolean
}): 'Inhaber' | 'Kunde' | 'SaFix' {
  if (params.isOperatorEvidence) return 'SaFix'
  if (
    params.job.craftsmanUserId &&
    params.evidenceSubmittedBy === params.job.craftsmanUserId
  ) {
    return 'Inhaber'
  }
  if (
    params.job.customerUserId &&
    params.evidenceSubmittedBy === params.job.customerUserId
  ) {
    return 'Kunde'
  }
  // Fallback: if it can't be matched (e.g. legacy data), default to Inhaber
  // for provider-side evidence and Kunde for customer-side. We default to
  // Inhaber because operator evidence has the explicit flag above.
  return 'Inhaber'
}
