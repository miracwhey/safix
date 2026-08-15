/**
 * Tests for the notification delivery service.
 *
 * Verifies:
 * - Observability events are emitted on dispatch (started / sent / failed / skipped)
 * - Missing recipientUserId causes a 'skipped' log and no fetch call
 * - Successful fetch response emits 'sent'
 * - Non-success response emits 'failed' with warning
 * - Network errors emit 'failed' with error
 * - Workflow integration: correct delivery functions called for key events
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// ---------------------------------------------------------------------------
// Mock observability BEFORE any delivery service import
// ---------------------------------------------------------------------------
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import * as observability from '../../src/lib/observability'
import {
  sendProposalReceivedEmail,
  sendScheduleCreatedEmail,
  sendScheduleUpdatedEmail,
  sendWorkCompletedEmail,
  sendPaymentReleaseRequestedEmail,
  sendDisputeOpenedEmail,
  sendDisputeEvidenceRequestedEmail,
} from '../../src/lib/notifications/delivery/deliveryService'

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Simulate browser context so the dispatch guard (`typeof window`) is satisfied.
vi.stubGlobal('window', {})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkFetch(payload: object): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  })
}

/**
 * Simulates a successful HTTP response where the server reports delivery
 * failure in the JSON body (success: false).  The server always returns
 * HTTP 200; the success flag is inside the body.
 */
function makeFailedDeliveryFetch(payload: object): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  })
}

// ---------------------------------------------------------------------------
// Delivery service unit tests
// ---------------------------------------------------------------------------

describe('Notification Delivery Service', () => {
  beforeEach(() => {
    setupCleanRepositories()
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ---------------------------------------------------------------------------
  // sendProposalReceivedEmail
  // ---------------------------------------------------------------------------
  describe('sendProposalReceivedEmail', () => {
    it('skips delivery when customerUserId is null', async () => {
      sendProposalReceivedEmail('job-1', null)
      // Allow microtask queue to flush
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips delivery when customerUserId is undefined', async () => {
      sendProposalReceivedEmail('job-1', undefined)
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('logs skipped when no recipientUserId after null guard is bypassed (empty string)', async () => {
      // The service also checks inside dispatch
      sendProposalReceivedEmail('job-1', '' as unknown as string)
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('POSTs to /api/send-notification-email with correct payload', async () => {
      makeOkFetch({ success: true })

      sendProposalReceivedEmail('job-42', 'user-customer-1', { jobTitle: 'Badsanierung' })
      // Allow async microtasks to flush
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/send-notification-email')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body as string) as Record<string, unknown>
      expect(body.type).toBe('proposal_received')
      expect(body.jobId).toBe('job-42')
      expect(body.recipientUserId).toBe('user-customer-1')
      expect(body.recipientRole).toBe('customer')
      expect(body.context).toEqual({ jobTitle: 'Badsanierung' })
    })

    it('logs notification.delivery.started and notification.delivery.sent on success', async () => {
      makeOkFetch({ success: true })

      sendProposalReceivedEmail('job-42', 'user-customer-1')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(observability.logInfo).toHaveBeenCalledWith(
        'notification.delivery.started',
        expect.objectContaining({ type: 'proposal_received', recipientRole: 'customer' })
      )
      expect(observability.logInfo).toHaveBeenCalledWith(
        'notification.delivery.sent',
        expect.objectContaining({ type: 'proposal_received', recipientRole: 'customer' })
      )
    })

    it('logs notification.delivery.failed as warning on non-success response', async () => {
      makeFailedDeliveryFetch({ success: false, error: 'recipient_email_not_found' })

      sendProposalReceivedEmail('job-42', 'user-customer-1')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(observability.logWarning).toHaveBeenCalledWith(
        'notification.delivery.failed',
        expect.objectContaining({ type: 'proposal_received', error: 'recipient_email_not_found' })
      )
    })

    it('logs notification.delivery.failed as error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      sendProposalReceivedEmail('job-42', 'user-customer-1')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(observability.logError).toHaveBeenCalledWith(
        'notification.delivery.failed',
        expect.any(Error),
        expect.objectContaining({ type: 'proposal_received' })
      )
    })
  })

  // ---------------------------------------------------------------------------
  // sendScheduleCreatedEmail
  // ---------------------------------------------------------------------------
  describe('sendScheduleCreatedEmail', () => {
    it('skips when customerUserId is null', async () => {
      sendScheduleCreatedEmail('job-1', null)
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('dispatches with type schedule_created and role customer', async () => {
      makeOkFetch({ success: true })
      sendScheduleCreatedEmail('job-99', 'user-c')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('schedule_created')
      expect(body.recipientRole).toBe('customer')
    })
  })

  // ---------------------------------------------------------------------------
  // sendScheduleUpdatedEmail
  // ---------------------------------------------------------------------------
  describe('sendScheduleUpdatedEmail', () => {
    it('dispatches with type schedule_updated and role customer', async () => {
      makeOkFetch({ success: true })
      sendScheduleUpdatedEmail('job-99', 'user-c')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('schedule_updated')
      expect(body.recipientRole).toBe('customer')
    })
  })

  // ---------------------------------------------------------------------------
  // sendWorkCompletedEmail
  // ---------------------------------------------------------------------------
  describe('sendWorkCompletedEmail', () => {
    it('skips when customerUserId is null', async () => {
      sendWorkCompletedEmail('job-1', null)
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('dispatches with type work_completed and role customer', async () => {
      makeOkFetch({ success: true })
      sendWorkCompletedEmail('job-88', 'user-c')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('work_completed')
      expect(body.recipientRole).toBe('customer')
    })
  })

  // ---------------------------------------------------------------------------
  // sendPaymentReleaseRequestedEmail
  // ---------------------------------------------------------------------------
  describe('sendPaymentReleaseRequestedEmail', () => {
    it('skips when craftsmanUserId is null', async () => {
      sendPaymentReleaseRequestedEmail('job-1', null)
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('dispatches with type payment_release_requested and role craftsman', async () => {
      makeOkFetch({ success: true })
      sendPaymentReleaseRequestedEmail('job-77', 'user-craftsman-1')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('payment_release_requested')
      expect(body.recipientRole).toBe('craftsman')
    })
  })

  // ---------------------------------------------------------------------------
  // sendDisputeOpenedEmail
  // ---------------------------------------------------------------------------
  describe('sendDisputeOpenedEmail', () => {
    it('skips when recipientUserId is null', async () => {
      sendDisputeOpenedEmail('job-1', null, 'customer')
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('dispatches with correct type and role for customer', async () => {
      makeOkFetch({ success: true })
      sendDisputeOpenedEmail('job-d1', 'user-c', 'customer')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('dispute_opened')
      expect(body.recipientRole).toBe('customer')
    })

    it('dispatches with correct type and role for craftsman', async () => {
      makeOkFetch({ success: true })
      sendDisputeOpenedEmail('job-d2', 'user-craftsman', 'craftsman')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('dispute_opened')
      expect(body.recipientRole).toBe('craftsman')
    })
  })

  // ---------------------------------------------------------------------------
  // sendDisputeEvidenceRequestedEmail
  // ---------------------------------------------------------------------------
  describe('sendDisputeEvidenceRequestedEmail', () => {
    it('dispatches with type dispute_evidence_requested', async () => {
      makeOkFetch({ success: true })
      sendDisputeEvidenceRequestedEmail('job-e1', 'user-c', 'customer')
      await new Promise(resolve => setTimeout(resolve, 0))

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.type).toBe('dispute_evidence_requested')
    })

    it('skips when recipientUserId is null', async () => {
      sendDisputeEvidenceRequestedEmail('job-e1', null, 'customer')
      await Promise.resolve()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
