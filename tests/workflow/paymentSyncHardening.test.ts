/**
 * Block 10 — Payment Sync Hardening
 *
 * Verifies that terminal payment transitions (release/refund) emit a prominent
 * logError alert when downstream job/project sync fails, instead of silently
 * treating partial success as fully done.
 *
 * Covers:
 *   A. release: logError('workflow.payment_sync.terminal_divergence') when job sync fails
 *   B. release: payment still returned when sync fails (Stripe already captured)
 *   C. refund: logError('workflow.payment_sync.terminal_divergence') when job sync fails
 *   D. refund: payment still returned when sync fails
 *   E. release: NO terminal_divergence on clean happy path
 *   F. refund: NO terminal_divergence on clean happy path
 *   G. non-terminal path: does NOT emit terminal_divergence
 */

// ── Mocks must come before imports (hoisted by Vitest) ───────────────────────

const mockLogError = vi.fn()
const mockLogWarning = vi.fn()
const mockLogInfo = vi.fn()

vi.mock('../../src/lib/observability', () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
  logWarning: (...args: unknown[]) => mockLogWarning(...args),
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
}))

// updateJobPaymentState is toggled per-test to simulate sync failure
const mockUpdateJobPaymentState = vi.fn().mockResolvedValue(undefined)
const mockUpdateJobPaymentReleased = vi.fn().mockResolvedValue(undefined)
const mockGetJobById = vi.fn()

vi.mock('../../src/lib/jobs', () => ({
  getJobById: (...args: unknown[]) => mockGetJobById(...args),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
  updateJobPaymentState: (...args: unknown[]) => mockUpdateJobPaymentState(...args),
  updateJobWorkCompleted: vi.fn().mockResolvedValue(undefined),
  updateJobPaymentReleased: (...args: unknown[]) => mockUpdateJobPaymentReleased(...args),
  updateJobProposalFields: vi.fn().mockResolvedValue(undefined),
  markProposalSent: vi.fn().mockResolvedValue(undefined),
  markProposalAccepted: vi.fn().mockResolvedValue(undefined),
  addJobNote: vi.fn().mockResolvedValue(undefined),
  addJobPhoto: vi.fn().mockResolvedValue(undefined),
  linkJobToSourceOffer: vi.fn().mockResolvedValue(undefined),
  getJobs: vi.fn().mockReturnValue([]),
  parseJobAmount: vi.fn().mockReturnValue(null),
  toggleAssignedMember: vi.fn().mockResolvedValue(undefined),
}))

// releaseEscrowPayment and refundEscrowPayment are toggled to return real-ish results
const mockReleaseEscrowPayment = vi.fn()
const mockRefundEscrowPayment = vi.fn()
const mockAttemptSplitRefundRetry = vi.fn()
const mockConfirmDepositPayment = vi.fn()
const mockCreateEscrowPayment = vi.fn()
const mockUpdatePaymentAmounts = vi.fn()
const mockGetPaymentForJob = vi.fn()
const mockUpdatePaymentState = vi.fn()
const mockEnsurePaymentForJob = vi.fn()
const mockRequestServerTrancheRelease = vi.fn()
const mockIsEscrowPlanRepositoryHydrated = vi.fn().mockReturnValue(false)
const mockGetEscrowPlanByJobId = vi.fn().mockReturnValue(null)
const mockGetEscrowTranches = vi.fn().mockReturnValue([])

vi.mock('../../src/lib/payments/service', () => ({
  releaseEscrowPayment: (...args: unknown[]) => mockReleaseEscrowPayment(...args),
  refundEscrowPayment: (...args: unknown[]) => mockRefundEscrowPayment(...args),
  attemptSplitRefundRetry: (...args: unknown[]) => mockAttemptSplitRefundRetry(...args),
  confirmDepositPayment: (...args: unknown[]) => mockConfirmDepositPayment(...args),
  createEscrowPayment: (...args: unknown[]) => mockCreateEscrowPayment(...args),
  updatePaymentAmounts: (...args: unknown[]) => mockUpdatePaymentAmounts(...args),
  getPaymentForJob: (...args: unknown[]) => mockGetPaymentForJob(...args),
  updatePaymentState: (...args: unknown[]) => mockUpdatePaymentState(...args),
  ensurePaymentForJob: (...args: unknown[]) => mockEnsurePaymentForJob(...args),
  writeSplitRefundLedgerEntry: (...args: unknown[]) => mockWriteSplitRefundLedgerEntry(...args),
  writeSplitPayoutLedgerEntries: (...args: unknown[]) => mockWriteSplitPayoutLedgerEntries(...args),
  writeNonSplitDisputePayoutLedgerEntries: (...args: unknown[]) => mockWriteNonSplitDisputePayoutLedgerEntries(...args),
}))

vi.mock('../../src/lib/projects', () => ({
  getProjectByJobId: vi.fn().mockReturnValue(null),
  updateProject: vi.fn(),
  getProjectById: vi.fn().mockReturnValue(null),
  deriveProjectStatusFromJob: vi.fn(),
  addProject: vi.fn(),
}))

vi.mock('../../src/lib/invoices', () => ({
  syncInvoiceWithPayment: vi.fn().mockResolvedValue(undefined),
  ensureInvoiceForJob: vi.fn().mockResolvedValue(undefined),
  isInvoiceRepositoryHydrated: vi.fn().mockReturnValue(true),
  getInvoiceByJobId: vi.fn().mockReturnValue(undefined),
}))

const mockHasTimelineEventOfType = vi.fn().mockReturnValue(false)

vi.mock('../../src/lib/timeline', () => ({
  ensureTimelineEvent: vi.fn(),
  hasTimelineEventOfType: (...args: unknown[]) => mockHasTimelineEventOfType(...args),
}))

vi.mock('../../src/lib/notifications/delivery', () => ({
  sendPaymentReleaseRequestedEmail: vi.fn(),
  sendEscrowLockedEmail: vi.fn(),
  sendPaymentReleasedEmail: vi.fn(),
  sendPayoutHandoffInitiatedEmail: vi.fn(),
}))

vi.mock('../../src/lib/analytics', () => ({
  recordAnalyticsEvent: vi.fn(),
  recordAnalyticsEventOnce: vi.fn(),
}))

const mockRunPaymentReleasedSideEffects = vi.fn()
const mockRunPaymentRefundedSideEffects = vi.fn()
const mockWriteSplitRefundLedgerEntry = vi.fn()
const mockWriteSplitPayoutLedgerEntries = vi.fn()
const mockWriteNonSplitDisputePayoutLedgerEntries = vi.fn()

vi.mock('../../src/lib/workflow/hooks/paymentHooks', () => ({
  runPaymentReleasedSideEffects: (...args: unknown[]) => mockRunPaymentReleasedSideEffects(...args),
  runPaymentRefundedSideEffects: (...args: unknown[]) => mockRunPaymentRefundedSideEffects(...args),
}))

vi.mock('../../src/lib/disputes', () => ({
  openDispute: vi.fn(),
  getDisputeByJobId: vi.fn().mockReturnValue(undefined),
}))

vi.mock('../../src/lib/disputes/repository', () => ({
  getDisputeRepository: vi.fn().mockReturnValue({ isHydrated: () => true }),
}))

vi.mock('../../src/lib/disputes/stateMachine', () => ({
  isDisputeBlocking: vi.fn().mockReturnValue(false),
}))

vi.mock('../../src/lib/disputes/disputeContextSnapshot', () => ({
  buildDisputeContextSnapshot: vi.fn().mockReturnValue({}),
}))

vi.mock('../../src/lib/payments/stateMachine', () => ({
  canTransition: vi.fn().mockReturnValue(true),
}))

vi.mock('../../src/lib/shared/canonicalAmountResolver', () => ({
  resolveCanonicalAmount: vi.fn().mockReturnValue({ amount: 1000 }),
}))

vi.mock('../../src/lib/payments/releaseClient', () => ({
  requestServerTrancheRelease: (...args: unknown[]) => mockRequestServerTrancheRelease(...args),
}))

vi.mock('../../src/lib/payments/escrow', () => ({
  initializeEscrowPlanRepository: vi.fn().mockResolvedValue(undefined),
  getEscrowPlanByJobId: (...args: unknown[]) => mockGetEscrowPlanByJobId(...args),
  getEscrowTranches: (...args: unknown[]) => mockGetEscrowTranches(...args),
  recordWorkStarted: vi.fn(),
  recordWorkCompleted: vi.fn(),
  isTriggerSatisfied: vi.fn().mockReturnValue(false),
  isEscrowPlanRepositoryHydrated: () => mockIsEscrowPlanRepositoryHydrated(),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
  updatePaymentWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import type { Payment } from '../../src/lib/payments/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePayment(jobId: string, state: Payment['state']): Partial<Payment> {
  return {
    id: `pay_${jobId}`,
    jobId,
    state,
    providerRef: 'pi_test_123',
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 10 — Payment Sync Hardening', () => {
  const JOB_ID = 'job-sync-test'

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: sync succeeds
    mockUpdateJobPaymentState.mockResolvedValue(undefined)
    // Default: release/refund return updated payment
    mockReleaseEscrowPayment.mockResolvedValue({ payment: makePayment(JOB_ID, 'released'), splitRefundSucceeded: true })
    mockRefundEscrowPayment.mockResolvedValue(makePayment(JOB_ID, 'refunded'))
    mockAttemptSplitRefundRetry.mockResolvedValue(true)
    mockUpdatePaymentState.mockResolvedValue(makePayment(JOB_ID, 'deposit_paid'))
    mockEnsurePaymentForJob.mockResolvedValue(makePayment(JOB_ID, 'deposit_required'))
    mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'release_pending'))
    // Default: hydrated escrow repo WITHOUT a plan — the LEGACY capture path
    // (releaseEscrowPayment is the complete release, bridge trivially succeeds).
    // C1: an unhydrated repo now routes to the fail-closed corridor branch
    // (capture skipped); tests that need it set it explicitly.
    mockRequestServerTrancheRelease.mockResolvedValue({ ok: true, data: { requiresReconciliation: false } })
    mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
    mockGetEscrowPlanByJobId.mockReturnValue(null)
    mockGetEscrowTranches.mockReturnValue([])
    // Default: job at waiting_payment, side effects succeed
    mockGetJobById.mockImplementation((jobId: string) => ({
      id: jobId,
      title: 'Test Job',
      status: 'waiting_payment',
      paymentState: 'release_pending',
      craftsmanUserId: 'craftsman-1',
      customerUserId: 'customer-1',
      projectId: undefined,
    }))
    mockRunPaymentReleasedSideEffects.mockResolvedValue(undefined)
    mockRunPaymentRefundedSideEffects.mockResolvedValue(undefined)
    mockUpdateJobPaymentReleased.mockResolvedValue(undefined)
    mockWriteSplitRefundLedgerEntry.mockReturnValue(undefined)
    mockWriteSplitPayoutLedgerEntries.mockReturnValue(undefined)
    mockWriteNonSplitDisputePayoutLedgerEntries.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── A. release: logError on job sync failure ──────────────────────────────

  describe('A. releaseEscrowWorkflow: logError on job sync failure', () => {
    it('emits terminal_divergence error when job payment state sync fails', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      await releaseEscrowWorkflow(JOB_ID)

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors.length).toBeGreaterThan(0)
      expect(terminalErrors[0][2]).toMatchObject({
        jobId: JOB_ID,
        paymentState: 'released',
        operation: 'release',
        jobSynced: false,
      })
    })

    it('includes projectSynced and projectNotFound in the error context', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      await releaseEscrowWorkflow(JOB_ID)

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors[0][2]).toHaveProperty('projectSynced')
      expect(terminalErrors[0][2]).toHaveProperty('projectNotFound')
    })
  })

  // ── B. release: payment still returned on sync failure ───────────────────

  describe('B. releaseEscrowWorkflow: payment returned despite sync failure', () => {
    it('returns the payment with released state even when job sync fails', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      const result = await releaseEscrowWorkflow(JOB_ID)

      expect(result?.payment?.state).toBe('released')
    })
  })

  // ── C. refund: logError on job sync failure ───────────────────────────────

  describe('C. refundEscrowWorkflow: logError on job sync failure', () => {
    it('emits terminal_divergence error when job payment state sync fails', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      await refundEscrowWorkflow(JOB_ID)

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors.length).toBeGreaterThan(0)
      expect(terminalErrors[0][2]).toMatchObject({
        jobId: JOB_ID,
        paymentState: 'refunded',
        operation: 'refund',
        jobSynced: false,
      })
    })
  })

  // ── D. refund: payment still returned on sync failure ────────────────────

  describe('D. refundEscrowWorkflow: payment returned despite sync failure', () => {
    it('returns the payment with refunded state even when job sync fails', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      const result = await refundEscrowWorkflow(JOB_ID)

      expect(result?.state).toBe('refunded')
    })
  })

  // ── E. release: NO terminal_divergence on happy path ─────────────────────

  describe('E. releaseEscrowWorkflow: no terminal_divergence on clean success', () => {
    it('does not emit terminal_divergence when all syncs succeed', async () => {
      await releaseEscrowWorkflow(JOB_ID)

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors).toHaveLength(0)
    })

    it('returns the released payment on happy path', async () => {
      const result = await releaseEscrowWorkflow(JOB_ID)
      expect(result?.payment?.state).toBe('released')
    })
  })

  // ── F. refund: NO terminal_divergence on happy path ──────────────────────

  describe('F. refundEscrowWorkflow: no terminal_divergence on clean success', () => {
    it('does not emit terminal_divergence when all syncs succeed', async () => {
      await refundEscrowWorkflow(JOB_ID)

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors).toHaveLength(0)
    })

    it('returns the refunded payment on happy path', async () => {
      const result = await refundEscrowWorkflow(JOB_ID)
      expect(result?.state).toBe('refunded')
    })
  })

  // ── G. non-terminal path: no terminal_divergence even on sync failure ────

  describe('G. updatePaymentWorkflow: no terminal_divergence on sync failure', () => {
    it('does NOT emit terminal_divergence for non-terminal state transitions', async () => {
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      await updatePaymentWorkflow(JOB_ID, 'deposit_paid').catch(() => {
        // updatePaymentWorkflow may fail for other reasons in this mock setup
      })

      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors).toHaveLength(0)
    })
  })

  // ── H. bridge-retry with splitRatio: idempotent refund, no double-refund ─

  describe('H. releaseEscrowWorkflow bridge-retry with split: idempotent refund retry', () => {
    it('bridge retry with split, refund succeeds: returns refundFullySucceeded=true without calling releaseEscrowPayment', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-test-123', 0.7)

      expect(result.refundFullySucceeded).toBe(true)
      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
      expect(mockAttemptSplitRefundRetry).toHaveBeenCalledWith(
        JOB_ID,
        { splitRatio: 0.7, disputeId: 'dispute-test-123' },
      )
    })

    it('bridge retry with split, Stripe refund explicitly fails: returns refundFullySucceeded=false, bridgeFullySucceeded=false, no bridge', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(false)

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-test-456', 0.7)

      expect(result.refundFullySucceeded).toBe(false)
      expect(result.bridgeFullySucceeded).toBe(false)
      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
    })

    it('non-split bridge retry: refundFullySucceeded=true, attemptSplitRefundRetry not called', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-test-789')

      expect(result.refundFullySucceeded).toBe(true)
      expect(mockAttemptSplitRefundRetry).not.toHaveBeenCalled()
      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
    })

    it('two consecutive retries call attemptSplitRefundRetry with identical params (stable idempotency key)', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-idempotency-test', 0.7)
      await releaseEscrowWorkflow(JOB_ID, 'dispute-idempotency-test', 0.7)

      expect(mockAttemptSplitRefundRetry).toHaveBeenCalledTimes(2)
      expect(mockAttemptSplitRefundRetry).toHaveBeenNthCalledWith(1, JOB_ID, {
        splitRatio: 0.7,
        disputeId: 'dispute-idempotency-test',
      })
      expect(mockAttemptSplitRefundRetry).toHaveBeenNthCalledWith(2, JOB_ID, {
        splitRatio: 0.7,
        disputeId: 'dispute-idempotency-test',
      })
    })
  })

  // ── I. Initial split path: bridge blocked when customer refund fails ──────

  describe('I. releaseEscrowWorkflow initial split: bridge blocked on refund failure', () => {
    beforeEach(() => {
      // Escrow is hydrated with one eligible tranche so the bridge WOULD run
      // if the refundFullySucceeded guard were absent. With a plan present the
      // workflow takes the CORRIDOR branch (C1): no releaseEscrowPayment
      // capture; the split refund leg runs via attemptSplitRefundRetry.
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockGetEscrowPlanByJobId.mockReturnValue({ id: 'plan-1', jobId: JOB_ID })
      mockGetEscrowTranches.mockReturnValue([
        { id: 'tranche-1', status: 'eligible_for_release', kind: 'final_release' },
      ])
    })

    it('requestServerTrancheRelease not called when the customer refund fails', async () => {
      mockAttemptSplitRefundRetry.mockResolvedValue(false)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-split-fail', 0.7)

      expect(mockRequestServerTrancheRelease).not.toHaveBeenCalled()
      // Corridor: the retired capture path must never fire.
      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
    })

    it('returns refundFullySucceeded=false and bridgeFullySucceeded=false when refund fails', async () => {
      mockAttemptSplitRefundRetry.mockResolvedValue(false)

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-split-fail', 0.7)

      expect(result.refundFullySucceeded).toBe(false)
      expect(result.bridgeFullySucceeded).toBe(false)
    })

    it('bridge runs when the customer refund succeeds (guard does not over-block)', async () => {
      mockAttemptSplitRefundRetry.mockResolvedValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-split-ok', 0.7)

      expect(mockRequestServerTrancheRelease).toHaveBeenCalledTimes(1)
      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
    })
  })

  // ── J. Side-effect recovery on split-dispute bridge-retry ─────────────────

  describe('J. releaseEscrowWorkflow split-retry: side effects run on first completion', () => {
    it('first attempt with splitRefundSucceeded=false: runPaymentReleasedSideEffects not called', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'release_pending'))
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: false,
      })

      await releaseEscrowWorkflow(JOB_ID, 'dispute-j1', 0.7)

      expect(mockRunPaymentReleasedSideEffects).not.toHaveBeenCalled()
    })

    it('bridge-retry, paymentReleasedAt not set (first attempt failed mid-flow): side effects run', async () => {
      // payment already 'released' → isDisputeBridgeRetry=true
      // paymentReleasedAt absent (prior attempt failed after refund but before stamp)
      // Escrow hydrated, no plan → bridge trivially succeeds → side effects should fire
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      // default: getJobById returns no paymentReleasedAt → paymentWasAlreadyReleased=false

      await releaseEscrowWorkflow(JOB_ID, 'dispute-j2', 0.7)

      expect(mockRunPaymentReleasedSideEffects).toHaveBeenCalledTimes(1)
    })

    it('bridge-retry, paymentReleasedAt set and timeline event exists (first attempt fully succeeded): side effects not re-run', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      // Both markers present: stamp + timeline event → side effects already ran
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId,
        title: 'Test Job',
        status: 'completed',
        paymentState: 'released',
        paymentReleasedAt: 1_700_000_000_000,
        craftsmanUserId: 'craftsman-1',
        customerUserId: 'customer-1',
        projectId: undefined,
      }))
      mockHasTimelineEventOfType.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-j3', 0.7)

      expect(mockRunPaymentReleasedSideEffects).not.toHaveBeenCalled()
    })
  })

  // ── K. Mirror-sync repair on bridge-retry ────────────────────────────────

  describe('K. releaseEscrowWorkflow bridge-retry: stale job/project mirrors repaired', () => {
    it('bridge-retry runs syncPaymentStateToJobAndProject (updateJobPaymentState called)', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-k1', 0.7)

      expect(mockUpdateJobPaymentState).toHaveBeenCalled()
    })

    it('bridge-retry: mirror-sync failure → bridgeFullySucceeded=false and terminal_divergence logged', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockUpdateJobPaymentState.mockRejectedValue(new Error('DB write failed'))

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-k2', 0.7)

      expect(result.bridgeFullySucceeded).toBe(false)
      const terminalErrors = mockLogError.mock.calls.filter(
        (args) => args[0] === 'workflow.payment_sync.terminal_divergence',
      )
      expect(terminalErrors.length).toBeGreaterThan(0)
    })

    it('bridge-retry: mirror-sync success + refund/bridge success → bridgeFullySucceeded=true', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockUpdateJobPaymentState.mockResolvedValue(undefined)
      // Hydrated but no escrow plan: legacy release path, bridge trivially succeeds.
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      const result = await releaseEscrowWorkflow(JOB_ID, 'dispute-k3', 0.7)

      expect(result.bridgeFullySucceeded).toBe(true)
      expect(result.refundFullySucceeded).toBe(true)
    })

    it('non-split bridge-retry: sync also runs and mirrors are repaired', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-k4')

      expect(mockUpdateJobPaymentState).toHaveBeenCalled()
    })
  })

  // ── L. Mirror publication gate for dispute settlements ───────────────────
  //
  // Verifies that syncPaymentStateToJobAndProject is never called while
  // dispute settlement is still unresolved (refund or bridge not yet confirmed),
  // and is called exactly once when all money movements succeed.

  describe('L. releaseEscrowWorkflow dispute mirror publication gate', () => {
    it('dispute: refund failure → syncPaymentStateToJobAndProject not called', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: false,
      })

      await releaseEscrowWorkflow(JOB_ID, 'dispute-l1', 0.7)

      expect(mockUpdateJobPaymentState).not.toHaveBeenCalled()
    })

    it('dispute: bridge failure (unhydrated) → syncPaymentStateToJobAndProject not called', async () => {
      // Unhydrated escrow repo → corridor-unknown fail-closed branch: capture is
      // skipped and the bridge defers → bridgeFullySucceeded=false → no publish.
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(false)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-l2', 0.7)

      expect(mockUpdateJobPaymentState).not.toHaveBeenCalled()
    })

    it('dispute: bridge success → syncPaymentStateToJobAndProject called once', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: true,
      })
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-l3', 0.7)

      expect(mockUpdateJobPaymentState).toHaveBeenCalledTimes(1)
    })

    it('non-dispute legacy: syncPaymentStateToJobAndProject called after the terminal capture', async () => {
      // Legacy (no plan): the capture flips the payment to 'released' → the
      // terminal mirror sync runs immediately, independent of the bridge.
      await releaseEscrowWorkflow(JOB_ID)

      expect(mockUpdateJobPaymentState).toHaveBeenCalledTimes(1)
    })

    it('non-dispute corridor (unhydrated): no capture, no premature terminal sync', async () => {
      // C1: corridor-unknown fail-closed — the legacy capture must NOT run and
      // no 'released' state may be published while the bridge is deferred.
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(false)

      const result = await releaseEscrowWorkflow(JOB_ID)

      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
      expect(mockUpdateJobPaymentState).not.toHaveBeenCalled()
      expect(result.bridgeFullySucceeded).toBe(false)
    })
  })

  // ── M. Normal release retry: payment already 'released', bridge not yet done ─
  //
  // A prior non-dispute attempt captured via Stripe but the escrow repo was
  // unhydrated (or the tranche bridge failed).  The next call must skip the
  // Stripe capture, run the bridge, and complete the job — without a second
  // capture or double side effects.

  describe('M. releaseEscrowWorkflow normal-release retry (isPaymentAlreadyReleased)', () => {
    it('payment already released + hydrated escrow → bridge succeeds, completion runs', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      const result = await releaseEscrowWorkflow(JOB_ID)

      expect(result.bridgeFullySucceeded).toBe(true)
      expect(result.refundFullySucceeded).toBe(true)
    })

    it('payment already released → releaseEscrowPayment (Stripe capture) not called', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID)

      expect(mockReleaseEscrowPayment).not.toHaveBeenCalled()
    })

    it('paymentReleasedAt set → side effects not re-run (stamp proves effects completed)', async () => {
      // paymentReleasedAt is written AFTER runPaymentReleasedSideEffects completes.
      // Its presence means all effects already ran on a prior attempt — safe to skip.
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId, title: 'Test Job', status: 'completed',
        paymentState: 'released', paymentReleasedAt: 1_700_000_000_000,
        craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', projectId: undefined,
      }))

      await releaseEscrowWorkflow(JOB_ID)

      expect(mockRunPaymentReleasedSideEffects).not.toHaveBeenCalled()
      expect(mockUpdateJobPaymentReleased).not.toHaveBeenCalled()
    })

    it('paymentReleasedAt missing → side effects run and stamp is set afterwards', async () => {
      // Crash/retry scenario: payment already released in Stripe+DB but stamp not yet set
      // (i.e. prior attempt crashed between side effects and stamp, or between capture and
      // effects). Effects run, THEN stamp is written.
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId, title: 'Test Job', status: 'completed',
        paymentState: 'released', paymentReleasedAt: undefined,
        craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', projectId: undefined,
      }))

      await releaseEscrowWorkflow(JOB_ID)

      expect(mockRunPaymentReleasedSideEffects).toHaveBeenCalledTimes(1)
      expect(mockUpdateJobPaymentReleased).toHaveBeenCalledTimes(1)
      // Order: effects before stamp
      const effectsOrder = mockRunPaymentReleasedSideEffects.mock.invocationCallOrder[0]
      const stampOrder = mockUpdateJobPaymentReleased.mock.invocationCallOrder[0]
      expect(effectsOrder).toBeLessThan(stampOrder)
    })

    it('runPaymentReleasedSideEffects throws → updateJobPaymentReleased not called (stamp not set)', async () => {
      // Guarantees that paymentReleasedAt is never set when side effects fail.
      // On retry, paymentWasAlreadyReleased=false → effects will re-run.
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId, title: 'Test Job', status: 'completed',
        paymentState: 'released', paymentReleasedAt: undefined,
        craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', projectId: undefined,
      }))
      mockRunPaymentReleasedSideEffects.mockRejectedValue(new Error('hook failure'))

      await releaseEscrowWorkflow(JOB_ID).catch(() => {})

      expect(mockUpdateJobPaymentReleased).not.toHaveBeenCalled()
    })

    it('payment already released, job already completed → job status guard not blocking retry', async () => {
      // Simulates: first attempt advanced job to 'completed' then crashed before
      // runPaymentReleasedSideEffects completed (stamp not yet set). Without the
      // isPaymentAlreadyReleased bypass the job-status guard would reject the retry.
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId, title: 'Test Job', status: 'completed',
        paymentState: 'released', paymentReleasedAt: undefined,
        craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', projectId: undefined,
      }))

      const result = await releaseEscrowWorkflow(JOB_ID)

      expect(result.bridgeFullySucceeded).toBe(true)
      expect(result.payment).toBeDefined()
    })
  })

  // ── N. Split dispute ledger publication gates ───────────────────────────────
  //
  // Verifies that realized-payout and refund ledger entries are never written
  // before the corresponding money movement is confirmed.

  describe('N. Split dispute ledger publication gates', () => {
    it('split dispute bridge failure → writeSplitPayoutLedgerEntries not called', async () => {
      // Unhydrated → corridor fail-closed → bridgeFullySucceeded=false
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(false)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-n4', 0.7)

      expect(mockWriteSplitPayoutLedgerEntries).not.toHaveBeenCalled()
    })

    it('split dispute refund failure → writeSplitRefundLedgerEntry not called', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: false,
      })

      await releaseEscrowWorkflow(JOB_ID, 'dispute-n5', 0.7)

      expect(mockWriteSplitRefundLedgerEntry).not.toHaveBeenCalled()
    })

    it('successful split settlement → refund entry written before bridge, payout after', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: true,
      })
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-n6', 0.7)

      expect(mockWriteSplitRefundLedgerEntry).toHaveBeenCalledTimes(1)
      expect(mockWriteSplitPayoutLedgerEntries).toHaveBeenCalledTimes(1)
    })

    it('bridge-retry after initial bridge failure → payout written once, refund not double-written', async () => {
      // Simulate retry: payment already 'released', refund was confirmed on first attempt
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockAttemptSplitRefundRetry.mockResolvedValue(true)
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-n7', 0.7)

      // Refund ledger: called once (idempotent guard handles duplicate in real impl)
      expect(mockWriteSplitRefundLedgerEntry).toHaveBeenCalledTimes(1)
      // Payout ledger: called once after bridge confirms
      expect(mockWriteSplitPayoutLedgerEntries).toHaveBeenCalledTimes(1)
    })
  })

  // ── O. Non-split dispute ledger publication gates ──────────────────────────
  //
  // Verifies that final_paid / platform_fee / dispute_resolved_release are never
  // recorded before the tranche bridge succeeds for non-split dispute releases.

  describe('O. Non-split dispute ledger publication gates', () => {
    it('non-split dispute bridge failure → writeNonSplitDisputePayoutLedgerEntries not called', async () => {
      // Unhydrated → corridor fail-closed → bridge skipped → bridgeFullySucceeded=false
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(false)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-o1')

      expect(mockWriteNonSplitDisputePayoutLedgerEntries).not.toHaveBeenCalled()
    })

    it('non-split dispute bridge success → writeNonSplitDisputePayoutLedgerEntries called once', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: true,
      })
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-o2')

      expect(mockWriteNonSplitDisputePayoutLedgerEntries).toHaveBeenCalledTimes(1)
    })

    it('non-split dispute bridge-retry success → writeNonSplitDisputePayoutLedgerEntries called once', async () => {
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'released'))
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-o3')

      expect(mockWriteNonSplitDisputePayoutLedgerEntries).toHaveBeenCalledTimes(1)
      // Split payout entries must NOT be called for a non-split dispute
      expect(mockWriteSplitPayoutLedgerEntries).not.toHaveBeenCalled()
    })

    it('split dispute behavior unchanged: writeSplitPayoutLedgerEntries used, not writeNonSplitDispute', async () => {
      mockReleaseEscrowPayment.mockResolvedValue({
        payment: makePayment(JOB_ID, 'released'),
        splitRefundSucceeded: true,
      })
      mockIsEscrowPlanRepositoryHydrated.mockReturnValue(true)

      await releaseEscrowWorkflow(JOB_ID, 'dispute-o4', 0.7)

      expect(mockWriteSplitPayoutLedgerEntries).toHaveBeenCalledTimes(1)
      expect(mockWriteNonSplitDisputePayoutLedgerEntries).not.toHaveBeenCalled()
    })
  })

  // ── P. Refund side-effect gate: no duplicate analytics on already-refunded retries ──

  describe('P. refundEscrowWorkflow: side effects suppressed on already-refunded retry', () => {
    it('already-refunded retry → runPaymentRefundedSideEffects not called', async () => {
      // isAlreadyRefunded=true: Stripe + DB committed on a prior attempt
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'refunded'))
      mockGetJobById.mockImplementation((jobId: string) => ({
        id: jobId, title: 'Test Job', status: 'completed',
        paymentState: 'refunded', paymentReleasedAt: undefined,
        craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', projectId: undefined,
      }))

      await refundEscrowWorkflow(JOB_ID)

      expect(mockRunPaymentRefundedSideEffects).not.toHaveBeenCalled()
    })

    it('first-time refund → runPaymentRefundedSideEffects called exactly once', async () => {
      // Default: payment in release_pending → not yet refunded
      mockGetPaymentForJob.mockReturnValue(makePayment(JOB_ID, 'release_pending'))
      mockRefundEscrowPayment.mockResolvedValue(makePayment(JOB_ID, 'refunded'))

      await refundEscrowWorkflow(JOB_ID)

      expect(mockRunPaymentRefundedSideEffects).toHaveBeenCalledTimes(1)
    })
  })
})
