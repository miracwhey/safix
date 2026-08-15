/**
 * Block 7.1D — payout_failed Notification Bridge Delivery
 *
 * Verifies the end-to-end visibility contract:
 *   1. A `payout_failed` timeline signal added to the timeline repository
 *      MUST result in a `payout_failed` notification signal for the
 *      craftsman with `priority='alert'`.
 *   2. No customer-side notification is produced (admin-only signals are
 *      filtered out by the bridge as they are delivered via a separate
 *      channel).
 *   3. The aggregated `derivePayoutFailureAlert` selector consumes that
 *      bridged signal and reports `hasPayoutFailure=true` with the
 *      canonical action route.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { setNotificationRepository } from '../../src/lib/notifications/repository'
import { setTimelineRepository } from '../../src/lib/timeline/repository'
import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import {
  startNotificationBridge,
  stopNotificationBridge,
} from '../../src/lib/notifications/notificationBridge'
import { getNotificationSignals } from '../../src/lib/notifications/notificationStore'
import {
  derivePayoutFailureAlert,
  PAYOUT_FAILURE_ACTION_ROUTE,
} from '../../src/lib/payments/payoutFailureAlert'
import type { ProjectTimelineSignal } from '../../src/lib/timeline/types'

function makePayoutFailedSignal(id: string, jobId = 'job-1'): ProjectTimelineSignal {
  return {
    id,
    jobId,
    type: 'payout_failed',
    occurredAt: 1_700_000_000_000,
  } as ProjectTimelineSignal
}

describe('payout_failed bridge delivery', () => {
  let timelineRepo: InMemoryTimelineRepository
  let notificationRepo: InMemoryNotificationRepository

  beforeEach(() => {
    stopNotificationBridge()
    timelineRepo = new InMemoryTimelineRepository()
    notificationRepo = new InMemoryNotificationRepository()
    setTimelineRepository(timelineRepo)
    setNotificationRepository(notificationRepo)
  })

  afterEach(() => {
    stopNotificationBridge()
  })

  it('produces a craftsman notification signal with alert priority', () => {
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_a'))

    startNotificationBridge()

    const signals = getNotificationSignals()
    const craftsmanSignals = signals.filter(
      (s) => s.type === 'payout_failed' && s.recipientRole === 'craftsman',
    )
    expect(craftsmanSignals).toHaveLength(1)
    expect(craftsmanSignals[0].priority).toBe('alert')
    expect(craftsmanSignals[0].jobId).toBe('job-1')
  })

  it('does not produce a customer-facing payout_failed signal', () => {
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_b'))

    startNotificationBridge()

    const customerSignals = getNotificationSignals().filter(
      (s) => s.type === 'payout_failed' && s.recipientRole === 'customer',
    )
    expect(customerSignals).toHaveLength(0)
  })

  it('feeds the payout-failure-alert selector with hasPayoutFailure=true', () => {
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_c', 'job-7'))

    startNotificationBridge()

    const alert = derivePayoutFailureAlert(getNotificationSignals())
    expect(alert.hasPayoutFailure).toBe(true)
    expect(alert.count).toBe(1)
    expect(alert.actionRoute).toBe(PAYOUT_FAILURE_ACTION_ROUTE)
  })

  it('aggregates multiple tranche-scoped payout_failed signals as count', () => {
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_x'))
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_y'))
    timelineRepo.add(makePayoutFailedSignal('timeline_payout_failed__tr_z'))

    startNotificationBridge()

    const alert = derivePayoutFailureAlert(getNotificationSignals())
    expect(alert.count).toBe(3)
    expect(alert.hasPayoutFailure).toBe(true)
  })
})
