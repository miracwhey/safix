/**
 * Sub-block 1.4 — Funding Artifact Phase await
 *
 * Verifies that updateFundingArtifactPhase errors are:
 *   1. Awaited (not fire-and-forget)
 *   2. Caught and logged via logError
 *   3. Never re-thrown — workflow result is unaffected
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

import { installSessionForJobCustomer } from '../helpers/mockSession'
vi.mock('../../src/lib/jobs', () => ({
  getJobById: vi.fn(),
}))

vi.mock('../../src/lib/payments/fundingRequest', () => ({
  getFundingRequestByJobId: vi.fn(),
  markFundingStarted: vi.fn().mockResolvedValue(undefined),
  markFundingCompleted: vi.fn().mockResolvedValue(undefined),
  ensureFundingRequest: vi.fn(),
  markFundingRequestSent: vi.fn(),
}))

vi.mock('../../src/lib/payments/escrow', () => ({
  getEscrowPlanByJobId: vi.fn(),
  initiateFunding: vi.fn().mockResolvedValue(undefined),
  confirmFunding: vi.fn().mockResolvedValue(undefined),
  getEscrowPlanByOfferId: vi.fn(),
  ensureEscrowPlan: vi.fn(),
  recordWorkStarted: vi.fn(),
  recordWorkCompleted: vi.fn(),
}))

vi.mock('../../src/lib/messages/threadArtifactService', () => ({
  updateFundingArtifactPhase: vi.fn(),
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('../../src/lib/analytics', () => ({
  recordAnalyticsEvent: vi.fn(),
}))

vi.mock('../../src/lib/timeline', () => ({
  ensureTimelineEvent: vi.fn(),
}))

// ── Imports (resolved after mock hoisting) ───────────────────────────────────

import { customerFundingEntryWorkflow, confirmFundingWorkflow } from '../../src/lib/workflow/jobWorkflow'
import { getJobById } from '../../src/lib/jobs'
import { getFundingRequestByJobId } from '../../src/lib/payments/fundingRequest'
import { getEscrowPlanByJobId } from '../../src/lib/payments/escrow'
import { updateFundingArtifactPhase } from '../../src/lib/messages/threadArtifactService'
import { logError } from '../../src/lib/observability'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const JOB_WITH_CONV = {
  id: 'job-1',
  sourceConversationId: 'conv-1',
  customerUserId: 'user-1',
}

const FUNDING_REQUEST = {
  id: 'fr-1',
  sourceOfferId: 'offer-1',
}

const ESCROW_PLAN = {
  id: 'ep-1',
  sourceOfferId: 'offer-1',
  totalAmount: 1000,
}

const JOB_FOR_CONFIRM = {
  id: 'job-2',
  sourceConversationId: 'conv-2',
  customerUserId: 'user-2',
}

const FUNDING_REQUEST_2 = {
  id: 'fr-2',
  sourceOfferId: 'offer-2',
}

const ESCROW_PLAN_2 = {
  id: 'ep-2',
  sourceOfferId: 'offer-2',
  totalAmount: 2000,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sub-block 1.4 — Funding Artifact Phase await + error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── customerFundingEntryWorkflow ──────────────────────────────────────────

  describe('customerFundingEntryWorkflow: funding_started phase', () => {
    beforeEach(() => {
      installSessionForJobCustomer({ customerUserId: 'user-1' })
    })
    it('returns normal result when updateFundingArtifactPhase throws', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_WITH_CONV as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN as never)
      vi.mocked(updateFundingArtifactPhase).mockRejectedValue(new Error('Supabase write failed'))

      const result = await customerFundingEntryWorkflow('job-1')

      expect(result).toBeDefined()
      expect(result?.fundingRequestId).toBe('fr-1')
      expect(result?.escrowPlanId).toBe('ep-1')
    })

    it('calls logError when updateFundingArtifactPhase throws', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_WITH_CONV as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN as never)
      vi.mocked(updateFundingArtifactPhase).mockRejectedValue(new Error('Supabase write failed'))

      await customerFundingEntryWorkflow('job-1')

      expect(vi.mocked(logError)).toHaveBeenCalledWith(
        'workflow.funding.artifact_phase_failed',
        expect.any(Error),
        expect.objectContaining({ jobId: 'job-1', phase: 'funding_started' })
      )
    })

    it('does not call logError when updateFundingArtifactPhase succeeds', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_WITH_CONV as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN as never)
      vi.mocked(updateFundingArtifactPhase).mockResolvedValue(undefined as never)

      await customerFundingEntryWorkflow('job-1')

      expect(vi.mocked(logError)).not.toHaveBeenCalled()
    })
  })

  // ── confirmFundingWorkflow ────────────────────────────────────────────────

  describe('confirmFundingWorkflow: funded phase', () => {
    beforeEach(() => {
      installSessionForJobCustomer({ customerUserId: 'user-2' })
    })
    it('returns normal result when updateFundingArtifactPhase throws', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_FOR_CONFIRM as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST_2 as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN_2 as never)
      vi.mocked(updateFundingArtifactPhase).mockRejectedValue(new Error('Supabase write failed'))

      const result = await confirmFundingWorkflow('job-2')

      expect(result).toBeDefined()
      expect(result?.fundingRequestId).toBe('fr-2')
      expect(result?.escrowPlanId).toBe('ep-2')
      expect(result?.status).toBe('funded_in_escrow')
    })

    it('calls logError when updateFundingArtifactPhase throws', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_FOR_CONFIRM as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST_2 as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN_2 as never)
      vi.mocked(updateFundingArtifactPhase).mockRejectedValue(new Error('Supabase write failed'))

      await confirmFundingWorkflow('job-2')

      expect(vi.mocked(logError)).toHaveBeenCalledWith(
        'workflow.funding.artifact_phase_failed',
        expect.any(Error),
        expect.objectContaining({ jobId: 'job-2', phase: 'funded' })
      )
    })

    it('does not call logError when updateFundingArtifactPhase succeeds', async () => {
      vi.mocked(getJobById).mockReturnValue(JOB_FOR_CONFIRM as never)
      vi.mocked(getFundingRequestByJobId).mockReturnValue(FUNDING_REQUEST_2 as never)
      vi.mocked(getEscrowPlanByJobId).mockReturnValue(ESCROW_PLAN_2 as never)
      vi.mocked(updateFundingArtifactPhase).mockResolvedValue(undefined as never)

      await confirmFundingWorkflow('job-2')

      expect(vi.mocked(logError)).not.toHaveBeenCalled()
    })
  })
})
