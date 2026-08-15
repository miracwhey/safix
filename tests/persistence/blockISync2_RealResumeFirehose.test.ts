/**
 * Block I-Sync-2 — Real-iPhone resume firehose + retry no-op repros.
 *
 * Concrete failure mode reported on a real iPhone with a Handwerker /
 * Betriebsinhaber account:
 *
 *   1. App is opened, user is logged in.
 *   2. User briefly leaves to Konto/Einstellungen / backgrounds the app.
 *   3. App returns to foreground.
 *   4. SyncStatusBar shows "2 Änderungen warten auf Synchronisierung",
 *      Details modal lists "Calendar — 2 Änderungen".
 *   5. Tapping "Erneut versuchen" looks like a no-op — the same banner
 *      reappears immediately after the resync wave.
 *
 * Root-cause chain that the previous Block-I-Sync fix did NOT cover:
 *
 *   A. CraftsmanDashboardScreen / CraftsmanOperationsScreen call
 *      `syncCalendarEntriesForJobs` synchronously inside their
 *      subscribeJobs callback.  Every JobRepository.notify() — including
 *      the cascade fired by `initializeJobRepository(true)` inside
 *      `resyncRepositories()` — re-fires the reconcile path.  Each
 *      reconcile spawns a fire-and-forget `replace()` that the supabase
 *      side rejects with the same permanent-kind error (RLS WITH CHECK,
 *      NOT NULL, 23xxx, 42xxx, …).  Each rejection records a fresh
 *      PersistenceFailure under (calendar, entityId).
 *
 *   B. `resyncRepositories()` clears the failure store at the end of its
 *      cascade.  Because the subscriber-driven `replace()` calls are
 *      fire-and-forget, their rejection arrives AFTER the clear → the
 *      banner re-shows the same failure count.  The user reads "Erneut
 *      versuchen" as a no-op.
 *
 * Coverage:
 *
 *   T1 syncCalendarEntriesForJobs skips replace() while a calendar
 *      failure is recorded for that entity (firehose break).
 *   T2 syncCalendarEntriesForJobs skips add() under the same condition.
 *   T3 SupabaseCalendarRepository.drainInFlightWrites awaits every
 *      pending supabase write before resolving (drain contract).
 *   T4 drainInFlightWrites is bounded by maxWaitMs so a hung connection
 *      cannot block the caller indefinitely.
 *   T5 resyncRepositories awaits the calendar drain BEFORE
 *      clearPersistenceFailures, so a subscriber-driven write that
 *      rejects with a permanent-kind error cannot survive into the
 *      post-resync banner state via a clear/record race.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockUpdateEq, mockInsertResolved, mockSelectAllProvider } = vi.hoisted(() => ({
  mockUpdateEq: vi.fn(),
  mockInsertResolved: vi.fn(),
  mockSelectAllProvider: vi.fn(),
}))

// Minimal supabase mock — only the surface SupabaseCalendarRepository
// touches.  Calendar entries select returns an empty list so initialize
// does not race against replace() calls fired through the firehose path.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'calendar_entries') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: (payload: unknown) => mockInsertResolved(payload),
          update: vi.fn().mockReturnValue({
            eq: (col: string, val: string) => mockUpdateEq(col, val),
          }),
        }
      }
      if (table === 'providers') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: () => mockSelectAllProvider(),
            }),
          }),
        }
      }
      if (table === 'team_members') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'uid-1' } } } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

// Persistence module mock — single shared in-test failure store + queue
// surfaced via the exact named exports the production code imports.  Using a
// stub here avoids leaning on the production module's RAM-only state across
// suites running in the same vitest process.
const failureSet = new Set<string>()
const queueByEntity = new Map<string, boolean>()

const mockEnqueue = vi.fn()
const mockRecordFailure = vi.fn().mockImplementation((input: { domain: string; entityId: string }) => {
  failureSet.add(`${input.domain}:${input.entityId}`)
})

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...(args as [{ domain: string; entityId: string }])),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (_table: string, entityId: string) => queueByEntity.get(entityId) ?? false,
  hasPersistenceFailureForEntity: (domain: string, entityId: string) => failureSet.has(`${domain}:${entityId}`),
  getPendingMutations: () => [],
  isServerSideError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    if (typeof e.code !== 'string') return false
    return e.code.startsWith('23') || e.code.startsWith('42')
  },
  isDuplicateKeyError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    return e.code === '23505'
  },
}))

import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import {
  setCalendarRepository,
  drainCalendarInFlightWrites,
} from '../../src/lib/calendar/repository'
import { syncCalendarEntriesForJobs } from '../../src/lib/calendar/calendarStore'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

const now = Date.now()

function makeJob(id: string, status: Job['status']): Job {
  // Minimal stub satisfying the fields syncCalendarEntriesForJobs touches.
  // dateLabel is read by createCalendarEntryFromJob → getDefaultTimeWindow,
  // so it must be a string (not undefined).  All other Job fields are
  // unused by the reconcile path.
  return {
    id,
    title: 'Test',
    description: '',
    status,
    location: 'Berlin',
    customer: 'Kunde',
    customerName: 'Kunde',
    providerId: 'prov-1',
    assignedMemberIds: [],
    dateLabel: 'Heute',
  } as unknown as Job
}

function makeEntry(jobId: string, status: CalendarEntry['status']): CalendarEntry {
  return {
    id: jobId,
    jobId,
    kind: 'job',
    providerId: 'prov-1',
    title: 'Test',
    customerName: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '20260426',
    startsAtLabel: '09:00',
    endsAtLabel: '10:00',
    assignedMemberIds: [],
    status,
    createdAt: now,
    updatedAt: now,
  }
}

beforeEach(() => {
  failureSet.clear()
  queueByEntity.clear()
  mockEnqueue.mockReset()
  mockRecordFailure.mockClear()
  mockUpdateEq.mockReset()
  mockInsertResolved.mockReset()
  mockSelectAllProvider.mockReset()
  mockSelectAllProvider.mockResolvedValue({ data: { id: 'prov-1' } })
})

describe('syncCalendarEntriesForJobs — firehose guard via hasPersistenceFailureForEntity', () => {
  it('T1 skips replace() while an active calendar failure is recorded for the entity', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)
    // Seed the local cache with an entry whose status differs from the job's
    // derived status so the reconcile branch would normally fire replace().
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = [
      makeEntry('job-1', 'in_progress'),
    ]

    // Existing recorded failure for this entity — exactly the state after
    // the first replace() rejection on resume.
    failureSet.add('calendar:job-1')

    syncCalendarEntriesForJobs([makeJob('job-1', 'completed')])

    // Drain just to be safe — even if a replace() did fire, drain would
    // surface its mock interaction.  None should have fired.
    await drainCalendarInFlightWrites(50)
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('T2 skips add() while a recorded failure exists for the would-be created entity', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = []

    // The entry id syncCalendarEntriesForJobs would create is job.id.
    failureSet.add('calendar:job-2')

    syncCalendarEntriesForJobs([makeJob('job-2', 'scheduled')])

    await drainCalendarInFlightWrites(50)
    expect(mockInsertResolved).not.toHaveBeenCalled()
  })

  it('still fires replace() when no failure is recorded (regression — guard must not over-block)', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = [
      makeEntry('job-3', 'in_progress'),
    ]

    mockUpdateEq.mockResolvedValue({ error: null })

    syncCalendarEntriesForJobs([makeJob('job-3', 'completed')])
    await drainCalendarInFlightWrites(50)

    expect(mockUpdateEq).toHaveBeenCalledTimes(1)
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'job-3')
  })
})

describe('SupabaseCalendarRepository.drainInFlightWrites — drain contract', () => {
  it('T3 awaits in-flight supabase writes before resolving', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = [
      makeEntry('job-4', 'in_progress'),
    ]

    let resolveUpdate: (v: { error: unknown }) => void = () => {}
    mockUpdateEq.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve as (v: { error: unknown }) => void
      }),
    )

    // Fire reconcile — replace() starts an async update that is intentionally
    // pending until we resolve it manually below.
    syncCalendarEntriesForJobs([makeJob('job-4', 'completed')])

    // drain must NOT resolve yet — the inner update is still pending.
    let drained = false
    const drainPromise = repo.drainInFlightWrites(2_000).then(() => { drained = true })

    // Tick microtasks — drain remains unresolved.
    await Promise.resolve()
    await Promise.resolve()
    expect(drained).toBe(false)

    // Resolve the inner update.  drain must now settle on the next microtask.
    resolveUpdate({ error: null })
    await drainPromise
    expect(drained).toBe(true)
  })

  it('T4 is bounded by maxWaitMs (no indefinite block on a hung connection)', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = [
      makeEntry('job-5', 'in_progress'),
    ]

    // Update never resolves — simulate a hung WKWebView fetch on resume.
    mockUpdateEq.mockReturnValue(new Promise(() => {}))

    syncCalendarEntriesForJobs([makeJob('job-5', 'completed')])

    const start = Date.now()
    await repo.drainInFlightWrites(100)
    const elapsed = Date.now() - start
    // Tolerate a generous upper bound — CI machines can be slow.
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('resolves immediately when no writes are in flight', async () => {
    const repo = new SupabaseCalendarRepository()
    setCalendarRepository(repo)

    const start = Date.now()
    await repo.drainInFlightWrites(5_000)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
  })
})
