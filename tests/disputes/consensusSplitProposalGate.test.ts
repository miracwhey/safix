/**
 * P4 Teil B backfill — consensus-split proposal workflow gates
 *
 * Teil B shipped the propose / confirm / reject consensus-split flow with no
 * unit tests. The DB-side authorization (auth.uid() inside the SECDEF RPCs) is
 * the real security boundary; this layer adds the two MANDATED workflow-layer
 * gates (CLAUDE.md) plus delegation:
 *
 *   1. Feature flag — VITE_CONSENSUS_SPLIT_ENABLED, read at call time, strict
 *      `=== 'true'`, default OFF. While OFF every entry point early-throws
 *      BEFORE touching the repository (dormant / byte-identical to today).
 *   2. Hydration — the dispute repository must be hydrated before any
 *      trust-critical dispute action.
 *   3. Delegation — once both gates pass, the workflow delegates verbatim to the
 *      repository RPC wrapper (proposeSplit / confirmSplitProposal / rejectSplitProposal).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  proposeSplitWorkflow,
  confirmSplitWorkflow,
  rejectSplitWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import type { Dispute, SplitProposal } from '../../src/lib/disputes/types'

const DISPUTE_ID = 'dispute-teilb-1'
const JOB_ID = 'job-teilb-1'
const PROPOSAL_ID = 'proposal-teilb-1'

function fakeProposal(overrides: Partial<SplitProposal> = {}): SplitProposal {
  return {
    id: PROPOSAL_ID,
    disputeId: DISPUTE_ID,
    jobId: JOB_ID,
    proposedBy: 'party-a',
    proposedRatio: 0.6,
    status: 'pending',
    proposalRound: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function fakeResolvedDispute(): Dispute {
  return {
    id: DISPUTE_ID,
    jobId: JOB_ID,
    paymentId: `pay-${JOB_ID}`,
    status: 'resolved',
    decision: 'split',
    resolutionType: 'split',
    splitRatio: 0.6,
    settlementStatus: 'settled',
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── Flag gate (OFF by default) ────────────────────────────────────────────────

describe('consensus-split workflow — flag OFF early-throws before the repo', () => {
  it('proposeSplitWorkflow throws and never calls repo.proposeSplit', async () => {
    const spy = vi.spyOn(getDisputeRepository(), 'proposeSplit')
    await expect(proposeSplitWorkflow(DISPUTE_ID, 0.6)).rejects.toThrow(
      /disabled|VITE_CONSENSUS_SPLIT_ENABLED/,
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('confirmSplitWorkflow throws and never calls repo.confirmSplitProposal', async () => {
    const spy = vi.spyOn(getDisputeRepository(), 'confirmSplitProposal')
    await expect(confirmSplitWorkflow(PROPOSAL_ID)).rejects.toThrow(
      /disabled|VITE_CONSENSUS_SPLIT_ENABLED/,
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejectSplitWorkflow throws and never calls repo.rejectSplitProposal', async () => {
    const spy = vi.spyOn(getDisputeRepository(), 'rejectSplitProposal')
    await expect(rejectSplitWorkflow(PROPOSAL_ID)).rejects.toThrow(
      /disabled|VITE_CONSENSUS_SPLIT_ENABLED/,
    )
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── Hydration gate (flag ON, repo not yet hydrated) ───────────────────────────

describe('consensus-split workflow — hydration gate (flag ON)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CONSENSUS_SPLIT_ENABLED', 'true')
  })

  it('proposeSplitWorkflow throws when the dispute repo is not hydrated', async () => {
    const repo = getDisputeRepository()
    vi.spyOn(repo, 'isHydrated').mockReturnValue(false)
    const spy = vi.spyOn(repo, 'proposeSplit')
    await expect(proposeSplitWorkflow(DISPUTE_ID, 0.6)).rejects.toThrow(/not hydrated/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('confirmSplitWorkflow throws when the dispute repo is not hydrated', async () => {
    const repo = getDisputeRepository()
    vi.spyOn(repo, 'isHydrated').mockReturnValue(false)
    const spy = vi.spyOn(repo, 'confirmSplitProposal')
    await expect(confirmSplitWorkflow(PROPOSAL_ID)).rejects.toThrow(/not hydrated/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejectSplitWorkflow throws when the dispute repo is not hydrated', async () => {
    const repo = getDisputeRepository()
    vi.spyOn(repo, 'isHydrated').mockReturnValue(false)
    const spy = vi.spyOn(repo, 'rejectSplitProposal')
    await expect(rejectSplitWorkflow(PROPOSAL_ID)).rejects.toThrow(/not hydrated/)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── Delegation (flag ON, hydrated) ────────────────────────────────────────────

describe('consensus-split workflow — delegates to the repo once gates pass', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CONSENSUS_SPLIT_ENABLED', 'true')
  })

  it('proposeSplitWorkflow delegates verbatim to repo.proposeSplit(disputeId, ratio)', async () => {
    const proposal = fakeProposal()
    const spy = vi.spyOn(getDisputeRepository(), 'proposeSplit').mockResolvedValue(proposal)

    const result = await proposeSplitWorkflow(DISPUTE_ID, 0.6)

    expect(spy).toHaveBeenCalledWith(DISPUTE_ID, 0.6)
    expect(result).toBe(proposal)
  })

  it('rejectSplitWorkflow delegates verbatim to repo.rejectSplitProposal(proposalId)', async () => {
    const rejected = fakeProposal({ status: 'rejected' })
    const spy = vi.spyOn(getDisputeRepository(), 'rejectSplitProposal').mockResolvedValue(rejected)

    const result = await rejectSplitWorkflow(PROPOSAL_ID)

    expect(spy).toHaveBeenCalledWith(PROPOSAL_ID)
    expect(result).toBe(rejected)
  })

  it('confirmSplitWorkflow delegates to repo.confirmSplitProposal(proposalId) on the first pass', async () => {
    // Short-circuit the money leg: confirm returns an already-settled dispute so
    // confirmSplitWorkflow returns immediately after the consume RPC (no release).
    const confirmSpy = vi
      .spyOn(getDisputeRepository(), 'confirmSplitProposal')
      .mockResolvedValue(fakeResolvedDispute())

    await confirmSplitWorkflow(PROPOSAL_ID)

    expect(confirmSpy).toHaveBeenCalledWith(PROPOSAL_ID)
  })
})
