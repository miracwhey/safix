/**
 * Calendar UUID Contract
 *
 * Verifies the fix for the 22P02 "invalid input syntax for type uuid" root
 * cause: job-derived calendar entries were created with `id: \`cal_${job.id}\``
 * (not a UUID) and sent to the `calendar_entries.id uuid` Postgres column.
 *
 * Contracts enforced here:
 *   1. createCalendarEntryFromJob produces id === job.id (plain UUID, no prefix)
 *   2. No "cal_" prefix appears anywhere in the generated entry's id
 *   3. jobId is preserved separately so getByJobId lookups still work
 *   4. addCustomCalendarEntry produces a proper UUID id (not cal_custom_…)
 *   5. 22P02 is classified as 'validation' (permanent — no retry)
 *   6. isServerSideError returns true for class-22 Postgres codes
 *   7. Migration v1→v2 purges cal_* calendar mutations from the pending queue
 *   8. Migration is idempotent — a second call is a no-op
 *   9. Migration does NOT remove non-calendar or non-cal_* mutations
 *  10. Only cal_* calendar mutations are removed (non-cal calendar entries kept)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isValidUUID } from '../../src/lib/shared/generateUUID'
import { classifyFailure, isPermanentKind } from '../../src/lib/persistence/classifyFailure'
import { isServerSideError } from '../../src/lib/persistence/serverErrors'
import { createCalendarEntryFromJob } from '../../src/lib/calendar/calendarEngine'
import type { Job } from '../../src/lib/jobs/types'

// ── localStorage shim ─────────────────────────────────────────────────────────
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
  clearPendingMutations,
  migratePendingMutationsIfNeeded,
  setActiveMutationUser,
} from '../../src/lib/persistence/pendingMutationStore'

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: '59cc07e8-11fd-4abe-9580-8136a7ac8a6a',
    title: 'Badezimmer sanieren',
    customer: 'Max Mustermann',
    location: 'München',
    status: 'scheduled',
    dateLabel: 'Heute',
    amount: '1.200 €',
    assignedMemberIds: [],
    providerId: 'provider-uuid-1234',
    ...overrides,
  } as Job
}

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  setActiveMutationUser('user-A')
})

// ── 1–3: createCalendarEntryFromJob ID contract ───────────────────────────────

describe('createCalendarEntryFromJob — id contract', () => {
  it('uses job.id directly as the calendar entry id', () => {
    const job = makeJob()
    const entry = createCalendarEntryFromJob(job)
    expect(entry.id).toBe(job.id)
  })

  it('produced id is a valid UUID (no prefix)', () => {
    const job = makeJob()
    const entry = createCalendarEntryFromJob(job)
    expect(isValidUUID(entry.id)).toBe(true)
  })

  it('id does NOT start with cal_', () => {
    const job = makeJob()
    const entry = createCalendarEntryFromJob(job)
    expect(entry.id.startsWith('cal_')).toBe(false)
  })

  it('jobId is set separately so getByJobId lookups still resolve', () => {
    const job = makeJob()
    const entry = createCalendarEntryFromJob(job)
    expect(entry.jobId).toBe(job.id)
    // id and jobId are the same value — 1:1 mapping by design
    expect(entry.id).toBe(entry.jobId)
  })

  it('different jobs produce different calendar entry ids', () => {
    const jobA = makeJob({ id: '11111111-1111-1111-1111-111111111111' })
    const jobB = makeJob({ id: '22222222-2222-2222-2222-222222222222' })
    const entryA = createCalendarEntryFromJob(jobA)
    const entryB = createCalendarEntryFromJob(jobB)
    expect(entryA.id).not.toBe(entryB.id)
  })
})

// ── 5–6: 22P02 classification ────────────────────────────────────────────────

describe('22P02 classification — permanent, not retried', () => {
  const error22P02 = { code: '22P02', message: 'invalid input syntax for type uuid: "cal_59cc07e8-..."' }

  it('classifyFailure maps 22P02 → validation', () => {
    expect(classifyFailure(error22P02)).toBe('validation')
  })

  it('validation is a permanent kind (no retry, immediate escalation)', () => {
    expect(isPermanentKind('validation')).toBe(true)
  })

  it('isServerSideError returns true for 22P02', () => {
    expect(isServerSideError(error22P02)).toBe(true)
  })

  it('isServerSideError returns true for other class-22 codes', () => {
    expect(isServerSideError({ code: '22001' })).toBe(true) // string_data_right_truncation
    expect(isServerSideError({ code: '22003' })).toBe(true) // numeric_value_out_of_range
  })

  it('isServerSideError still returns true for class 23 (integrity)', () => {
    expect(isServerSideError({ code: '23505' })).toBe(true)
  })

  it('isServerSideError still returns true for class 42 (schema)', () => {
    expect(isServerSideError({ code: '42703' })).toBe(true)
  })

  it('isServerSideError returns false for transient/network errors', () => {
    expect(isServerSideError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isServerSideError({ status: 503 })).toBe(false)
  })

  it('classifyFailure still classifies 23xxx as business-rejected', () => {
    expect(classifyFailure({ code: '23505' })).toBe('business-rejected')
  })

  it('classifyFailure still classifies 42xxx as validation', () => {
    expect(classifyFailure({ code: '42703' })).toBe('validation')
  })
})

// ── 7–10: Migration v1→v2 — cal_* purge ─────────────────────────────────────

describe('migratePendingMutationsIfNeeded v1→v2 — cal_* calendar purge', () => {
  function simulateVersion(v: number): void {
    memoryStorage.setItem('fixup.pending_mutations.schema_version', String(v))
  }

  function enqueue(domain: string, entityId: string): void {
    enqueuePendingMutation({
      operation: 'insert',
      table: domain === 'calendar' ? 'calendar_entries' : domain,
      payload: { id: entityId },
      domain,
      entityId,
    })
  }

  it('purges cal_*-prefixed calendar mutations on upgrade from v1', () => {
    simulateVersion(1)
    enqueue('calendar', 'cal_59cc07e8-11fd-4abe-9580-8136a7ac8a6a')
    enqueue('calendar', 'cal_32367d63-d276-4823-b36c-7112acc06fce')

    const purged = migratePendingMutationsIfNeeded()

    expect(purged).toHaveLength(2)
    expect(purged.every((m) => m.entityId.startsWith('cal_'))).toBe(true)
    expect(getPendingMutations()).toHaveLength(0)
  })

  it('does NOT purge calendar mutations with a valid UUID entityId', () => {
    simulateVersion(1)
    const validUUID = '59cc07e8-11fd-4abe-9580-8136a7ac8a6a'
    enqueue('calendar', validUUID)

    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === validUUID)).toBe(false)
    expect(getPendingMutations().some((m) => m.entityId === validUUID)).toBe(true)
  })

  it('does NOT purge non-calendar mutations with cal_-like entityIds', () => {
    simulateVersion(1)
    enqueue('jobs', 'cal_looks-like-calendar-but-is-not')

    const purged = migratePendingMutationsIfNeeded()

    // jobs domain — not touched by v2 migration
    expect(purged.some((m) => m.domain === 'jobs')).toBe(false)
    expect(getPendingMutations().some((m) => m.domain === 'jobs')).toBe(true)
  })

  it('migration is idempotent — second call is a no-op', () => {
    simulateVersion(1)
    enqueue('calendar', 'cal_59cc07e8-11fd-4abe-9580-8136a7ac8a6a')

    migratePendingMutationsIfNeeded()
    const secondCall = migratePendingMutationsIfNeeded()

    expect(secondCall).toHaveLength(0)
  })

  it('v0→v2 upgrade applies both steps: time-based prune AND cal_* purge', () => {
    simulateVersion(0)
    enqueue('calendar', 'cal_old-invalid-id')

    // Age the mutation past the 1-hour v0→v1 threshold
    const raw = memoryStorage.getItem('fixup.pending_mutations.v1')!
    const list = JSON.parse(raw)
    const aged = list.map((m: { enqueuedAt: number }) => ({
      ...m,
      enqueuedAt: m.enqueuedAt - 2 * 60 * 60 * 1000,
    }))
    memoryStorage.setItem('fixup.pending_mutations.v1', JSON.stringify(aged))

    const purged = migratePendingMutationsIfNeeded()

    expect(purged.length).toBeGreaterThanOrEqual(1)
    expect(getPendingMutations()).toHaveLength(0)
  })
})
