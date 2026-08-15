import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
    keys: vi.fn(async () => Array.from(store.keys())),
    __reset: () => store.clear(),
  }
})

import {
  enqueuePendingAction,
  dequeuePendingAction,
  peekAllPendingActions,
  clearPendingActions,
  __testOnly_resetQueue,
  type PendingPushAction,
} from '../../src/lib/notifications/pendingPushAction'

const NOW = 1_746_374_400_000

function makeAction(overrides: Partial<PendingPushAction> = {}): PendingPushAction {
  return {
    actionId: 'APPROVE',
    actionType: 'correction.submitted',
    entityType: 'correction',
    entityId: 'c-123',
    roleTarget: 'craftsman',
    craftsmanRoleTarget: 'owner',
    expectedStatus: 'pending',
    route: '/craftsman/jobs/job-42',
    fallbackRoute: '/craftsman/korrekturen',
    actionVersion: 1,
    enqueuedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  }
}

async function resetStore() {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
}

beforeEach(async () => {
  await resetStore()
  await __testOnly_resetQueue()
})

describe('Block A2 · pendingPushAction — basic queue ops', () => {
  it('enqueues, peeks, dequeues, and clears', async () => {
    await enqueuePendingAction(makeAction({ entityId: 'c-1' }), NOW)
    await enqueuePendingAction(makeAction({ entityId: 'c-2' }), NOW + 100)

    const peeked = await peekAllPendingActions(NOW + 200)
    expect(peeked.map((a) => a.entityId)).toEqual(['c-1', 'c-2'])

    const head = await dequeuePendingAction(NOW + 200)
    expect(head?.entityId).toBe('c-1')

    const remaining = await peekAllPendingActions(NOW + 200)
    expect(remaining.map((a) => a.entityId)).toEqual(['c-2'])

    await clearPendingActions()
    expect(await peekAllPendingActions(NOW + 200)).toEqual([])
  })

  it('returns null on dequeue when queue is empty', async () => {
    expect(await dequeuePendingAction(NOW)).toBeNull()
  })
})

describe('Block A2 · pendingPushAction — expiry handling', () => {
  it('drops expired entries on read', async () => {
    await enqueuePendingAction(
      makeAction({ entityId: 'c-old', expiresAt: NOW + 1_000 }),
      NOW,
    )
    await enqueuePendingAction(
      makeAction({ entityId: 'c-fresh', expiresAt: NOW + 60_000 }),
      NOW,
    )
    const result = await peekAllPendingActions(NOW + 5_000)
    expect(result.map((a) => a.entityId)).toEqual(['c-fresh'])
  })

  it('returns null and clears storage when all entries are expired', async () => {
    await enqueuePendingAction(
      makeAction({ entityId: 'c-1', expiresAt: NOW + 1_000 }),
      NOW,
    )
    const result = await dequeuePendingAction(NOW + 5_000)
    expect(result).toBeNull()
    expect(await peekAllPendingActions(NOW + 5_000)).toEqual([])
  })
})

describe('Block A2 · pendingPushAction — capacity', () => {
  it('drops oldest entries when queue exceeds 10', async () => {
    for (let i = 0; i < 12; i++) {
      await enqueuePendingAction(
        makeAction({ entityId: `c-${i}`, enqueuedAt: NOW + i }),
        NOW + i,
      )
    }
    const queue = await peekAllPendingActions(NOW + 100)
    expect(queue).toHaveLength(10)
    // Oldest two (c-0, c-1) should be dropped, c-2 .. c-11 remain.
    expect(queue.map((a) => a.entityId)).toEqual([
      'c-2',
      'c-3',
      'c-4',
      'c-5',
      'c-6',
      'c-7',
      'c-8',
      'c-9',
      'c-10',
      'c-11',
    ])
  })

  it('survives a simulated reload — entries persist across module access', async () => {
    await enqueuePendingAction(makeAction({ entityId: 'c-persist' }), NOW)
    // Re-read via a fresh peek call (simuliert App-Reload mit gleichem IDB-State).
    const reloaded = await peekAllPendingActions(NOW + 1_000)
    expect(reloaded.map((a) => a.entityId)).toEqual(['c-persist'])
  })
})
