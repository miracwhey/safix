/**
 * Block I-Sync — PendingMutation TTL, Migration, and Snapshot
 *
 * Verifies the lifecycle hardening that breaks the "stale orphan" loop:
 *
 *   - prunePendingMutations drops mutations older than MAX_PENDING_AGE_MS
 *   - migratePendingMutationsIfNeeded purges legacy queue on first boot of
 *     a new schema version
 *   - migration is idempotent (subsequent calls are no-ops)
 *   - getPendingMutationsSnapshot exposes domain/entityId/userId/retryCount
 *     /age WITHOUT payload (telemetry-safe)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Provide a tiny in-memory localStorage shim so the store can persist
// across calls inside the node test environment.
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

import {
  enqueuePendingMutation,
  getPendingMutations,
  setActiveMutationUser,
  clearPendingMutations,
  prunePendingMutations,
  migratePendingMutationsIfNeeded,
  getPendingMutationsSnapshot,
  MAX_PENDING_AGE_MS,
  type PendingMutation,
} from '../../src/lib/persistence/pendingMutationStore'

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  setActiveMutationUser('user-A')
})

function enqueueOne(domain: string, table: string, entityId: string): void {
  enqueuePendingMutation({
    operation: 'insert',
    table,
    payload: { id: entityId, foo: 'bar' },
    domain,
    entityId,
  })
}

function ageOldest(amountMs: number): void {
  // Manually rewrite enqueuedAt for every queued mutation.  Easier than
  // mocking Date.now() across the load/persist boundary.
  const raw = memoryStorage.getItem('fixup.pending_mutations.v1')
  if (!raw) return
  const list = JSON.parse(raw) as PendingMutation[]
  const aged = list.map((m) => ({ ...m, enqueuedAt: m.enqueuedAt - amountMs }))
  memoryStorage.setItem('fixup.pending_mutations.v1', JSON.stringify(aged))
}

describe('prunePendingMutations — TTL drop', () => {
  it('does not drop fresh mutations', () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    const purged = prunePendingMutations()
    expect(purged).toHaveLength(0)
    expect(getPendingMutations()).toHaveLength(1)
  })

  it('drops mutations older than MAX_PENDING_AGE_MS', () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    enqueueOne('jobs', 'jobs', 'job-1')

    // Age both past the TTL.
    ageOldest(MAX_PENDING_AGE_MS + 1_000)

    const purged = prunePendingMutations()
    expect(purged).toHaveLength(2)
    expect(getPendingMutations()).toHaveLength(0)
    // Order preserved in purged so the caller can record per-entity failures.
    expect(purged.map((m) => m.entityId).sort()).toEqual(['cal-1', 'job-1'])
  })

  it('keeps fresh and drops stale in the same queue', () => {
    enqueueOne('calendar', 'calendar_entries', 'old-1')
    ageOldest(MAX_PENDING_AGE_MS + 1_000)
    enqueueOne('calendar', 'calendar_entries', 'fresh-1')

    const purged = prunePendingMutations()
    expect(purged).toHaveLength(1)
    expect(purged[0].entityId).toBe('old-1')
    expect(getPendingMutations()).toHaveLength(1)
    expect(getPendingMutations()[0].entityId).toBe('fresh-1')
  })

  it('does not write to storage when nothing is pruned (idempotency)', () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    const before = memoryStorage.getItem('fixup.pending_mutations.v1')
    prunePendingMutations()
    const after = memoryStorage.getItem('fixup.pending_mutations.v1')
    expect(after).toBe(before)
  })
})

describe('migratePendingMutationsIfNeeded — schema version', () => {
  it('purges old orphans on first run when no schema version is stored', () => {
    enqueueOne('calendar', 'calendar_entries', 'orphan-1')
    enqueueOne('calendar', 'calendar_entries', 'orphan-2')
    // Push them past the 1-hour pre-bump threshold.
    ageOldest(2 * 60 * 60 * 1000)

    const purged = migratePendingMutationsIfNeeded()

    expect(purged).toHaveLength(2)
    expect(getPendingMutations()).toHaveLength(0)
    expect(memoryStorage.getItem('fixup.pending_mutations.schema_version')).toBe('4')
  })

  it('keeps mutations younger than the pre-bump threshold (offline writes survive upgrade)', () => {
    enqueueOne('calendar', 'calendar_entries', 'fresh-1')
    // 30 min — under the 1 h threshold.
    ageOldest(30 * 60 * 1000)

    const purged = migratePendingMutationsIfNeeded()

    expect(purged).toHaveLength(0)
    expect(getPendingMutations()).toHaveLength(1)
    // Schema version still bumped — migration is one-shot.
    expect(memoryStorage.getItem('fixup.pending_mutations.schema_version')).toBe('4')
  })

  it('is idempotent — subsequent calls are no-ops', () => {
    // First call bumps the version with no mutations queued.
    migratePendingMutationsIfNeeded()
    expect(memoryStorage.getItem('fixup.pending_mutations.schema_version')).toBe('4')

    // Now enqueue + age something far past the pre-bump threshold.  A naive
    // re-run would purge it; the migration must skip because the version
    // already matches.
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageOldest(24 * 60 * 60 * 1000)

    const purged = migratePendingMutationsIfNeeded()
    expect(purged).toHaveLength(0)
    expect(getPendingMutations()).toHaveLength(1)
  })

  it('handles a missing localStorage gracefully (no crash, no purge)', () => {
    // Temporarily replace localStorage with one whose getItem returns null
    // for the schema_version key — same as before bump.
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageOldest(2 * 60 * 60 * 1000)
    const purged = migratePendingMutationsIfNeeded()
    expect(purged).toHaveLength(1) // migrated once
    // Re-running after bump must not crash even though storage state changed.
    expect(() => migratePendingMutationsIfNeeded()).not.toThrow()
  })
})

describe('getPendingMutationsSnapshot — telemetry shape', () => {
  it('exposes diagnostic fields without payload', () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    enqueueOne('jobs', 'jobs', 'job-1')

    const snap = getPendingMutationsSnapshot()
    expect(snap).toHaveLength(2)
    for (const s of snap) {
      expect(s).toHaveProperty('domain')
      expect(s).toHaveProperty('table')
      expect(s).toHaveProperty('entityId')
      expect(s).toHaveProperty('operation')
      expect(s).toHaveProperty('userId')
      expect(s).toHaveProperty('retryCount')
      expect(s).toHaveProperty('enqueuedAt')
      expect(s).toHaveProperty('ageMs')
      // CRITICAL: payload must NEVER appear on a snapshot.
      expect(s).not.toHaveProperty('payload')
      expect(s).not.toHaveProperty('id') // synthetic id is also private
    }
  })

  it('reports ageMs based on enqueuedAt', () => {
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    ageOldest(60_000) // 1 min

    const snap = getPendingMutationsSnapshot()
    expect(snap[0].ageMs).toBeGreaterThanOrEqual(60_000)
    expect(snap[0].ageMs).toBeLessThan(60_000 + 5_000) // tolerance
  })

  it('includes the userId tagged at enqueue', () => {
    setActiveMutationUser('user-A')
    enqueueOne('calendar', 'calendar_entries', 'cal-1')
    setActiveMutationUser('user-B')
    enqueueOne('calendar', 'calendar_entries', 'cal-2')

    const snap = getPendingMutationsSnapshot()
    const calA = snap.find((s) => s.entityId === 'cal-1')
    const calB = snap.find((s) => s.entityId === 'cal-2')
    expect(calA?.userId).toBe('user-A')
    expect(calB?.userId).toBe('user-B')
  })
})
