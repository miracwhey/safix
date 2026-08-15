/**
 * Block I-Sync-5 — UUID Contract: Schedule and Timeline ID Fix
 *
 * Root cause: createJobSchedule() and createTimelineEvent() generated
 * string-template IDs ("schedule-…", "timeline-…") that Postgres rejects
 * with 22P02 (invalid input syntax for type uuid) on INSERT.
 *
 * This block verifies:
 *   A. createJobSchedule() now returns a well-formed UUID id
 *   B. createTimelineEvent() now returns a well-formed UUID id
 *   C. Pending mutation migration v4 purges entityIds starting with "schedule-"
 *      in domain 'schedules'
 *   D. Pending mutation migration v4 purges entityIds starting with "timeline-"
 *      in domain 'timeline'
 *   E. Migration v4 leaves unrelated mutations intact
 *   F. Migration v4 is idempotent (subsequent calls are no-ops)
 *   G. A valid UUID schedule id is NOT purged by v4 migration
 *   H. A valid UUID timeline id is NOT purged by v4 migration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── localStorage shim ──────────────────────────────────────────────────────

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

// ── Imports ────────────────────────────────────────────────────────────────

import { isValidUUID } from '../../src/lib/shared/generateUUID'
import { createJobSchedule } from '../../src/lib/operations/operationsStore'
import { createTimelineEvent } from '../../src/lib/timeline/timelineService'
import {
  enqueuePendingMutation,
  getPendingMutations,
  clearPendingMutations,
  migratePendingMutationsIfNeeded,
  setActiveMutationUser,
} from '../../src/lib/persistence/pendingMutationStore'

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_JOB_UUID = '59cc07e8-11fd-4abe-9580-8136a7ac8a6a'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Force the stored schema version below the target to re-enable migration. */
function setSchemaVersion(v: number): void {
  memoryStorage.setItem('fixup.pending_mutations.schema_version', String(v))
}

function enqueue(domain: string, table: string, entityId: string): void {
  enqueuePendingMutation({
    operation: 'insert',
    table,
    payload: { id: entityId },
    domain,
    entityId,
  })
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  setActiveMutationUser('user-test')
})

// ── A. createJobSchedule generates valid UUID ──────────────────────────────

describe('A. createJobSchedule — UUID contract', () => {
  it('generates a well-formed UUID id', () => {
    const schedule = createJobSchedule({
      jobId: VALID_JOB_UUID,
      scheduledStart: Date.now(),
      scheduledEnd: Date.now() + 3_600_000,
    })
    expect(isValidUUID(schedule.id)).toBe(true)
  })

  it('does not produce a "schedule-" prefixed id', () => {
    const schedule = createJobSchedule({
      jobId: VALID_JOB_UUID,
      scheduledStart: Date.now(),
      scheduledEnd: Date.now() + 3_600_000,
    })
    expect(schedule.id.startsWith('schedule-')).toBe(false)
  })

  it('generates a unique id on each call', () => {
    const a = createJobSchedule({ jobId: VALID_JOB_UUID, scheduledStart: 0, scheduledEnd: 1 })
    const b = createJobSchedule({ jobId: VALID_JOB_UUID, scheduledStart: 0, scheduledEnd: 1 })
    expect(a.id).not.toBe(b.id)
  })
})

// ── B. createTimelineEvent generates valid UUID ────────────────────────────

describe('B. createTimelineEvent — UUID contract', () => {
  it('generates a well-formed UUID id', () => {
    const event = createTimelineEvent({ jobId: VALID_JOB_UUID, type: 'job_scheduled' })
    expect(isValidUUID(event.id)).toBe(true)
  })

  it('does not produce a "timeline-" prefixed id', () => {
    const event = createTimelineEvent({ jobId: VALID_JOB_UUID, type: 'job_scheduled' })
    expect(event.id.startsWith('timeline-')).toBe(false)
  })

  it('generates a unique id on each call', () => {
    const a = createTimelineEvent({ jobId: VALID_JOB_UUID, type: 'job_scheduled' })
    const b = createTimelineEvent({ jobId: VALID_JOB_UUID, type: 'job_scheduled' })
    expect(a.id).not.toBe(b.id)
  })
})

// ── C. Migration v4 — purges "schedule-" prefixed schedule mutations ───────

describe('C. Migration v4 — schedule- purge', () => {
  it('removes schedule domain mutations with "schedule-" prefixed entityId', () => {
    const badId = `schedule-${VALID_JOB_UUID}-${Date.now()}-abcd`
    enqueue('schedules', 'schedules', badId)
    expect(getPendingMutations()).toHaveLength(1)

    setSchemaVersion(3)
    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === badId)).toBe(true)
    expect(getPendingMutations()).toHaveLength(0)
  })
})

// ── D. Migration v4 — purges "timeline-" prefixed timeline mutations ───────

describe('D. Migration v4 — timeline- purge', () => {
  it('removes timeline domain mutations with "timeline-" prefixed entityId', () => {
    const badId = `timeline-${VALID_JOB_UUID}-job_scheduled-${Date.now()}-qykg`
    enqueue('timeline', 'timeline_signals', badId)
    expect(getPendingMutations()).toHaveLength(1)

    setSchemaVersion(3)
    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === badId)).toBe(true)
    expect(getPendingMutations()).toHaveLength(0)
  })
})

// ── E. Migration v4 — unrelated mutations survive ─────────────────────────

describe('E. Migration v4 — unrelated mutations survive', () => {
  it('keeps mutations from unrelated domains', () => {
    const goodId = '11111111-2222-3333-4444-555555555555'
    enqueue('jobs', 'jobs', goodId)

    setSchemaVersion(3)
    migratePendingMutationsIfNeeded()

    const remaining = getPendingMutations()
    expect(remaining.some((m) => m.entityId === goodId)).toBe(true)
  })

  it('keeps schedules mutations with a valid UUID entityId', () => {
    enqueue('schedules', 'schedules', VALID_JOB_UUID)

    setSchemaVersion(3)
    migratePendingMutationsIfNeeded()

    const remaining = getPendingMutations()
    expect(remaining.some((m) => m.entityId === VALID_JOB_UUID)).toBe(true)
  })
})

// ── F. Migration v4 — idempotent ──────────────────────────────────────────

describe('F. Migration v4 — idempotent', () => {
  it('returns [] on subsequent calls after schema version is current', () => {
    setSchemaVersion(3)
    const badId = `schedule-${VALID_JOB_UUID}-123-abcd`
    enqueue('schedules', 'schedules', badId)

    migratePendingMutationsIfNeeded()
    const secondRun = migratePendingMutationsIfNeeded()

    expect(secondRun).toHaveLength(0)
  })
})

// ── G. Valid UUID schedule id not purged ───────────────────────────────────

describe('G. Valid UUID not purged by v4', () => {
  it('schedule mutation with UUID entityId survives v4 migration', () => {
    const validId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    enqueue('schedules', 'schedules', validId)

    setSchemaVersion(3)
    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === validId)).toBe(false)
    expect(getPendingMutations().some((m) => m.entityId === validId)).toBe(true)
  })
})

// ── H. Valid UUID timeline id not purged ───────────────────────────────────

describe('H. Valid UUID not purged by v4', () => {
  it('timeline mutation with UUID entityId survives v4 migration', () => {
    const validId = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'
    enqueue('timeline', 'timeline_signals', validId)

    setSchemaVersion(3)
    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === validId)).toBe(false)
    expect(getPendingMutations().some((m) => m.entityId === validId)).toBe(true)
  })
})
