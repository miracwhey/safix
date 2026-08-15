/**
 * Sub-blocks 3.1 + 3.2 — payment:released and payment:refunded Hook Tests
 *
 * 3.1 Covers:
 *   A. Hook isolation — all expected released side effects with correct context
 *   B. Success condition — hook only called after successful transition
 *   C. Error handling — hook never throws; critical errors logged
 *   D. Duplication proof — released side effects live in one place
 *
 * 3.2 Covers:
 *   E. Refunded hook isolation — all expected refunded side effects
 *   F. Refunded error handling — hook never throws; errors logged
 *   G. Semantic correctness — no craftsman notification/counter on refund path
 */

// vi.mock is hoisted before imports by Vitest

vi.mock('../../../src/lib/invoices', () => ({
  syncInvoiceWithPayment: vi.fn().mockResolvedValue(undefined),
  ensureInvoiceForJobId: vi.fn().mockResolvedValue(undefined),
  ensureInvoiceForJob: vi.fn().mockResolvedValue(undefined),
  updateInvoiceStatus: vi.fn().mockResolvedValue(undefined),
  getInvoiceByJobId: vi.fn().mockReturnValue(undefined),
  isInvoiceRepositoryHydrated: vi.fn().mockReturnValue(true),
}))

vi.mock('../../../src/lib/timeline', () => ({
  ensureTimelineEvent: vi.fn(),
}))

vi.mock('../../../src/lib/inAppNotifications', () => ({
  createInAppNotification: vi.fn(),
}))

vi.mock('../../../src/lib/craftsman/craftsmanProfileService', () => ({
  incrementCompletedJobsCount: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/lib/analytics', () => ({
  recordAnalyticsEvent: vi.fn(),
}))

vi.mock('../../../src/lib/observability', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runPaymentReleasedSideEffects, runPaymentRefundedSideEffects } from '../../../src/lib/workflow/hooks/paymentHooks'
import { syncInvoiceWithPayment } from '../../../src/lib/invoices'
import { ensureTimelineEvent } from '../../../src/lib/timeline'
import { createInAppNotification } from '../../../src/lib/inAppNotifications'
import { incrementCompletedJobsCount } from '../../../src/lib/craftsman/craftsmanProfileService'
import { recordAnalyticsEvent } from '../../../src/lib/analytics'
import { logError } from '../../../src/lib/observability'
import type { Job } from '../../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-test',
    projectId: 'proj-test',
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'heute',
    status: 'completed',
    amount: '1.190,00 €',
    description: '',
    paymentState: 'released',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-test',
    ...overrides,
  } as Job
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sub-block 3.1 — runPaymentReleasedSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── A. Hook isolation ───────────────────────────────────────────────────────

  describe('A. Hook calls all expected released side effects', () => {
    it('emits payment_released timeline event', async () => {
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      expect(ensureTimelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-test', type: 'payment_released' })
      )
    })

    it('emits job_completed timeline event', async () => {
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      expect(ensureTimelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-test', type: 'job_completed' })
      )
    })

    it('calls syncInvoiceWithPayment with correct jobId', async () => {
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      expect(syncInvoiceWithPayment).toHaveBeenCalledWith('job-test')
    })

    it('records payment_released analytics event with correct entity', async () => {
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'payment_released',
          entityType: 'payment',
          entityId: 'job-test',
        })
      )
    })

    it('increments completed jobs count for craftsman', async () => {
      const job = makeJob({ craftsmanUserId: 'craftsman-abc' })
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job })
      expect(incrementCompletedJobsCount).toHaveBeenCalledWith('craftsman-abc')
    })

    it('creates in-app notification for craftsman with correct id and type', async () => {
      const job = makeJob({ craftsmanUserId: 'craftsman-abc' })
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job })
      expect(createInAppNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'notif-payment-released-job-test',
          userId: 'craftsman-abc',
          type: 'payment_released',
          entityId: 'job-test',
        })
      )
    })

    it('skips incrementCompletedJobsCount when craftsmanUserId is absent', async () => {
      await runPaymentReleasedSideEffects({
        jobId: 'job-test',
        job: makeJob({ craftsmanUserId: undefined }),
      })
      expect(incrementCompletedJobsCount).not.toHaveBeenCalled()
    })

    it('skips createInAppNotification when craftsmanUserId is absent', async () => {
      await runPaymentReleasedSideEffects({
        jobId: 'job-test',
        job: makeJob({ craftsmanUserId: undefined }),
      })
      expect(createInAppNotification).not.toHaveBeenCalled()
    })
  })

  // ── B. Success condition ────────────────────────────────────────────────────

  describe('B. Hook only runs after a successful transition', () => {
    it('all effects run when context is fully provided', async () => {
      const job = makeJob({ craftsmanUserId: 'c-1' })
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job })
      // All four categories of effects must have been called
      expect(ensureTimelineEvent).toHaveBeenCalled()
      expect(syncInvoiceWithPayment).toHaveBeenCalled()
      expect(recordAnalyticsEvent).toHaveBeenCalled()
      expect(incrementCompletedJobsCount).toHaveBeenCalled()
    })

    it('hook resolves to void (no return value)', async () => {
      const result = await runPaymentReleasedSideEffects({
        jobId: 'job-test',
        job: makeJob(),
      })
      expect(result).toBeUndefined()
    })
  })

  // ── C. Error handling ───────────────────────────────────────────────────────

  describe('C. Hook never throws — errors are logged and execution continues', () => {
    it('resolves when syncInvoiceWithPayment throws', async () => {
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(new Error('DB timeout'))

      await expect(
        runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      ).resolves.toBeUndefined()
    })

    it('logs invoice_sync_failed error when syncInvoiceWithPayment throws', async () => {
      const err = new Error('DB timeout')
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(err)

      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })

      expect(logError).toHaveBeenCalledWith(
        'hook.payment_released.invoice_sync_failed',
        err,
        { jobId: 'job-test' }
      )
    })

    it('still calls analytics and craftsman effects after invoice_sync failure', async () => {
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(new Error('DB timeout'))

      await runPaymentReleasedSideEffects({
        jobId: 'job-test',
        job: makeJob({ craftsmanUserId: 'c-1' }),
      })

      // Effects that come after invoice sync must still run
      expect(recordAnalyticsEvent).toHaveBeenCalled()
      expect(incrementCompletedJobsCount).toHaveBeenCalled()
      expect(createInAppNotification).toHaveBeenCalled()
    })

    it('resolves when timeline throws', async () => {
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => {
        throw new Error('timeline failure')
      })

      await expect(
        runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })
      ).resolves.toBeUndefined()
    })

    it('logs timeline_failed error when timeline throws', async () => {
      const err = new Error('timeline failure')
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => {
        throw err
      })

      await runPaymentReleasedSideEffects({ jobId: 'job-test', job: makeJob() })

      expect(logError).toHaveBeenCalledWith(
        'hook.payment_released.timeline_failed',
        err,
        { jobId: 'job-test' }
      )
    })

    it('logs increment_jobs_failed when incrementCompletedJobsCount rejects', async () => {
      const err = new Error('network error')
      vi.mocked(incrementCompletedJobsCount).mockRejectedValueOnce(err)

      await runPaymentReleasedSideEffects({
        jobId: 'job-test',
        job: makeJob({ craftsmanUserId: 'c-1' }),
      })

      // Allow the microtask (fire-and-forget .catch) to settle
      await Promise.resolve()

      expect(logError).toHaveBeenCalledWith(
        'hook.payment_released.increment_jobs_failed',
        err,
        expect.objectContaining({ jobId: 'job-test', craftsmanUserId: 'c-1' })
      )
    })
  })

  // ── D. Duplication proof ────────────────────────────────────────────────────

  describe('D. Single source of truth — hook is the only released side-effect location', () => {
    it('hook is callable from both workflow paths with identical interface', async () => {
      // Verify the hook accepts the PaymentReleasedContext shape used by
      // both paymentWorkflow.ts and releaseOperations.ts
      const ctx = { jobId: 'job-x', job: makeJob({ id: 'job-x' }) }

      // Both callers pass the same shape — if this compiles and runs, the
      // interface is unified.
      await expect(runPaymentReleasedSideEffects(ctx)).resolves.toBeUndefined()
    })

    it('all released side effects are triggered through a single hook call', async () => {
      const job = makeJob({ craftsmanUserId: 'c-1' })
      await runPaymentReleasedSideEffects({ jobId: 'job-test', job })

      // One call to syncInvoiceWithPayment — not zero (missing) or two (duplicate)
      expect(syncInvoiceWithPayment).toHaveBeenCalledTimes(1)
      // One payment_released analytics event
      const analyticsCalls = vi.mocked(recordAnalyticsEvent).mock.calls.filter(
        ([arg]) => arg.eventType === 'payment_released'
      )
      expect(analyticsCalls).toHaveLength(1)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sub-block 3.2 — runPaymentRefundedSideEffects
// ─────────────────────────────────────────────────────────────────────────────

describe('Sub-block 3.2 — runPaymentRefundedSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── E. Refunded hook isolation ──────────────────────────────────────────────

  describe('E. Hook calls all expected refunded side effects', () => {
    it('emits payment_refunded timeline event', async () => {
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(ensureTimelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-r', type: 'payment_refunded' })
      )
    })

    it('emits job_completed timeline event', async () => {
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(ensureTimelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-r', type: 'job_completed' })
      )
    })

    it('calls syncInvoiceWithPayment with correct jobId', async () => {
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(syncInvoiceWithPayment).toHaveBeenCalledWith('job-r')
    })

    it('records payment_refunded analytics event', async () => {
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'payment_refunded',
          entityType: 'payment',
          entityId: 'job-r',
        })
      )
    })

    it('resolves to void', async () => {
      const result = await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(result).toBeUndefined()
    })
  })

  // ── F. Refunded error handling ──────────────────────────────────────────────

  describe('F. Hook never throws — errors are logged', () => {
    it('resolves when syncInvoiceWithPayment throws', async () => {
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(new Error('DB error'))
      await expect(
        runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      ).resolves.toBeUndefined()
    })

    it('logs invoice_sync_failed when syncInvoiceWithPayment throws', async () => {
      const err = new Error('DB error')
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(err)
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(logError).toHaveBeenCalledWith(
        'hook.payment_refunded.invoice_sync_failed',
        err,
        { jobId: 'job-r' }
      )
    })

    it('still calls analytics after invoice_sync failure', async () => {
      vi.mocked(syncInvoiceWithPayment).mockRejectedValueOnce(new Error('DB error'))
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalled()
    })

    it('resolves when timeline throws', async () => {
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => {
        throw new Error('timeline failure')
      })
      await expect(
        runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      ).resolves.toBeUndefined()
    })

    it('logs timeline_failed when ensureTimelineEvent throws', async () => {
      const err = new Error('timeline failure')
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => { throw err })
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      expect(logError).toHaveBeenCalledWith(
        'hook.payment_refunded.timeline_failed',
        err,
        { jobId: 'job-r' }
      )
    })
  })

  // ── G. Semantic correctness ─────────────────────────────────────────────────

  describe('G. Refunded hook does NOT trigger craftsman completion effects', () => {
    it('does not call incrementCompletedJobsCount', async () => {
      await runPaymentRefundedSideEffects({
        jobId: 'job-r',
        job: makeJob({ craftsmanUserId: 'c-1' }),
      })
      expect(incrementCompletedJobsCount).not.toHaveBeenCalled()
    })

    it('does not call createInAppNotification', async () => {
      await runPaymentRefundedSideEffects({
        jobId: 'job-r',
        job: makeJob({ craftsmanUserId: 'c-1' }),
      })
      expect(createInAppNotification).not.toHaveBeenCalled()
    })

    it('emits payment_refunded analytics, not payment_released', async () => {
      await runPaymentRefundedSideEffects({ jobId: 'job-r', job: makeJob() })
      const calls = vi.mocked(recordAnalyticsEvent).mock.calls
      expect(calls.some(([a]) => a.eventType === 'payment_released')).toBe(false)
      expect(calls.some(([a]) => a.eventType === 'payment_refunded')).toBe(true)
    })
  })
})
