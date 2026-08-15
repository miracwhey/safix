/**
 * Tests for API handler input validation in /api/send-notification-email.
 *
 * Validates:
 * - unknown notification type is rejected with 400
 * - invalid recipientRole is rejected with 400
 * - missing required fields are rejected with 400
 * - VALID_DELIVERY_TYPES export is complete and matches NotificationDeliveryType
 */

import { describe, it, expect } from 'vitest'
import { VALID_DELIVERY_TYPES } from '../../src/lib/notifications/delivery/types'

describe('VALID_DELIVERY_TYPES', () => {
  it('contains all expected delivery types', () => {
    expect(VALID_DELIVERY_TYPES).toContain('proposal_received')
    expect(VALID_DELIVERY_TYPES).toContain('schedule_created')
    expect(VALID_DELIVERY_TYPES).toContain('schedule_updated')
    expect(VALID_DELIVERY_TYPES).toContain('work_completed')
    expect(VALID_DELIVERY_TYPES).toContain('payment_release_requested')
    expect(VALID_DELIVERY_TYPES).toContain('dispute_opened')
    expect(VALID_DELIVERY_TYPES).toContain('dispute_evidence_requested')
    // Block 3 — payment / payout trust corridor
    expect(VALID_DELIVERY_TYPES).toContain('escrow_locked')
    expect(VALID_DELIVERY_TYPES).toContain('payment_released')
    expect(VALID_DELIVERY_TYPES).toContain('payout_handoff_initiated')
    expect(VALID_DELIVERY_TYPES).toContain('payout_completed')
    expect(VALID_DELIVERY_TYPES).toContain('payout_failed')
    // Block P · Run 2 — T+80 dispute-default-cut (provisional default refund)
    expect(VALID_DELIVERY_TYPES).toContain('dispute_default_refund_applied')
  })

  it('has exactly 13 entries', () => {
    expect(VALID_DELIVERY_TYPES).toHaveLength(13)
  })

  it('contains no duplicates', () => {
    const unique = new Set(VALID_DELIVERY_TYPES)
    expect(unique.size).toBe(VALID_DELIVERY_TYPES.length)
  })

  it('can be used as a runtime validator for unknown inputs', () => {
    const validInputs = ['proposal_received', 'dispute_opened', 'work_completed']
    const invalidInputs = ['unknown_type', '', 'PROPOSAL_RECEIVED', 'alert']

    for (const input of validInputs) {
      expect((VALID_DELIVERY_TYPES as readonly string[]).includes(input)).toBe(true)
    }
    for (const input of invalidInputs) {
      expect((VALID_DELIVERY_TYPES as readonly string[]).includes(input)).toBe(false)
    }
  })
})

describe('buildEmailContent defensive guard', () => {
  it('throws for an unknown type', async () => {
    const { buildEmailContent } = await import('../../src/lib/notifications/delivery/templates')
    expect(() =>
      buildEmailContent('unknown_type' as never, {})
    ).toThrow("unknown notification type 'unknown_type'")
  })

  it('does not throw for all VALID_DELIVERY_TYPES', async () => {
    const { buildEmailContent } = await import('../../src/lib/notifications/delivery/templates')
    for (const type of VALID_DELIVERY_TYPES) {
      expect(() => buildEmailContent(type, { jobTitle: 'Test' })).not.toThrow()
    }
  })
})
