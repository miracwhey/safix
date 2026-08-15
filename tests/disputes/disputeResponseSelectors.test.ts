import { describe, it, expect } from 'vitest'
import {
  DISPUTE_RESPONSE_DEADLINE_MS,
  canSubmitDisputeResponse,
  deriveDisputeResponseDeadline,
  describeDescriptionEvidenceAuthor,
  formatResponseDeadlineLabel,
  isDisputeResponseDeadlineUrgent,
  shouldShowWorkerResponseHint,
} from '../../src/lib/disputes/disputeResponseSelectors'
import type { Dispute, DisputeStatus } from '../../src/lib/disputes/types'
import type { Job } from '../../src/lib/jobs/types'

const FIXED_NOW = new Date('2026-05-02T10:00:00.000Z')

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-1',
    jobId: 'job-1',
    status: 'provider_waiting',
    reason: 'work_quality',
    title: 'Test',
    description: 'Test',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T08:00:00.000Z',
    ...overrides,
  } as Dispute
}

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Test job',
    description: '',
    status: 'in_progress',
    serviceCategory: 'tiles',
    customerName: 'Kunde',
    location: 'Ort',
    requestedDate: 'today',
    estimatedHours: 4,
    estimatedTotalAmount: 100,
    appointmentDate: undefined,
    completedAt: undefined,
    workCompletedAt: undefined,
    workMarkedCompleteAt: undefined,
    customerId: 'customer-1',
    customerUserId: 'user-customer',
    craftsmanUserId: 'user-owner',
    providerId: 'provider-1',
    assignedMemberIds: [],
    metadata: {},
    paymentState: 'in_escrow',
    contractAccepted: true,
    contractAcceptedAt: '2026-05-01T08:00:00.000Z',
    correctionRequestId: undefined,
    disputeStatus: 'provider_waiting',
    ...overrides,
  } as unknown as Job
}

describe('disputeResponseSelectors', () => {
  describe('deriveDisputeResponseDeadline', () => {
    it('returns +48h from updatedAt for provider_waiting', () => {
      const d = buildDispute({
        status: 'provider_waiting',
        updatedAt: '2026-05-02T08:00:00.000Z',
      })
      const deadline = deriveDisputeResponseDeadline(d)
      expect(deadline?.toISOString()).toBe('2026-05-04T08:00:00.000Z')
    })

    it('returns +48h from updatedAt for customer_waiting', () => {
      const d = buildDispute({
        status: 'customer_waiting',
        updatedAt: '2026-05-02T12:00:00.000Z',
      })
      const deadline = deriveDisputeResponseDeadline(d)
      expect(deadline?.toISOString()).toBe('2026-05-04T12:00:00.000Z')
    })

    it('returns null when status is open', () => {
      const d = buildDispute({ status: 'open' })
      expect(deriveDisputeResponseDeadline(d)).toBeNull()
    })

    it('returns null when status is under_review', () => {
      const d = buildDispute({ status: 'under_review' })
      expect(deriveDisputeResponseDeadline(d)).toBeNull()
    })

    it('returns null for terminal statuses', () => {
      for (const status of ['resolved', 'closed', 'cancelled'] as DisputeStatus[]) {
        const d = buildDispute({ status })
        expect(deriveDisputeResponseDeadline(d)).toBeNull()
      }
    })

    it('exposes the deadline window constant', () => {
      expect(DISPUTE_RESPONSE_DEADLINE_MS).toBe(48 * 60 * 60 * 1000)
    })
  })

  describe('formatResponseDeadlineLabel', () => {
    it('returns "in N Std" when more than 1 hour remains', () => {
      const deadline = new Date(FIXED_NOW.getTime() + 47 * 60 * 60 * 1000)
      expect(formatResponseDeadlineLabel(deadline, FIXED_NOW)).toBe('in 47 Std')
    })

    it('returns "in N Min" when less than 1 hour remains', () => {
      const deadline = new Date(FIXED_NOW.getTime() + 25 * 60 * 1000)
      expect(formatResponseDeadlineLabel(deadline, FIXED_NOW)).toBe('in 25 Min')
    })

    it('returns "weniger als 1 Min" when less than 60 seconds remain', () => {
      const deadline = new Date(FIXED_NOW.getTime() + 30 * 1000)
      expect(formatResponseDeadlineLabel(deadline, FIXED_NOW)).toBe(
        'weniger als 1 Min',
      )
    })

    it('returns "abgelaufen" when the deadline has passed', () => {
      const deadline = new Date(FIXED_NOW.getTime() - 1)
      expect(formatResponseDeadlineLabel(deadline, FIXED_NOW)).toBe('abgelaufen')
    })

    it('returns "abgelaufen" when deadline equals now', () => {
      expect(formatResponseDeadlineLabel(FIXED_NOW, FIXED_NOW)).toBe('abgelaufen')
    })
  })

  describe('isDisputeResponseDeadlineUrgent', () => {
    it('flags <24h as urgent', () => {
      const deadline = new Date(FIXED_NOW.getTime() + 4 * 60 * 60 * 1000)
      expect(isDisputeResponseDeadlineUrgent(deadline, FIXED_NOW)).toBe(true)
    })

    it('does not flag >=24h as urgent', () => {
      const deadline = new Date(FIXED_NOW.getTime() + 25 * 60 * 60 * 1000)
      expect(isDisputeResponseDeadlineUrgent(deadline, FIXED_NOW)).toBe(false)
    })

    it('does not flag expired deadlines as urgent', () => {
      const deadline = new Date(FIXED_NOW.getTime() - 5 * 60 * 1000)
      expect(isDisputeResponseDeadlineUrgent(deadline, FIXED_NOW)).toBe(false)
    })
  })

  describe('canSubmitDisputeResponse', () => {
    const ownerSession = {
      userId: 'user-owner',
      role: 'craftsman' as const,
      craftsmanRole: 'owner' as const,
    }
    const customerSession = {
      userId: 'user-customer',
      role: 'customer' as const,
      craftsmanRole: null,
    }
    const workerSession = {
      userId: 'user-worker',
      role: 'craftsman' as const,
      craftsmanRole: 'worker' as const,
    }

    it('allows owner on provider_waiting', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: ownerSession,
          job: buildJob(),
        }),
      ).toBe(true)
    })

    it('allows customer on customer_waiting', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'customer_waiting' }),
          session: customerSession,
          job: buildJob(),
        }),
      ).toBe(true)
    })

    it('blocks worker on provider_waiting', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: workerSession,
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks owner when status is under_review', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'under_review' }),
          session: ownerSession,
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks owner on customer_waiting (cross-side)', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'customer_waiting' }),
          session: ownerSession,
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks customer on provider_waiting (cross-side)', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: customerSession,
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks foreign owner whose userId does not match job.craftsmanUserId', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: { ...ownerSession, userId: 'someone-else' },
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks foreign customer whose userId does not match job.customerUserId', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'customer_waiting' }),
          session: { ...customerSession, userId: 'someone-else' },
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('blocks for terminal disputes', () => {
      for (const status of [
        'resolved',
        'closed',
        'cancelled',
      ] as DisputeStatus[]) {
        expect(
          canSubmitDisputeResponse({
            dispute: buildDispute({ status }),
            session: ownerSession,
            job: buildJob(),
          }),
        ).toBe(false)
      }
    })

    it('blocks when session has no userId', () => {
      expect(
        canSubmitDisputeResponse({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: { userId: '', role: 'craftsman', craftsmanRole: 'owner' },
          job: buildJob(),
        }),
      ).toBe(false)
    })
  })

  describe('shouldShowWorkerResponseHint', () => {
    const workerSession = {
      userId: 'user-worker',
      role: 'craftsman' as const,
      craftsmanRole: 'worker' as const,
    }

    it('shows hint for craftsman worker on provider_waiting', () => {
      expect(
        shouldShowWorkerResponseHint({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: workerSession,
          job: buildJob(),
        }),
      ).toBe(true)
    })

    it('does not show hint when status is customer_waiting', () => {
      expect(
        shouldShowWorkerResponseHint({
          dispute: buildDispute({ status: 'customer_waiting' }),
          session: workerSession,
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('does not show hint for owner', () => {
      expect(
        shouldShowWorkerResponseHint({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: {
            userId: 'user-owner',
            role: 'craftsman',
            craftsmanRole: 'owner',
          },
          job: buildJob(),
        }),
      ).toBe(false)
    })

    it('does not show hint for customer', () => {
      expect(
        shouldShowWorkerResponseHint({
          dispute: buildDispute({ status: 'provider_waiting' }),
          session: {
            userId: 'user-customer',
            role: 'customer',
            craftsmanRole: null,
          },
          job: buildJob(),
        }),
      ).toBe(false)
    })
  })

  describe('describeDescriptionEvidenceAuthor', () => {
    const job = buildJob()
    it('returns Inhaber when submittedBy === craftsmanUserId', () => {
      expect(
        describeDescriptionEvidenceAuthor({
          evidenceSubmittedBy: 'user-owner',
          job,
        }),
      ).toBe('Inhaber')
    })

    it('returns Kunde when submittedBy === customerUserId', () => {
      expect(
        describeDescriptionEvidenceAuthor({
          evidenceSubmittedBy: 'user-customer',
          job,
        }),
      ).toBe('Kunde')
    })

    it('returns SaFix when isOperatorEvidence flag set', () => {
      expect(
        describeDescriptionEvidenceAuthor({
          evidenceSubmittedBy: 'operator-1',
          job,
          isOperatorEvidence: true,
        }),
      ).toBe('SaFix')
    })

    it('falls back to Inhaber for unknown submitter (legacy data)', () => {
      expect(
        describeDescriptionEvidenceAuthor({
          evidenceSubmittedBy: 'someone-else',
          job,
        }),
      ).toBe('Inhaber')
    })
  })
})
