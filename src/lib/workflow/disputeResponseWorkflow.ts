/**
 * Dispute Response Workflow — N3a (Block: textbasierte Stellungnahme an SaFix/Operator).
 *
 * Scope (per N3a decision):
 * - Owner-only on the provider side (`assertJobProviderOwner`). Assigned workers
 *   must NOT submit official dispute responses for now; worker-input + admin-gate
 *   is a deferred follow-up block (`~/.claude/plans/n3-worker-dispute-input-admin-gate.md`).
 * - Customer side: `assertJobCustomer` (existing pattern).
 * - Stores the statement as `DisputeEvidence{type:'description'}` inside
 *   `disputes.metadata` (the existing evidence storage path; no new tables).
 * - On valid submit: dispute transitions `customer_waiting`/`provider_waiting` →
 *   `under_review` atomically via the SECURITY DEFINER RPC
 *   `party_submit_dispute_statement` (H24). RLS on `disputes` allows the
 *   UPDATE, but the `disputes_status_change_guard` trigger rejects any
 *   non-operator status change with 42501 — the RPC arms a transaction-local
 *   sentinel the trigger honours for exactly this transition, re-verifies
 *   party ownership server-side, and writes the history row (source='client').
 *
 * Out of scope (intentionally NOT here):
 * - File / photo upload, Storage, dispute_evidence-table writes
 * - New `dispute_responses` table or schema migration
 * - `response_deadline_at` / Frist-Logik
 * - Sub-state markers `awaiting_response` vs `evidence_needed`
 * - Edit-after-submit. Once the status moves to `under_review`, subsequent
 *   calls to this workflow are rejected with `dispute_not_awaiting_response`.
 *   Sent responses remain immutable for audit. A new statement requires the
 *   operator to re-arm the side via `requestCustomerEvidenceWorkflow` /
 *   `requestProviderEvidenceWorkflow` first.
 * - Payment-resolution side effects.
 *
 * Wording contract: error messages and operator-language must say
 * "SaFix / Operator" — never "Stripe". Stripe is the payment rail, not the
 * adjudicator.
 */

import { createEvidence } from '../disputes/disputeEvidence'
import {
  emitDisputeEvidenceAttachedEvent,
  emitDisputeUnderReviewEvent,
} from '../disputes/disputeTimeline'
import { getDisputeRepository } from '../disputes/repository'
import { canTransitionDispute } from '../disputes/stateMachine'
import type { Dispute } from '../disputes/types'
import {
  RbacError,
  assertJobCustomer,
  assertJobProviderOwner,
  resolveSession,
} from '../auth/rbacGuards'
import type { SessionState } from '../session'
import { getJobById, updateJobDisputeStatus } from '../jobs'
import { logError } from '../observability'

export type DisputeResponseErrorCode =
  | 'dispute_not_found'
  | 'dispute_terminal'
  | 'dispute_not_awaiting_response'
  | 'dispute_response_empty'
  | 'job_not_found'

export class DisputeResponseError extends Error {
  readonly code: DisputeResponseErrorCode
  constructor(code: DisputeResponseErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'DisputeResponseError'
    this.code = code
  }
}

function assertDisputeRepoHydrated(jobId: string): void {
  if (!getDisputeRepository().isHydrated()) {
    const err = new Error(
      `Cannot submit dispute response: dispute repository is not hydrated yet (jobId=${jobId}).`,
    )
    logError('workflow.dispute_response.unhydrated_guard', err, { jobId })
    throw err
  }
}

export async function submitDisputeResponseWorkflow(params: {
  jobId: string
  statement: string
  session?: SessionState
}): Promise<Dispute> {
  const { jobId } = params
  assertDisputeRepoHydrated(jobId)

  const trimmed = params.statement.trim()
  if (trimmed.length === 0) {
    throw new DisputeResponseError(
      'dispute_response_empty',
      'Stellungnahme darf nicht leer sein.',
    )
  }

  const dispute = getDisputeRepository().getByJobId(jobId)
  if (!dispute) {
    throw new DisputeResponseError(
      'dispute_not_found',
      `Kein Streitfall für Job ${jobId} vorhanden.`,
    )
  }

  if (
    dispute.status === 'resolved' ||
    dispute.status === 'closed' ||
    dispute.status === 'cancelled'
  ) {
    throw new DisputeResponseError(
      'dispute_terminal',
      `Streitfall ${dispute.id} ist abgeschlossen (${dispute.status}); keine weitere Stellungnahme möglich.`,
    )
  }

  if (
    dispute.status !== 'customer_waiting' &&
    dispute.status !== 'provider_waiting'
  ) {
    throw new DisputeResponseError(
      'dispute_not_awaiting_response',
      `Streitfall ${dispute.id} steht aktuell auf '${dispute.status}' — eine Stellungnahme ist nur bei 'customer_waiting' oder 'provider_waiting' erlaubt. Falls weitere Angaben nötig sind, fordert SaFix diese erneut an.`,
    )
  }

  const job = getJobById(jobId)
  if (!job) {
    throw new DisputeResponseError(
      'job_not_found',
      `Job ${jobId} nicht gefunden — Stellungnahme abgebrochen.`,
    )
  }

  const session = resolveSession(params.session)
  if (!session.user) {
    throw new RbacError('rbac_role', 'Caller has no validated user')
  }

  if (dispute.status === 'customer_waiting') {
    assertJobCustomer(job, params.session)
  } else {
    // provider_waiting — owner-only by N3a decision. Assigned workers are
    // blocked here on purpose; that block is enforced even when teamMembers
    // hydrated correctly. See plan: n3-worker-dispute-input-admin-gate.
    assertJobProviderOwner(job, params.session)
  }

  if (!canTransitionDispute(dispute.status, 'under_review')) {
    // Defensive: state-machine should already permit *_waiting → under_review.
    throw new DisputeResponseError(
      'dispute_not_awaiting_response',
      `Statusübergang von '${dispute.status}' nach 'under_review' ist nicht erlaubt.`,
    )
  }

  const evidence = createEvidence({
    disputeId: dispute.id,
    jobId: dispute.jobId,
    type: 'description',
    description: trimmed,
    submittedBy: session.user.id,
  })

  // Single atomic write via SECURITY DEFINER RPC (H24): the RPC appends the
  // description-evidence into disputes.metadata AND transitions
  // *_waiting → under_review in one transaction, gated by a transaction-local
  // sentinel that the BEFORE-UPDATE trigger guard honours for exactly this
  // transition. A direct UPDATE would be rejected with 42501. The RPC also
  // re-verifies party ownership server-side and writes the
  // dispute_status_history row (source='client').
  await getDisputeRepository().partySubmitStatement(dispute.id, evidence)

  await updateJobDisputeStatus(jobId, 'under_review')

  emitDisputeEvidenceAttachedEvent(jobId)
  emitDisputeUnderReviewEvent(jobId)

  const updated = getDisputeRepository().getByJobId(jobId)
  if (!updated) {
    throw new DisputeResponseError(
      'dispute_not_found',
      `Streitfall nach Stellungnahme nicht mehr lesbar (jobId=${jobId}).`,
    )
  }
  return updated
}
