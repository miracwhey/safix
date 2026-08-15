import { describe, it, expect, beforeEach } from 'vitest'

import {
  dispatchPushAction,
  __testOnly_resetIdempotency,
  type DispatcherSession,
  type PushActionData,
} from '../../src/lib/notifications/pushActionDispatcher'
import { PUSH_ROUTE_SCHEMA_VERSION } from '../../src/lib/notifications/pushRoutes'

const NOW = 1_746_374_400_000 // 2026-05-04T12:00:00Z

const ownerSession: DispatcherSession = {
  userId: 'u-owner-1',
  role: 'craftsman',
  craftsmanRole: 'owner',
}

const workerSession: DispatcherSession = {
  userId: 'u-worker-1',
  role: 'craftsman',
  craftsmanRole: 'worker',
}

const customerSession: DispatcherSession = {
  userId: 'u-customer-1',
  role: 'customer',
  craftsmanRole: null,
}

function validData(overrides: Partial<PushActionData> = {}): PushActionData {
  return {
    route: '/craftsman/jobs/job-42',
    fallbackRoute: '/craftsman/korrekturen',
    actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
    expiresAt: NOW + 60_000,
    actionType: 'correction.submitted',
    entityType: 'correction',
    entityId: 'c-123',
    categoryId: 'CORRECTION_DECISION',
    roleTarget: 'craftsman',
    craftsmanRoleTarget: 'owner',
    expectedStatus: 'pending',
    requiresConfirmation: true,
    createdAt: NOW - 30_000,
    ...overrides,
  }
}

beforeEach(() => {
  __testOnly_resetIdempotency()
})

describe('Block A2 · pushActionDispatcher — happy paths', () => {
  it('returns navigate_with_sheet=approve_confirm for valid APPROVE tap', () => {
    const result = dispatchPushAction(
      { actionId: 'APPROVE', data: validData(), session: ownerSession },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'navigate_with_sheet',
      path: '/craftsman/jobs/job-42',
      search: '?action=approve',
      sheet: 'approve_confirm',
    })
  })

  it('returns navigate_with_sheet=reject_reason for valid REJECT tap', () => {
    const result = dispatchPushAction(
      { actionId: 'REJECT', data: validData(), session: ownerSession },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'navigate_with_sheet',
      path: '/craftsman/jobs/job-42',
      search: '?action=reject',
      sheet: 'reject_reason',
    })
  })

  it('appends action= to existing query string instead of overwriting', () => {
    const result = dispatchPushAction(
      {
        actionId: 'APPROVE',
        data: validData({ route: '/craftsman/jobs/job-42?focus=timeline' }),
        session: ownerSession,
      },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'navigate_with_sheet',
      path: '/craftsman/jobs/job-42',
      search: '?focus=timeline&action=approve',
      sheet: 'approve_confirm',
    })
  })
})

describe('Block A2 · pushActionDispatcher — fallback paths', () => {
  it('returns fallback expired when expiresAt is in the past', () => {
    const result = dispatchPushAction(
      {
        actionId: 'APPROVE',
        data: validData({ expiresAt: NOW - 1 }),
        session: ownerSession,
      },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'fallback',
      reason: 'expired',
      fallbackRoute: '/craftsman/korrekturen',
    })
  })

  it('returns fallback unknown_version when actionVersion mismatches', () => {
    const result = dispatchPushAction(
      {
        actionId: 'APPROVE',
        data: validData({ actionVersion: 999 }),
        session: ownerSession,
      },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'fallback',
      reason: 'unknown_version',
      fallbackRoute: '/craftsman/korrekturen',
    })
  })

  it('returns fallback role_mismatch when session.role differs from roleTarget', () => {
    const result = dispatchPushAction(
      { actionId: 'APPROVE', data: validData(), session: customerSession },
      { now: NOW },
    )
    expect(result).toMatchObject({ kind: 'fallback', reason: 'role_mismatch' })
  })

  it('returns fallback role_mismatch when craftsmanRoleTarget differs', () => {
    const result = dispatchPushAction(
      { actionId: 'APPROVE', data: validData(), session: workerSession },
      { now: NOW },
    )
    expect(result).toMatchObject({ kind: 'fallback', reason: 'role_mismatch' })
  })

  it('returns fallback unknown_action_id for unknown action identifiers', () => {
    const result = dispatchPushAction(
      { actionId: 'tap', data: validData(), session: ownerSession },
      { now: NOW },
    )
    expect(result).toMatchObject({ kind: 'fallback', reason: 'unknown_action_id' })
  })

  it('returns fallback malformed when payload is null', () => {
    const result = dispatchPushAction(
      { actionId: 'APPROVE', data: null, session: ownerSession },
      { now: NOW },
    )
    expect(result).toEqual({
      kind: 'fallback',
      reason: 'malformed',
      fallbackRoute: null,
    })
  })

  it('returns fallback malformed when entityId is missing', () => {
    const result = dispatchPushAction(
      {
        actionId: 'APPROVE',
        data: validData({ entityId: '' }),
        session: ownerSession,
      },
      { now: NOW },
    )
    expect(result).toMatchObject({ kind: 'fallback', reason: 'malformed' })
  })

  it('returns fallback no_route when route is not whitelisted', () => {
    const result = dispatchPushAction(
      {
        actionId: 'APPROVE',
        data: validData({ route: '/admin/secret-panel' }),
        session: ownerSession,
      },
      { now: NOW },
    )
    expect(result).toMatchObject({ kind: 'fallback', reason: 'no_route' })
  })
})

describe('Block A2 · pushActionDispatcher — queue_for_auth', () => {
  it('queues the action when session is null', () => {
    const result = dispatchPushAction(
      { actionId: 'APPROVE', data: validData(), session: null },
      { now: NOW },
    )
    expect(result.kind).toBe('queue_for_auth')
    if (result.kind !== 'queue_for_auth') return
    expect(result.action).toMatchObject({
      actionId: 'APPROVE',
      entityId: 'c-123',
      entityType: 'correction',
      roleTarget: 'craftsman',
      craftsmanRoleTarget: 'owner',
      route: '/craftsman/jobs/job-42',
      enqueuedAt: NOW,
      expiresAt: NOW + 60_000,
    })
  })

  it('queues even when userId is null but session shell exists', () => {
    const result = dispatchPushAction(
      {
        actionId: 'REJECT',
        data: validData(),
        session: { userId: null, role: null },
      },
      { now: NOW },
    )
    expect(result.kind).toBe('queue_for_auth')
  })
})

describe('Block A2 · pushActionDispatcher — idempotency', () => {
  it('treats a second tap within 5s as duplicate_tap', () => {
    const data = validData()
    dispatchPushAction(
      { actionId: 'APPROVE', data, session: ownerSession },
      { now: NOW },
    )
    const second = dispatchPushAction(
      { actionId: 'APPROVE', data, session: ownerSession },
      { now: NOW + 1_000 },
    )
    expect(second).toMatchObject({ kind: 'fallback', reason: 'duplicate_tap' })
  })

  it('lets the second tap through after 5s', () => {
    const data = validData()
    dispatchPushAction(
      { actionId: 'APPROVE', data, session: ownerSession },
      { now: NOW },
    )
    const second = dispatchPushAction(
      { actionId: 'APPROVE', data, session: ownerSession },
      { now: NOW + 5_500 },
    )
    expect(second.kind).toBe('navigate_with_sheet')
  })

  it('keys idempotency separately by actionId — APPROVE and REJECT are independent', () => {
    const data = validData()
    dispatchPushAction(
      { actionId: 'APPROVE', data, session: ownerSession },
      { now: NOW },
    )
    const reject = dispatchPushAction(
      { actionId: 'REJECT', data, session: ownerSession },
      { now: NOW + 100 },
    )
    expect(reject.kind).toBe('navigate_with_sheet')
  })
})
