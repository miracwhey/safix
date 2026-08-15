/**
 * Block I-Sync — flushPendingMutations stale prune + migration drop
 *
 * Verifies the loop-breaker for orphan mutations:
 *
 *   - On the first flush after a schema bump, mutations older than the
 *     pre-bump threshold are purged into permanent failures.
 *   - On every flush, mutations older than MAX_PENDING_AGE_MS are dropped
 *     into permanent failures.
 *   - Both paths increment the FlushResult.dropped counter so the
 *     SyncStatusBar caller still triggers a resync to reconcile cache.
 *   - Fresh mutations are unaffected — replay still works.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

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

const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation(() => ({
      upsert: mockUpsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })),
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

import { flushPendingMutations } from '../../src/lib/persistence/flushPendingMutations'
import {
  enqueuePendingMutation,
  getPendingMutations,
  setActiveMutationUser,
  clearPendingMutations,
  MAX_PENDING_AGE_MS,
  type PendingMutation,
} from '../../src/lib/persistence/pendingMutationStore'
import {
  clearPersistenceFailures,
  getPersistenceFailures,
} from '../../src/lib/persistence/persistenceErrorStore'

function enqueueOne(domain: string, table: string, entityId: string): void {
  enqueuePendingMutation({
    operation: 'insert',
    table,
    payload: { id: entityId },
    domain,
    entityId,
  })
}

function ageAll(amountMs: number): void {
  const raw = memoryStorage.getItem('fixup.pending_mutations.v1')
  if (!raw) return
  const list = JSON.parse(raw) as PendingMutation[]
  const aged = list.map((m) => ({ ...m, enqueuedAt: m.enqueuedAt - amountMs }))
  memoryStorage.setItem('fixup.pending_mutations.v1', JSON.stringify(aged))
}

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  clearPersistenceFailures()
  setActiveMutationUser('user-A')
  mockUpsert.mockReset()
  // Default upsert behaviour: no error.  Tests that need a specific
  // failure mock the call with mockResolvedValueOnce.
  mockUpsert.mockResolvedValue({ error: null })
})

describe('flushPendingMutations — schema migration drop', () => {
  it('drops orphan mutations older than the pre-bump threshold on first run', async () => {
    enqueueOne('calendar', 'calendar_entries', 'orphan-1')
    enqueueOne('calendar', 'calendar_entries', 'orphan-2')
    // Age past the 1 h pre-bump threshold but not past the 7 d TTL.
    ageAll(2 * 60 * 60 * 1000)

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(2)
    expect(result.flushed).toBe(0)
    expect(result.remaining).toBe(0)
    expect(getPendingMutations()).toHaveLength(0)

    const failures = getPersistenceFailures()
    expect(failures).toHaveLength(2)
    for (const f of failures) {
      expect(f.permanent).toBe(true)
      expect(f.domain).toBe('calendar')
      // recordStaleDrops uses kind: 'unknown' for orphans (no error code to classify)
      expect(f.kind).toBe('unknown')
    }
    // No actual replay attempted — orphans are dropped before the replay loop.
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('subsequent flushes do not re-trigger migration (idempotent)', async () => {
    // Bump the schema version directly so the migration is a no-op without
    // an extra flush call (which sets the inflight slot and complicates the
    // mock interaction in this synthetic scenario).
    memoryStorage.setItem('fixup.pending_mutations.schema_version', '1')

    // Now enqueue + age past the pre-bump threshold.  After a bump the
    // migration must be a no-op — only the rolling TTL prune may drop.
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageAll(2 * 60 * 60 * 1000)

    const result = await flushPendingMutations()

    // Mutation younger than 7-day TTL → replay succeeded, not migration-dropped.
    expect(result.flushed).toBe(1)
    expect(result.dropped).toBe(0)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })
})

describe('flushPendingMutations — TTL prune', () => {
  beforeEach(() => {
    // Skip the migration noise — bump the version first.
    memoryStorage.setItem('fixup.pending_mutations.schema_version', '1')
  })

  it('drops mutations older than MAX_PENDING_AGE_MS as permanent failures', async () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageAll(MAX_PENDING_AGE_MS + 60_000) // 7 d + 1 min

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    expect(result.flushed).toBe(0)
    expect(result.remaining).toBe(0)
    expect(getPendingMutations()).toHaveLength(0)

    const failures = getPersistenceFailures()
    expect(failures).toHaveLength(1)
    expect(failures[0].permanent).toBe(true)
    expect(failures[0].domain).toBe('calendar')
    expect(failures[0].entityId).toBe('cal-1')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('keeps fresh mutations and only drops stale ones in the same flush', async () => {
    enqueueOne('calendar', 'calendar_entries', 'old-1')
    ageAll(MAX_PENDING_AGE_MS + 60_000)
    enqueueOne('calendar', 'calendar_entries', 'fresh-1')
    mockUpsert.mockResolvedValueOnce({ error: null })

    const result = await flushPendingMutations()

    expect(result.dropped).toBe(1)
    expect(result.flushed).toBe(1)
    expect(result.remaining).toBe(0)
    expect(getPendingMutations()).toHaveLength(0)

    const failures = getPersistenceFailures()
    expect(failures).toHaveLength(1)
    expect(failures[0].entityId).toBe('old-1')
  })
})

describe('flushPendingMutations — telemetry-friendly result', () => {
  beforeEach(() => {
    memoryStorage.setItem('fixup.pending_mutations.schema_version', '1')
  })

  it('records the dropped count even when no mutations remain to replay', async () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageAll(MAX_PENDING_AGE_MS + 60_000)

    const result = await flushPendingMutations()

    // Caller (SyncStatusBar handleResync) reads { dropped > 0 } to decide
    // whether to trigger resyncRepositories — must reflect the prune drops.
    expect(result.dropped).toBe(1)
    expect(result.flushed).toBe(0)
    expect(result.remaining).toBe(0)
  })
})
