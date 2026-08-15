import { generateUUID } from '../shared/generateUUID'
import { canTransitionDispute, isTerminalDisputeStatus } from './stateMachine'
import type {
  Dispute,
  DisputeContextSnapshot,
  DisputeReason,
  DisputeStatus,
} from './types'

/**
 * Constructs a new domain `Dispute`.
 *
 * Block 5.5c contract:
 * - `id` is a UUID v4 string (matches `disputes.id uuid` in production).
 * - All timestamps are ISO 8601 timestamptz strings, NOT epoch-ms numbers.
 * - `settlementStatus` is intentionally left undefined — `'pending'` is set
 *   only when the dispute reaches a terminal state via `updateDisputeStatus`.
 */
export function createDispute(params: {
  jobId: string
  reason: DisputeReason
  title: string
  description: string
  raisedBy?: string
  paymentId?: string
  contextSnapshot?: DisputeContextSnapshot | null
}): Dispute {
  const nowIso = new Date().toISOString()

  return {
    id: generateUUID(),
    jobId: params.jobId,
    status: 'open',
    reason: params.reason,
    title: params.title,
    description: params.description,
    createdAt: nowIso,
    updatedAt: nowIso,
    evidence: [],
    ...(params.raisedBy != null && { raisedBy: params.raisedBy }),
    ...(params.paymentId != null && { paymentId: params.paymentId }),
    ...(params.contextSnapshot != null && { contextSnapshot: params.contextSnapshot }),
  }
}

export function updateDisputeStatus(
  dispute: Dispute,
  nextStatus: DisputeStatus
): Dispute {
  if (!canTransitionDispute(dispute.status, nextStatus)) {
    return dispute
  }

  const nowIso = new Date().toISOString()
  const becomesTerminal =
    !isTerminalDisputeStatus(dispute.status) && isTerminalDisputeStatus(nextStatus)

  return {
    ...dispute,
    status: nextStatus,
    updatedAt: nowIso,
    ...(becomesTerminal ? { resolvedAt: nowIso, settlementStatus: 'pending' as const } : {}),
  }
}
