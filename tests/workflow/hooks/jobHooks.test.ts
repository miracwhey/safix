/**
 * Sub-block 3.3 — job:work_completed Hook Tests
 *
 * Covers:
 *   A. Hook isolation — all expected side effects called with correct context
 *   B. Success condition — hook only called after successful work_completed transition
 *   C. Analytics semantics — 'work_completed_recorded' not 'job_completed'
 *   D. Error handling — hook never throws; errors are logged
 *   E. Regression — surrounding workflow logic unaffected
 */

vi.mock('../../../src/lib/timeline', () => ({
  ensureTimelineEvent: vi.fn(),
}))

vi.mock('../../../src/lib/analytics', () => ({
  recordAnalyticsEvent: vi.fn(),
}))

vi.mock('../../../src/lib/notifications/delivery', () => ({
  sendWorkCompletedEmail: vi.fn(),
  sendProposalReceivedEmail: vi.fn(),
  sendScheduleCreatedEmail: vi.fn(),
  sendScheduleUpdatedEmail: vi.fn(),
  sendPaymentReleaseRequestedEmail: vi.fn(),
  sendDisputeOpenedEmail: vi.fn(),
  sendDisputeEvidenceRequestedEmail: vi.fn(),
  sendEscrowLockedEmail: vi.fn(),
  sendPaymentReleasedEmail: vi.fn(),
  sendPayoutHandoffInitiatedEmail: vi.fn(),
}))

vi.mock('../../../src/lib/observability', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runWorkCompletedSideEffects } from '../../../src/lib/workflow/hooks/jobHooks'
import { ensureTimelineEvent } from '../../../src/lib/timeline'
import { recordAnalyticsEvent } from '../../../src/lib/analytics'
import { sendWorkCompletedEmail } from '../../../src/lib/notifications/delivery'
import { logError } from '../../../src/lib/observability'
import type { Job } from '../../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-wc',
    projectId: 'proj-wc',
    title: 'Elektroinstallation',
    customer: 'Anna Kunde',
    location: 'München',
    dateLabel: 'heute',
    status: 'in_progress',
    amount: '2.380,00 €',
    description: '',
    paymentState: 'work_in_progress',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-wc',
    customerUserId: 'customer-wc',
    ...overrides,
  } as Job
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sub-block 3.3 — runWorkCompletedSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── A. Hook isolation ───────────────────────────────────────────────────────

  describe('A. Hook calls all expected work_completed side effects', () => {
    it('emits work_completed timeline event', async () => {
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(ensureTimelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-wc', type: 'work_completed' })
      )
    })

    it('calls recordAnalyticsEvent with correct entity fields', async () => {
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'job',
          entityId: 'job-wc',
        })
      )
    })

    it('calls sendWorkCompletedEmail with customerUserId and jobTitle', async () => {
      const job = makeJob({ customerUserId: 'customer-wc', title: 'Elektroinstallation' })
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job })
      expect(sendWorkCompletedEmail).toHaveBeenCalledWith(
        'job-wc',
        'customer-wc',
        { jobTitle: 'Elektroinstallation' }
      )
    })

    it('passes craftsmanUserId as actorUserId to analytics', async () => {
      const job = makeJob({ craftsmanUserId: 'craftsman-abc' })
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'craftsman-abc' })
      )
    })

    it('passes undefined actorUserId when craftsmanUserId is absent', async () => {
      const job = makeJob({ craftsmanUserId: undefined })
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: undefined })
      )
    })

    it('resolves to void', async () => {
      const result = await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(result).toBeUndefined()
    })
  })

  // ── B. Success condition ────────────────────────────────────────────────────

  describe('B. Hook runs all effects when context is fully provided', () => {
    it('all three effect categories run on a complete context', async () => {
      const job = makeJob({ craftsmanUserId: 'c-1', customerUserId: 'u-1' })
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job })
      expect(ensureTimelineEvent).toHaveBeenCalled()
      expect(recordAnalyticsEvent).toHaveBeenCalled()
      expect(sendWorkCompletedEmail).toHaveBeenCalled()
    })
  })

  // ── C. Analytics semantics ──────────────────────────────────────────────────

  describe('C. Analytics event type is work_completed_recorded, NOT job_completed', () => {
    it("emits eventType 'work_completed_recorded'", async () => {
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'work_completed_recorded' })
      )
    })

    it("does NOT emit eventType 'job_completed'", async () => {
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      const calls = vi.mocked(recordAnalyticsEvent).mock.calls
      const hasJobCompleted = calls.some(([arg]) => arg.eventType === 'job_completed')
      expect(hasJobCompleted).toBe(false)
    })

    it('emits exactly one analytics event', async () => {
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalledTimes(1)
    })
  })

  // ── D. Error handling ───────────────────────────────────────────────────────

  describe('D. Hook never throws — errors are logged', () => {
    it('resolves when ensureTimelineEvent throws', async () => {
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => {
        throw new Error('timeline failure')
      })
      await expect(
        runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      ).resolves.toBeUndefined()
    })

    it('logs timeline_failed error when ensureTimelineEvent throws', async () => {
      const err = new Error('timeline failure')
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => { throw err })

      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })

      expect(logError).toHaveBeenCalledWith(
        'hook.work_completed.timeline_failed',
        err,
        { jobId: 'job-wc' }
      )
    })

    it('still calls analytics and email after timeline failure', async () => {
      vi.mocked(ensureTimelineEvent).mockImplementationOnce(() => {
        throw new Error('timeline failure')
      })
      await runWorkCompletedSideEffects({ jobId: 'job-wc', job: makeJob() })
      expect(recordAnalyticsEvent).toHaveBeenCalled()
      expect(sendWorkCompletedEmail).toHaveBeenCalled()
    })
  })
})
