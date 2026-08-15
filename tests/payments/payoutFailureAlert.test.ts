/**
 * Block 7.1D — Payout Failure Alert Selector
 *
 * Verifies that `derivePayoutFailureAlert` correctly aggregates craftsman-
 * scoped, unread `payout_failed` notification signals into a UI-ready alert.
 */

import { describe, it, expect } from 'vitest'

import {
  derivePayoutFailureAlert,
  getEmptyPayoutFailureAlert,
  PAYOUT_FAILURE_ACTION_ROUTE,
} from '../../src/lib/payments/payoutFailureAlert'
import type { NotificationSignal } from '../../src/lib/notifications/types'

function makeSignal(overrides: Partial<NotificationSignal> = {}): NotificationSignal {
  return {
    id: 'notif-payout-1',
    jobId: 'job-1',
    type: 'payout_failed',
    priority: 'alert',
    read: false,
    occurredAt: 1_700_000_000_000,
    recipientRole: 'craftsman',
    ...overrides,
  }
}

describe('derivePayoutFailureAlert', () => {
  it('returns empty alert when no signals are provided', () => {
    const alert = derivePayoutFailureAlert([])
    expect(alert.hasPayoutFailure).toBe(false)
    expect(alert.count).toBe(0)
    expect(alert.latestFailureAt).toBeNull()
    expect(alert.actionRoute).toBe(PAYOUT_FAILURE_ACTION_ROUTE)
  })

  it('returns alert when one craftsman payout_failed signal exists', () => {
    const alert = derivePayoutFailureAlert([makeSignal()])
    expect(alert.hasPayoutFailure).toBe(true)
    expect(alert.count).toBe(1)
    expect(alert.latestFailureAt).toBe(1_700_000_000_000)
    expect(alert.actionRoute).toBe('/craftsman/profile/tax-bank')
    expect(alert.ctaLabel).toBe('Bankdaten prüfen')
    expect(alert.title).toBe('Auszahlung fehlgeschlagen')
    expect(alert.description).toContain('Bankdaten')
  })

  it('aggregates multiple craftsman payout_failed signals', () => {
    const alert = derivePayoutFailureAlert([
      makeSignal({ id: 'a', occurredAt: 1_000 }),
      makeSignal({ id: 'b', occurredAt: 5_000 }),
      makeSignal({ id: 'c', occurredAt: 3_000 }),
    ])
    expect(alert.count).toBe(3)
    expect(alert.latestFailureAt).toBe(5_000)
  })

  it('ignores read signals', () => {
    const alert = derivePayoutFailureAlert([
      makeSignal({ id: 'a', read: true }),
      makeSignal({ id: 'b', read: true }),
    ])
    expect(alert.hasPayoutFailure).toBe(false)
    expect(alert.count).toBe(0)
  })

  it('ignores customer-recipient signals', () => {
    const alert = derivePayoutFailureAlert([
      makeSignal({ id: 'a', recipientRole: 'customer' }),
    ])
    expect(alert.hasPayoutFailure).toBe(false)
  })

  it('ignores non-payout_failed signals', () => {
    const alert = derivePayoutFailureAlert([
      makeSignal({ id: 'a', type: 'payout_completed' }),
      makeSignal({ id: 'b', type: 'invoice_issued' }),
      makeSignal({ id: 'c', type: 'dispute_opened' }),
    ])
    expect(alert.hasPayoutFailure).toBe(false)
  })

  it('mixes valid signals with noise correctly', () => {
    const alert = derivePayoutFailureAlert([
      makeSignal({ id: 'noise-1', read: true }),
      makeSignal({ id: 'noise-2', recipientRole: 'customer' }),
      makeSignal({ id: 'noise-3', type: 'payout_completed' }),
      makeSignal({ id: 'real-1', occurredAt: 100 }),
      makeSignal({ id: 'real-2', occurredAt: 200 }),
    ])
    expect(alert.count).toBe(2)
    expect(alert.latestFailureAt).toBe(200)
  })

  it('getEmptyPayoutFailureAlert mirrors derivePayoutFailureAlert([]) shape', () => {
    expect(getEmptyPayoutFailureAlert()).toEqual(derivePayoutFailureAlert([]))
  })
})
