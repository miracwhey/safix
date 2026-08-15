import { createDispute, updateDisputeStatus } from './disputeEngine'
import { createEvidence } from './disputeEvidence'
import { getDisputeRepository } from './repository'
import {
  getDisputeById,
  getDisputeByJobId,
  getDisputesByJobId,
  getDisputes,
  subscribeDisputes,
  isDisputeRepositoryHydrated,
} from './disputeStore'
import { canTransitionDispute, isTerminalDisputeStatus } from './stateMachine'
import type {
  Dispute,
  DisputeContextSnapshot,
  DisputeDecision,
  DisputeEvidence,
  DisputeReason,
  DisputeStatus,
  EvidenceType,
  ResolutionType,
} from './types'

export { subscribeDisputes, getDisputes, getDisputeById, getDisputeByJobId, getDisputesByJobId, isDisputeRepositoryHydrated }

export async function openDispute(params: {
  jobId: string
  reason: DisputeReason
  title: string
  description: string
  raisedBy?: string
  paymentId?: string
  contextSnapshot?: DisputeContextSnapshot | null
}): Promise<Dispute> {
  const existing = getDisputeRepository().getByJobId(params.jobId)
  if (existing) return existing

  const created = createDispute(params)
  await getDisputeRepository().add(created)

  return created
}

/**
 * Atomically opens a dispute, delegating to the active repository.
 *
 * For SupabaseDisputeRepository: calls the `open_dispute_atomic` RPC which
 * locks the payment row, validates state, and inserts dispute + updates payment
 * + job in one transaction. Handles concurrent duplicates (23505) by returning
 * the winning dispute from cache or DB — never a phantom object.
 *
 * For InMemoryDisputeRepository (in-memory mode / unit tests): inserts locally.
 *
 * Idempotent: returns immediately if the job already has a cached dispute.
 */
export async function openDisputeAtomic(params: {
  jobId: string
  reason: DisputeReason
  title: string
  description: string
  raisedBy?: string
  paymentId?: string
  contextSnapshot?: DisputeContextSnapshot | null
}): Promise<Dispute> {
  const cached = getDisputeRepository().getByJobId(params.jobId)
  if (cached) return cached

  const dispute = createDispute(params)
  return getDisputeRepository().openDisputeAtomic(dispute)
}

type ResolveExtras = {
  decision?: DisputeDecision
  splitRatio?: number
  resolutionType?: ResolutionType
}

export async function transitionDisputeStatus(
  jobId: string,
  nextStatus: DisputeStatus,
  extra?: ResolveExtras
): Promise<Dispute | undefined> {
  const dispute = getDisputeRepository().getByJobId(jobId)
  if (!dispute) return undefined

  if (!canTransitionDispute(dispute.status, nextStatus)) {
    throw new Error(
      `Illegal dispute transition: ${dispute.status} → ${nextStatus}`
    )
  }

  const updated = updateDisputeStatus(dispute, nextStatus)
  const withExtra: Dispute = {
    ...updated,
    ...(extra?.decision != null && { decision: extra.decision }),
    ...(extra?.resolutionType != null && { resolutionType: extra.resolutionType }),
    ...(extra?.splitRatio != null && { splitRatio: extra.splitRatio }),
  }
  await getDisputeRepository().update(updated.id, () => withExtra)

  return withExtra
}

export async function transitionDisputeStatusById(
  disputeId: string,
  nextStatus: DisputeStatus,
  extra?: ResolveExtras
): Promise<Dispute | undefined> {
  const dispute = getDisputeRepository().getById(disputeId)
  if (!dispute) return undefined

  if (!canTransitionDispute(dispute.status, nextStatus)) {
    throw new Error(
      `Illegal dispute transition: ${dispute.status} → ${nextStatus}`
    )
  }

  const updated = updateDisputeStatus(dispute, nextStatus)
  const withDecision: Dispute = {
    ...updated,
    ...(extra?.decision != null && { decision: extra.decision }),
    ...(extra?.resolutionType != null && { resolutionType: extra.resolutionType }),
    ...(extra?.splitRatio != null && { splitRatio: extra.splitRatio }),
  }
  await getDisputeRepository().update(updated.id, () => withDecision)

  return withDecision
}

export async function resolveDisputeWithRelease(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'resolved', {
    decision: 'release',
    resolutionType: 'release_full',
  })
}

export async function resolveDisputeWithRefund(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'resolved', {
    decision: 'refund',
    resolutionType: 'refund_full',
  })
}

export async function resolveDisputeWithSplit(
  jobId: string,
  splitRatio: number
): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'resolved', {
    decision: 'split',
    resolutionType: 'split',
    splitRatio,
  })
}

export async function markDisputeUnderReview(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'under_review')
}

export async function requestCustomerEvidence(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'customer_waiting')
}

export async function requestProviderEvidence(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'provider_waiting')
}

export async function rejectDispute(jobId: string): Promise<Dispute | undefined> {
  return transitionDisputeStatus(jobId, 'resolved', {
    decision: 'reject',
    resolutionType: 'rejected',
  })
}

/**
 * Marks a terminal dispute as financially settled — the payment/provider action
 * required by the decision has completed successfully.
 *
 * Must only be called AFTER the irreversible money action succeeds.
 * This transitions `settlementStatus` from `'pending'` → `'settled'`.
 */
export async function settleDispute(jobId: string): Promise<Dispute | undefined> {
  const dispute = getDisputeRepository().getByJobId(jobId)
  if (!dispute) return undefined
  if (dispute.settlementStatus === 'settled') return dispute

  const settled: Dispute = {
    ...dispute,
    settlementStatus: 'settled',
    updatedAt: new Date().toISOString(),
  }
  await getDisputeRepository().update(dispute.id, () => settled)
  return settled
}

/**
 * Returns `true` only when the dispute has reached a terminal lifecycle state
 * AND the required financial action has completed (`settlementStatus === 'settled'`).
 */
export function isDisputeFullySettled(dispute: Dispute | undefined): boolean {
  if (!dispute) return false
  if (!isTerminalDisputeStatus(dispute.status)) return false
  return dispute.settlementStatus === 'settled'
}

export async function addDisputeEvidence(
  jobId: string,
  params: {
    type: EvidenceType
    description: string
    submittedBy: string
    url?: string
  }
): Promise<DisputeEvidence | undefined> {
  const dispute = getDisputeRepository().getByJobId(jobId)
  if (!dispute) return undefined

  const evidence = createEvidence({
    disputeId: dispute.id,
    jobId: dispute.jobId,
    ...params,
  })

  await getDisputeRepository().update(dispute.id, (d) => ({
    ...d,
    evidence: [...(d.evidence ?? []), evidence],
    updatedAt: new Date().toISOString(),
  }))

  return evidence
}
