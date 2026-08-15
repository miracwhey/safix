import { mockDisputes } from '../mockData'
import { canTransitionDispute, isTerminalDisputeStatus } from '../stateMachine'
import { generateUUID } from '../../shared/generateUUID'
import type {
  Dispute,
  DisputeDecision,
  DisputeEvidence,
  DisputeStatus,
  ResolutionType,
  SplitProposal,
} from '../types'
import type { DisputeRepository } from './DisputeRepository'

// In-memory mode is caller-agnostic — auth.uid() is only enforced server-side
// by the SECURITY DEFINER RPCs. Proposal authorship is stamped with a stable
// placeholder so the shape matches the production row.
const IN_MEMORY_ACTOR = 'in-memory-actor'

type Listener = () => void

type OperatorTransitionExtras = {
  decision?: DisputeDecision
  resolutionType?: ResolutionType
  splitRatio?: number
}

export class InMemoryDisputeRepository implements DisputeRepository {
  private disputes: Dispute[]
  private splitProposals: SplitProposal[] = []
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Dispute[] = [...mockDisputes]) {
    this.disputes = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Dispute[] {
    return [...this.disputes]
  }

  getById(disputeId: string): Dispute | undefined {
    return this.disputes.find((dispute) => dispute.id === disputeId)
  }

  getByJobId(jobId: string): Dispute | undefined {
    return this.disputes.find((dispute) => dispute.jobId === jobId)
  }

  getDisputesByJob(jobId: string): Dispute[] {
    return this.disputes.filter((dispute) => dispute.jobId === jobId)
  }

  async add(dispute: Dispute): Promise<void> {
    this.disputes = [dispute, ...this.disputes]
    this.notify()
  }

  async update(disputeId: string, updater: (dispute: Dispute) => Dispute): Promise<void> {
    this.disputes = this.disputes.map((dispute) =>
      dispute.id === disputeId ? updater(dispute) : dispute
    )
    this.notify()
  }

  applyFromRpc(dispute: Dispute): void {
    const exists = this.disputes.some((d) => d.id === dispute.id)
    if (exists) {
      this.disputes = this.disputes.map((d) => (d.id === dispute.id ? dispute : d))
    } else {
      this.disputes = [dispute, ...this.disputes]
    }
    this.notify()
  }

  async openDisputeAtomic(dispute: Dispute): Promise<Dispute> {
    const existing = this.getByJobId(dispute.jobId)
    if (existing) return existing
    await this.add(dispute)
    return dispute
  }

  async partySubmitStatement(disputeId: string, evidence: DisputeEvidence): Promise<Dispute> {
    const dispute = this.getById(disputeId)
    if (!dispute) {
      throw new Error(`dispute_not_found: ${disputeId}`)
    }
    if (dispute.status !== 'customer_waiting' && dispute.status !== 'provider_waiting') {
      throw new Error(`dispute_not_awaiting_response: status=${dispute.status}`)
    }
    const updated: Dispute = {
      ...dispute,
      evidence: [...(dispute.evidence ?? []), evidence],
      status: 'under_review',
      updatedAt: new Date().toISOString(),
    }
    this.disputes = this.disputes.map((d) => (d.id === disputeId ? updated : d))
    this.notify()
    return updated
  }

  // ── Operator transitions (in-memory mirror of the Supabase RPCs) ──────────
  // The Supabase implementation re-verifies profiles.is_operator on every
  // call; in-memory mode trusts the caller (tests). Both modes share the same
  // state-machine validation and idempotent return semantics.

  private async applyOperatorTransition(
    jobId: string,
    nextStatus: DisputeStatus,
    extras: OperatorTransitionExtras = {}
  ): Promise<Dispute> {
    const dispute = this.getByJobId(jobId)
    if (!dispute) {
      throw new Error(`dispute_not_found: no dispute for job ${jobId}`)
    }
    // C5 Decision-Immutability (parity with the operator_* RPCs): a resolved
    // dispute can never be re-resolved with a DIFFERENT decision, and a fully
    // settled dispute is immutable (idempotent return, never settled→pending).
    if (extras.decision != null && isTerminalDisputeStatus(dispute.status)) {
      if (dispute.decision != null && dispute.decision !== extras.decision) {
        throw new Error(
          `decision_immutable: dispute ${dispute.id} already resolved with decision ${dispute.decision}, cannot re-resolve as ${extras.decision}`,
        )
      }
      if (dispute.settlementStatus === 'settled') {
        return dispute
      }
    }
    if (dispute.status === nextStatus && extras.decision == null) {
      return dispute
    }
    if (dispute.status !== nextStatus && !canTransitionDispute(dispute.status, nextStatus)) {
      throw new Error(
        `invalid_transition: ${dispute.status} → ${nextStatus} not allowed`
      )
    }
    const nowIso = new Date().toISOString()
    const becomesTerminal =
      !isTerminalDisputeStatus(dispute.status) && isTerminalDisputeStatus(nextStatus)
    const updated: Dispute = {
      ...dispute,
      status: nextStatus,
      updatedAt: nowIso,
      ...(becomesTerminal ? { resolvedAt: nowIso, settlementStatus: 'pending' as const } : {}),
      ...(extras.decision != null && { decision: extras.decision }),
      ...(extras.resolutionType != null && { resolutionType: extras.resolutionType }),
      ...(extras.splitRatio != null && { splitRatio: extras.splitRatio }),
    }
    this.disputes = this.disputes.map((d) => (d.id === dispute.id ? updated : d))
    this.notify()
    return updated
  }

  async operatorRequestCustomerEvidence(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'customer_waiting')
  }

  async operatorRequestProviderEvidence(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'provider_waiting')
  }

  async operatorMarkUnderReview(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'under_review')
  }

  async operatorResolveRelease(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'resolved', {
      decision: 'release',
      resolutionType: 'release_full',
    })
  }

  async operatorResolveRefund(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'resolved', {
      decision: 'refund',
      resolutionType: 'refund_full',
    })
  }

  async operatorResolveSplit(jobId: string, splitRatio: number): Promise<Dispute> {
    // Parity with operator_resolve_dispute_split: (0,1) EXCLUSIVE. 0 % = refund,
    // 100 % = release — neither is a split (inclusive bounds double-paid at 0).
    if (!Number.isFinite(splitRatio) || splitRatio <= 0 || splitRatio >= 1) {
      throw new Error(`invalid_split_ratio: ${splitRatio} not in (0,1)`)
    }
    return this.applyOperatorTransition(jobId, 'resolved', {
      decision: 'split',
      resolutionType: 'split',
      splitRatio,
    })
  }

  async operatorReject(jobId: string): Promise<Dispute> {
    return this.applyOperatorTransition(jobId, 'resolved', {
      decision: 'reject',
      resolutionType: 'rejected',
    })
  }

  // ── Consensus-split proposal flow (P4 Teil B) ─────────────────────────────
  // In-memory mirror of the SECURITY DEFINER RPCs. Authorization (party-of-
  // dispute, proposer-cannot-confirm) is enforced server-side only; this layer
  // is caller-agnostic and reproduces just the state transitions so unit tests
  // can exercise the propose → confirm / reject lifecycle without Supabase.

  async proposeSplit(disputeId: string, ratio: number): Promise<SplitProposal> {
    const dispute = this.getById(disputeId)
    if (!dispute) {
      throw new Error(`dispute_not_found: ${disputeId}`)
    }
    // Parity with the DB ratio-bounds guard (proposed_ratio must be in (0,1)).
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      throw new Error(`invalid_split_ratio: ${ratio} not in (0,1)`)
    }
    if (isTerminalDisputeStatus(dispute.status)) {
      throw new Error(`dispute_not_open: cannot propose split on a ${dispute.status} dispute`)
    }

    const nowIso = new Date().toISOString()

    // Supersede any prior pending proposal for this dispute (single-pending
    // invariant), and compute the next round from ALL prior proposals.
    let maxRound = 0
    this.splitProposals = this.splitProposals.map((p) => {
      if (p.disputeId !== disputeId) return p
      if (p.proposalRound > maxRound) maxRound = p.proposalRound
      if (p.status === 'pending') {
        return { ...p, status: 'superseded' as const, updatedAt: nowIso }
      }
      return p
    })

    const proposal: SplitProposal = {
      id: generateUUID(),
      disputeId,
      jobId: dispute.jobId,
      proposedBy: IN_MEMORY_ACTOR,
      proposedRatio: ratio,
      status: 'pending',
      proposalRound: maxRound + 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    this.splitProposals = [proposal, ...this.splitProposals]
    this.notify()
    return proposal
  }

  async confirmSplitProposal(proposalId: string): Promise<Dispute> {
    const proposal = this.splitProposals.find((p) => p.id === proposalId)
    if (!proposal) {
      throw new Error(`split_proposal_not_found: ${proposalId}`)
    }
    if (proposal.status !== 'pending') {
      throw new Error(`split_proposal_not_pending: status=${proposal.status}`)
    }
    const dispute = this.getById(proposal.disputeId)
    if (!dispute) {
      throw new Error(`dispute_not_found: ${proposal.disputeId}`)
    }
    if (
      dispute.status !== 'resolved' &&
      !canTransitionDispute(dispute.status, 'resolved')
    ) {
      throw new Error(`invalid_transition: ${dispute.status} → resolved not allowed`)
    }

    const nowIso = new Date().toISOString()

    this.splitProposals = this.splitProposals.map((p) =>
      p.id === proposalId
        ? { ...p, status: 'accepted' as const, confirmedBy: IN_MEMORY_ACTOR, updatedAt: nowIso }
        : p,
    )

    const updated: Dispute = {
      ...dispute,
      status: 'resolved',
      decision: 'split',
      resolutionType: 'split',
      splitRatio: proposal.proposedRatio,
      settlementStatus: 'pending',
      resolvedAt: dispute.resolvedAt ?? nowIso,
      updatedAt: nowIso,
    }
    this.disputes = this.disputes.map((d) => (d.id === dispute.id ? updated : d))
    this.notify()
    return updated
  }

  async settleSplitConsensus(disputeId: string): Promise<Dispute> {
    // In-memory mirror of the settle_consensus_split RPC: flip
    // settlementStatus pending→settled on the cached dispute. Authorization
    // (party membership) is enforced server-side only; this layer is
    // caller-agnostic. Idempotent — an already-settled dispute is returned
    // unchanged (never settled→pending).
    const dispute = this.getById(disputeId)
    if (!dispute) {
      throw new Error(`dispute_not_found: ${disputeId}`)
    }
    if (dispute.settlementStatus === 'settled') {
      return dispute
    }
    const settled: Dispute = {
      ...dispute,
      settlementStatus: 'settled',
      updatedAt: new Date().toISOString(),
    }
    this.disputes = this.disputes.map((d) => (d.id === disputeId ? settled : d))
    this.notify()
    return settled
  }

  async rejectSplitProposal(proposalId: string): Promise<SplitProposal> {
    const proposal = this.splitProposals.find((p) => p.id === proposalId)
    if (!proposal) {
      throw new Error(`split_proposal_not_found: ${proposalId}`)
    }
    if (proposal.status !== 'pending') {
      throw new Error(`split_proposal_not_pending: status=${proposal.status}`)
    }
    const rejected: SplitProposal = {
      ...proposal,
      status: 'rejected',
      updatedAt: new Date().toISOString(),
    }
    this.splitProposals = this.splitProposals.map((p) => (p.id === proposalId ? rejected : p))
    this.notify()
    return rejected
  }

  async getActiveProposal(disputeId: string): Promise<SplitProposal | undefined> {
    return this.splitProposals.find(
      (p) => p.disputeId === disputeId && p.status === 'pending',
    )
  }

  async getDisputeForProposal(proposalId: string): Promise<Dispute | undefined> {
    // Read-only mirror of the Supabase mapping: proposal → dispute_id → dispute.
    // Returns the live in-memory dispute (carries settlementStatus updated by
    // settleDispute) so the confirmSplitWorkflow retry path can short-circuit an
    // already-settled dispute and re-drive the money leg otherwise.
    const proposal = this.splitProposals.find((p) => p.id === proposalId)
    if (!proposal) return undefined
    return this.getById(proposal.disputeId)
  }
}
