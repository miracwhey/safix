/**
 * P4 Teil A — confirmSplitWorkflow consensus settlement
 *
 * confirmSplitWorkflow is the client-side sibling of resolveDisputeWorkflow's
 * operator split branch: a two-party consensus confirm resolves the dispute via
 * confirm_split_proposal, then drives the money leg through
 * releaseEscrowWorkflow(..., 'consensus') with the SERVER-persisted split ratio,
 * and settles EXACTLY like the operator branch (only when release + bridge +
 * refund all succeed).
 *
 * This suite verifies, against the in-memory dispute repo (real propose/confirm
 * RPCs) with the money/settlement seam mocked (the disputeSettlementFailClosed
 * pattern):
 *
 *   - flag OFF                → early-throw, zero money movement (dormancy)
 *   - flag ON + happy path    → release(split, persisted ratio, actor 'consensus')
 *                               then settleDispute + updateJobDisputeStatus('resolved')
 *                               + both resolved events — only when all three legs succeed
 *   - gating                  → any of {payment, bridge, refund} false → stays pending + logError, NOT settled
 *   - retry (P0002-safe)      → resolved-but-pending re-entry does NOT crash on the consumed RPC,
 *                               re-drives the money leg with the persisted ratio, settles once
 *   - already-settled         → no-op (no money, no settle)
 *   - operator regression     → resolveDisputeWorkflow split still uses actor 'operator', flag-independent
 */

vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../src/lib/workflow/paymentWorkflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/workflow/paymentWorkflow')>()
  return {
    ...actual,
    releaseEscrowWorkflow: vi.fn(),
    getPaymentForJobWorkflow: vi.fn(),
  }
})

vi.mock('../../src/lib/disputes/disputesService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/disputes/disputesService')>()
  return {
    ...actual,
    settleDispute: vi.fn(),
  }
})

vi.mock('../../src/lib/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/jobs')>()
  return {
    ...actual,
    updateJobDisputeStatus: vi.fn(),
  }
})

vi.mock('../../src/lib/disputes/disputeTimeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/disputes/disputeTimeline')>()
  return {
    ...actual,
    emitDisputeResolvedEvent: vi.fn(),
    emitDisputeResolvedWithDecision: vi.fn(),
  }
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as observability from '../../src/lib/observability'
import * as paymentWorkflow from '../../src/lib/workflow/paymentWorkflow'
import * as disputesService from '../../src/lib/disputes/disputesService'
import * as jobs from '../../src/lib/jobs'
import * as disputeTimeline from '../../src/lib/disputes/disputeTimeline'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  confirmSplitWorkflow,
  resolveDisputeWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Dispute } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedDispute(jobId: string, status: Dispute['status'] = 'under_review'): Dispute {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  getDisputeRepository().add(dispute)
  return dispute
}

function mockPayment(jobId: string): Payment {
  return {
    id: `pay-${jobId}`,
    jobId,
    state: 'released',
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Resolves the dispute the way the first-pass confirm RPC would, and returns
 *  the proposal id. Used to set up the retry / already-settled re-entry tests. */
async function seedConfirmedSplit(jobId: string, ratio: number): Promise<string> {
  const dispute = seedDispute(jobId, 'under_review')
  const proposal = await getDisputeRepository().proposeSplit(dispute.id, ratio)
  await getDisputeRepository().confirmSplitProposal(proposal.id)
  return proposal.id
}

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
  // Defaults: payment present, full success. Individual tests override.
  vi.mocked(paymentWorkflow.getPaymentForJobWorkflow).mockReturnValue(mockPayment('default'))
  vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
    payment: mockPayment('default'),
    bridgeFullySucceeded: true,
    refundFullySucceeded: true,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── Dormancy: flag OFF ────────────────────────────────────────────────────────

describe('confirmSplitWorkflow — flag OFF (dormant)', () => {
  it('early-throws before any repository or money action — zero money movement', async () => {
    // No VITE_CONSENSUS_SPLIT_ENABLED stub → default undefined → disabled.
    const dispute = seedDispute('job-off-1', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)

    const confirmSpy = vi.spyOn(getDisputeRepository(), 'confirmSplitProposal')

    await expect(confirmSplitWorkflow(proposal.id)).rejects.toThrow(/disabled|VITE_CONSENSUS_SPLIT_ENABLED/)

    // Byte-identical dormancy: the gated flow never touches the repo confirm RPC,
    // never moves money, never settles.
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(paymentWorkflow.releaseEscrowWorkflow).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()

    // The proposal stays pending and the dispute stays open (not resolved).
    const stored = getDisputeRepository().getById(dispute.id)
    expect(stored?.status).toBe('under_review')
    expect(stored?.settlementStatus).not.toBe('settled')
  })
})

// ── Flag ON ───────────────────────────────────────────────────────────────────

describe('confirmSplitWorkflow — flag ON', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CONSENSUS_SPLIT_ENABLED', 'true')
  })

  it('happy path: settles via settleSplitConsensus (SECDEF RPC, NOT the party-blocked settleDispute) + resolved mirrors', async () => {
    const dispute = seedDispute('job-on-1', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')

    await confirmSplitWorkflow(proposal.id)

    // Money leg: persisted ratio (0.7, never a caller param) + actor 'consensus'.
    expect(paymentWorkflow.releaseEscrowWorkflow).toHaveBeenCalledWith(
      'job-on-1',
      dispute.id,
      0.7,
      'consensus',
    )
    // Settlement is driven by the SECDEF settle_consensus_split RPC (party
    // membership re-verified + sentinel-gated), NOT the plain settleDispute
    // PostgREST UPDATE which disputes_status_change_guard blocks (42501) for a
    // dispute party.
    expect(settleSpy).toHaveBeenCalledWith(dispute.id)
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
    expect(jobs.updateJobDisputeStatus).toHaveBeenCalledWith('job-on-1', 'resolved')
    expect(disputeTimeline.emitDisputeResolvedWithDecision).toHaveBeenCalledWith('job-on-1', 'split')
    expect(disputeTimeline.emitDisputeResolvedEvent).toHaveBeenCalledWith('job-on-1')
    // The in-memory RPC flips settlement_status pending→settled.
    expect(getDisputeRepository().getById(dispute.id)?.settlementStatus).toBe('settled')
    expect(observability.logError).not.toHaveBeenCalledWith(
      'workflow.dispute.consensus_split_settlement_failed',
      expect.anything(),
      expect.anything(),
    )
  })

  it('gating — bridge failure → stays pending + logError, NOT settled', async () => {
    const dispute = seedDispute('job-on-bridge', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-on-bridge'),
      bridgeFullySucceeded: false,
      refundFullySucceeded: true,
    })

    await confirmSplitWorkflow(proposal.id)

    expect(settleSpy).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-on-bridge', 'resolved')
    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.consensus_split_settlement_failed',
      undefined,
      expect.objectContaining({
        jobId: 'job-on-bridge',
        disputeId: dispute.id,
        failedStep: 'bridge_partial_failure',
        errorCode: 'DISPUTE_SPLIT_BRIDGE_FAILED',
      }),
    )
    // Dispute stays resolved=split but settlement pending (operator reconcile).
    const stored = getDisputeRepository().getById(dispute.id)
    expect(stored?.status).toBe('resolved')
    expect(stored?.settlementStatus).not.toBe('settled')
  })

  it('gating — refund failure → stays pending + logError SPLIT_REFUND_FAILED, NOT settled', async () => {
    const dispute = seedDispute('job-on-refund', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: mockPayment('job-on-refund'),
      bridgeFullySucceeded: true,
      refundFullySucceeded: false,
    })

    await confirmSplitWorkflow(proposal.id)

    expect(settleSpy).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.consensus_split_settlement_failed',
      undefined,
      expect.objectContaining({
        failedStep: 'refund_partial_failure',
        errorCode: 'SPLIT_REFUND_FAILED',
      }),
    )
  })

  it('gating — payment not found from release → stays pending + logError RELEASE_PAYMENT_NOT_FOUND', async () => {
    const dispute = seedDispute('job-on-nopay', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')

    vi.mocked(paymentWorkflow.releaseEscrowWorkflow).mockResolvedValue({
      payment: undefined,
      bridgeFullySucceeded: true,
      refundFullySucceeded: true,
    })

    await confirmSplitWorkflow(proposal.id)

    expect(settleSpy).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.consensus_split_settlement_failed',
      undefined,
      expect.objectContaining({
        failedStep: 'release_payment_not_found',
        errorCode: 'RELEASE_PAYMENT_NOT_FOUND',
      }),
    )
  })

  it('retry: resolved-but-pending re-entry does NOT crash on the consumed RPC, re-drives money with persisted ratio, settles once', async () => {
    // First pass already consumed the proposal (accepted) and resolved the dispute
    // to settlement_status='pending' — the money leg failed before settling. The
    // retry must NOT re-call the non-idempotent confirm RPC (which raises P0002 /
    // 'not pending'); it maps proposal → resolved dispute and re-drives money.
    const proposalId = await seedConfirmedSplit('job-on-retry', 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')

    // Sanity: a second direct confirm WOULD throw (the P0002 analog).
    await expect(getDisputeRepository().confirmSplitProposal(proposalId)).rejects.toThrow(/not_pending|pending/)

    // The retry succeeds (release now all-success) without crashing.
    await expect(confirmSplitWorkflow(proposalId)).resolves.toBeDefined()

    // Re-drove money with the PERSISTED ratio (0.7) — caller never supplies a ratio.
    expect(paymentWorkflow.releaseEscrowWorkflow).toHaveBeenCalledWith(
      'job-on-retry',
      'dispute-job-on-retry',
      0.7,
      'consensus',
    )
    // Settled once via the SECDEF RPC; never via the party-blocked settleDispute.
    expect(settleSpy).toHaveBeenCalledTimes(1)
    expect(settleSpy).toHaveBeenCalledWith('dispute-job-on-retry')
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })

  it('settle-RPC failure: money moved but settle throws → stays pending + logError, does NOT crash, no resolved mirrors', async () => {
    const dispute = seedDispute('job-on-settlefail', 'under_review')
    const proposal = await getDisputeRepository().proposeSplit(dispute.id, 0.7)
    // Money leg all-success (default mock), but the SECDEF settle RPC rejects
    // (e.g. a transient 42501 / network error). The workflow must not crash and
    // must leave settlement pending for operator reconcile.
    const settleError = new Error('settle_consensus_split failed')
    const settleSpy = vi
      .spyOn(getDisputeRepository(), 'settleSplitConsensus')
      .mockRejectedValue(settleError)

    await expect(confirmSplitWorkflow(proposal.id)).resolves.toBeDefined()

    expect(settleSpy).toHaveBeenCalledWith(dispute.id)
    // No false "resolved" signal: job mirror + resolved events are skipped.
    expect(jobs.updateJobDisputeStatus).not.toHaveBeenCalledWith('job-on-settlefail', 'resolved')
    expect(disputeTimeline.emitDisputeResolvedEvent).not.toHaveBeenCalled()
    expect(observability.logError).toHaveBeenCalledWith(
      'workflow.dispute.consensus_split_settle_failed',
      settleError,
      expect.objectContaining({
        jobId: 'job-on-settlefail',
        disputeId: dispute.id,
        errorCode: 'CONSENSUS_SETTLE_RPC_FAILED',
      }),
    )
    // Dispute stays resolved=split but settlement pending (operator reconcile).
    const stored = getDisputeRepository().getById(dispute.id)
    expect(stored?.status).toBe('resolved')
    expect(stored?.settlementStatus).not.toBe('settled')
  })

  it('already-settled re-entry is a no-op: no money movement, no settle', async () => {
    const proposalId = await seedConfirmedSplit('job-on-settled', 0.7)
    const settleSpy = vi.spyOn(getDisputeRepository(), 'settleSplitConsensus')
    // Mark the dispute settled (as the settle RPC would have).
    await getDisputeRepository().update('dispute-job-on-settled', (d) => ({
      ...d,
      settlementStatus: 'settled',
    }))

    const result = await confirmSplitWorkflow(proposalId)

    expect(result.settlementStatus).toBe('settled')
    expect(paymentWorkflow.releaseEscrowWorkflow).not.toHaveBeenCalled()
    expect(settleSpy).not.toHaveBeenCalled()
    expect(disputesService.settleDispute).not.toHaveBeenCalled()
  })
})

// ── Operator-path regression (must stay 'operator', flag-independent) ──────────

describe('resolveDisputeWorkflow split — operator path regression', () => {
  it('still releases with actor "operator" and settles, regardless of the consensus flag', async () => {
    // No consensus-flag stub: the operator path is NOT gated by VITE_CONSENSUS_SPLIT_ENABLED.
    const dispute = seedDispute('job-op-reg', 'under_review')

    await resolveDisputeWorkflow(dispute.id, 'split', 0.7)

    expect(paymentWorkflow.releaseEscrowWorkflow).toHaveBeenCalledWith(
      'job-op-reg',
      dispute.id,
      0.7,
      'operator',
    )
    expect(disputesService.settleDispute).toHaveBeenCalledWith('job-op-reg')
    expect(jobs.updateJobDisputeStatus).toHaveBeenCalledWith('job-op-reg', 'resolved')
  })
})
