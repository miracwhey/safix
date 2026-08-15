/**
 * Block H-Failure-Class — flushPendingMutations kind-driven retry/drop policy
 *
 * Verifies that flushPendingMutations does NOT pauschal retry every error
 * five times.  Specifically:
 *
 *   - permission-denied (PGRST301, 403)
 *       → mutation removed from queue, permanent failure recorded, dropped++
 *   - business-rejected (Postgres class 23xxx)
 *       → mutation removed from queue, permanent failure recorded, dropped++
 *   - validation (Postgres class 42xxx)
 *       → mutation removed from queue, permanent failure recorded, dropped++
 *   - auth-not-ready (cross-user mutation, currentUid=null with userId set)
 *       → silent skip; no remove, no record, no retry++
 *   - transient (TypeError fetch)
 *       → retry++ as before, retryable behaviour preserved
 *   - retryable (HTTP 503)
 *       → retry++ as before
 *
 * Combined: a single flush wave drops permanent failures at attempt #1
 * instead of after the legacy 5-retry MAX_RETRIES spiral.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── localStorage shim ─────────────────────────────────────────────────────────
// pendingMutationStore lazily reads/writes localStorage.  In the node test
// environment it is undefined; provide a tiny in-memory shim so the queue
// can hold mutations across the test.

const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()

vi.stubGlobal('localStorage', memoryStorage)

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockUpsert, mockUpdateChain } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockUpdateChain: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      upsert: mockUpsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => mockUpdateChain()),
      }),
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-A' } } },
      }),
    },
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { flushPendingMutations } from '../../src/lib/persistence/flushPendingMutations'
import {
  enqueuePendingMutation,
  getPendingMutations,
  clearPendingMutations,
  setActiveMutationUser,
} from '../../src/lib/persistence/pendingMutationStore'
import {
  clearPersistenceFailures,
  getPersistenceFailures,
} from '../../src/lib/persistence/persistenceErrorStore'

// ── Helpers ───────────────────────────────────────────────────────────────────

function enqueueOne(domain: string, table: string, entityId: string): void {
  enqueuePendingMutation({
    operation: 'insert',
    table,
    payload: { id: entityId, foo: 'bar' },
    domain,
    entityId,
  })
}

function findFailure(domain: string, entityId: string) {
  return getPersistenceFailures().find(
    (f) => f.domain === domain && f.entityId === entityId,
  )
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  clearPersistenceFailures()
  setActiveMutationUser('user-A')
  mockUpsert.mockReset()
  mockUpdateChain.mockReset()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('flushPendingMutations — permanent kinds drop the mutation', () => {
  it('drops on PGRST301 (RLS reject) at first attempt', async () => {
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({ error: { code: 'PGRST301', message: 'JWT expired' } })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    expect(result.flushed).toBe(0)
    expect(result.remaining).toBe(0)
    expect(getPendingMutations()).toHaveLength(0)

    const fail = findFailure('jobs', 'job-1')
    expect(fail).toBeDefined()
    expect(fail!.kind).toBe('permission-denied')
    expect(fail!.permanent).toBe(true)
  })

  it('drops on 403 at first attempt', async () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    mockUpsert.mockResolvedValue({ error: { status: 403, message: 'Forbidden' } })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    expect(getPendingMutations()).toHaveLength(0)
    const fail = findFailure('calendar', 'cal-1')
    expect(fail!.kind).toBe('permission-denied')
    expect(fail!.permanent).toBe(true)
  })

  it('drops on 23502 (NOT NULL violation) at first attempt', async () => {
    enqueueOne('team', 'team_members', 'tm-1')
    mockUpsert.mockResolvedValue({
      error: { code: '23502', message: 'null value in column' },
    })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    expect(getPendingMutations()).toHaveLength(0)
    const fail = findFailure('team', 'tm-1')
    expect(fail!.kind).toBe('business-rejected')
    expect(fail!.permanent).toBe(true)
  })

  it('drops on 23505 (duplicate key) at first attempt', async () => {
    enqueueOne('messages', 'messages', 'msg-1')
    mockUpsert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key' },
    })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    const fail = findFailure('messages', 'msg-1')
    expect(fail!.kind).toBe('business-rejected')
    expect(fail!.permanent).toBe(true)
  })

  it('drops on 42703 (validation) at first attempt', async () => {
    enqueueOne('invoices', 'invoices', 'inv-1')
    mockUpsert.mockResolvedValue({
      error: { code: '42703', message: 'column does not exist' },
    })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    const fail = findFailure('invoices', 'inv-1')
    expect(fail!.kind).toBe('validation')
    expect(fail!.permanent).toBe(true)
  })
})

describe('flushPendingMutations — retryable kinds keep the mutation', () => {
  it('keeps mutation queued on transient (Failed to fetch) and increments retry', async () => {
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({
      error: { message: 'Failed to fetch' },
    })

    const result = await flushPendingMutations()

    expect(result.flushed).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    const queue = getPendingMutations()
    expect(queue).toHaveLength(1)
    expect(queue[0].retryCount).toBe(1)

    const fail = findFailure('jobs', 'job-1')
    expect(fail).toBeDefined()
    expect(fail!.kind).toBe('transient')
    expect(fail!.permanent).toBeFalsy()
  })

  it('keeps mutation queued on retryable (HTTP 503) and increments retry', async () => {
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({
      error: { status: 503, message: 'Service Unavailable' },
    })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    const queue = getPendingMutations()
    expect(queue[0].retryCount).toBe(1)

    const fail = findFailure('jobs', 'job-1')
    expect(fail!.kind).toBe('retryable')
  })

  it('keeps mutation on unknown error and increments retry', async () => {
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({
      error: { message: 'something opaque' },
    })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    const fail = findFailure('jobs', 'job-1')
    expect(fail!.kind).toBe('unknown')
  })
})

describe('flushPendingMutations — auth-not-ready', () => {
  it('skips silently when currentUid is null and mutation has userId', async () => {
    // Tag the mutation as belonging to user-A.
    setActiveMutationUser('user-A')
    enqueueOne('jobs', 'jobs', 'job-1')

    // Switch the supabase session to "no user".
    const { supabase } = await import('../../src/lib/supabase')
    ;(supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { session: null },
    })

    const result = await flushPendingMutations()

    expect(result.flushed).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    // No record, no retry++ — purely silent.
    expect(getPersistenceFailures()).toHaveLength(0)
    const queue = getPendingMutations()
    expect(queue[0].retryCount).toBe(0)

    // Restore session so subsequent tests in this file are unaffected.
    ;(supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: { user: { id: 'user-A' } } },
    })
  })

  it('skips silently when mutation belongs to a different user', async () => {
    setActiveMutationUser('user-B')
    enqueueOne('jobs', 'jobs', 'job-2') // userId = user-B

    // Active session is user-A.
    setActiveMutationUser('user-A')

    const result = await flushPendingMutations()

    expect(result.flushed).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    expect(getPersistenceFailures()).toHaveLength(0)
  })

  it('silently skips replay when supabase responds 401 (expired JWT)', async () => {
    setActiveMutationUser('user-A')
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({
      error: { status: 401, message: 'Unauthorized' },
    })

    const result = await flushPendingMutations()

    // 401 → auth-not-ready → silent: mutation stays, no record, no retry++.
    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(1)
    expect(getPersistenceFailures()).toHaveLength(0)
    expect(getPendingMutations()[0].retryCount).toBe(0)
  })
})

describe('flushPendingMutations — successful replay still works', () => {
  it('removes mutation and clears failure on success', async () => {
    enqueueOne('jobs', 'jobs', 'job-1')
    mockUpsert.mockResolvedValue({ error: null })

    const result = await flushPendingMutations()

    expect(result.flushed).toBe(1)
    expect(result.dropped).toBe(0)
    expect(result.remaining).toBe(0)
    expect(getPendingMutations()).toHaveLength(0)
  })
})
