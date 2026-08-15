/**
 * Block I-Sync-3 — Passive projection writes must not escalate to user banner.
 *
 * Root cause:
 *
 *   syncCalendarEntriesForJobs is called by ALL craftsmen (owners AND workers)
 *   from subscribeJobs callbacks.  Workers have no INSERT policy on
 *   calendar_entries — their add() calls fail with 42501 (RLS violation, class
 *   42 → 'permission-denied' → isPermanentKind → immediate banner).  Owners may
 *   also see updateStatus() fail for out-of-scope entries.
 *
 *   These writes are system-initiated projections, not user actions.  Before
 *   this fix, failures landed in persistenceErrorStore via recordPersistenceFailure
 *   and caused the SyncStatusBar banner to appear on every iOS resume / realtime
 *   reconnect — the user read "Erneut versuchen" as a no-op.
 *
 * Fix (CalendarWriteOpts.passive):
 *
 *   All projection write sites (syncCalendarEntriesForJobs, ensureCalendarEntryForJob)
 *   pass { passive: true } to add() and updateStatus().  On failure the repository
 *   logs to observability only — no recordPersistenceFailure, no
 *   enqueuePendingMutation, no throw.  User-initiated writes (updateCalendarStatus,
 *   addCustomCalendarEntry, …) remain unchanged.
 *
 * Coverage:
 *
 *   T1 Passive updateStatus (projection) with RLS error → no failure in store
 *   T2 Non-passive updateStatus (user-initiated) with RLS error → failure recorded
 *   T3 Passive add() with INSERT server-side error → no failure, optimistic insert reverted
 *   T4 Passive add() success → entry persists in local cache
 *   T5 After passive updateStatus failure, optimistic update applied → idempotency:
 *      next syncCalendarEntriesForJobs sees status match → no second write
 *   T6 Passive transient (non-server-side) failure → no failure in store
 *   T7 hasPersistenceFailureForEntity guard still blocks retries for pre-recorded
 *      failures (guard survives the passive refactor)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const { mockUpdateEq, mockInsert } = vi.hoisted(() => ({
  mockUpdateEq: vi.fn(),
  mockInsert: vi.fn(),
}))

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
          insert: (payload: unknown) => mockInsert(payload),
          update: vi.fn().mockReturnValue({
            eq: (col: string, val: string) => mockUpdateEq(col, val),
          }),
        }
      }
      if (table === 'providers') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'prov-1' }, error: null }),
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
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
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

// ---------------------------------------------------------------------------
// Persistence mock — shared in-memory failure store
// ---------------------------------------------------------------------------

const failureSet = new Set<string>()

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn().mockImplementation(
    (input: { domain: string; entityId: string }) => {
      failureSet.add(`${input.domain}:${input.entityId}`)
    },
  ),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  hasPersistenceFailureForEntity: (domain: string, entityId: string) =>
    failureSet.has(`${domain}:${entityId}`),
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import {
  setCalendarRepository,
  drainCalendarInFlightWrites,
} from '../../src/lib/calendar/repository'
import {
  syncCalendarEntriesForJobs,
  updateCalendarStatus,
} from '../../src/lib/calendar/calendarStore'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now()
const RLS_VIOLATION = { code: '42501', message: 'new row violates row-level security policy' }
const TRANSIENT_ERROR = { code: 'PGRST301', message: 'Connection reset' }

function makeJob(id: string, status: Job['status']): Job {
  return {
    id,
    title: 'Test Job',
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
    title: 'Test Job',
    customerName: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '2026-04-26',
    startsAtLabel: '09:00',
    endsAtLabel: '10:00',
    assignedMemberIds: [],
    status,
    createdAt: now,
    updatedAt: now,
  }
}

function freshRepo(initialEntries: CalendarEntry[] = []): SupabaseCalendarRepository {
  const repo = new SupabaseCalendarRepository()
  ;(repo as unknown as { entries: CalendarEntry[] }).entries = initialEntries
  setCalendarRepository(repo)
  return repo
}

function getEntries(repo: SupabaseCalendarRepository): CalendarEntry[] {
  return (repo as unknown as { entries: CalendarEntry[] }).entries
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  failureSet.clear()
  mockUpdateEq.mockReset()
  mockInsert.mockReset()
})

// ===========================================================================
// T1 — Passive updateStatus with RLS error → no failure in store
// ===========================================================================

describe('T1 — passive updateStatus (projection) with RLS error leaves no failure in store', () => {
  it('syncCalendarEntriesForJobs writes passively — RLS 42501 must not reach banner', async () => {
    freshRepo([makeEntry('job-1', 'in_progress')])
    mockUpdateEq.mockResolvedValue({ error: RLS_VIOLATION })

    // Triggers passive updateStatus (in_progress → completed)
    syncCalendarEntriesForJobs([makeJob('job-1', 'completed')])
    await drainCalendarInFlightWrites(500)

    expect(failureSet.size).toBe(0)
  })
})

// ===========================================================================
// T2 — Non-passive updateStatus (user-initiated) records failure
// ===========================================================================

describe('T2 — non-passive updateStatus (user-initiated) with RLS error records failure', () => {
  it('updateCalendarStatus without passive flag → failure lands in persistenceErrorStore', async () => {
    freshRepo([makeEntry('job-2', 'in_progress')])
    mockUpdateEq.mockResolvedValue({ error: RLS_VIOLATION })

    // User-initiated call — no passive flag
    await updateCalendarStatus('job-2', 'completed').catch(() => {})
    await drainCalendarInFlightWrites(500)

    expect(failureSet.has('calendar:job-2')).toBe(true)
  })
})

// ===========================================================================
// T3 — Passive add() with server-side INSERT failure: no failure, insert reverted
// ===========================================================================

describe('T3 — passive add() with INSERT server error: no failure recorded, optimistic insert reverted', () => {
  it('worker INSERT 42501 via syncCalendarEntriesForJobs → entry not in cache, no banner', async () => {
    // Empty repo — will trigger insert path for a calendar-relevant job
    const repo = freshRepo([])
    mockInsert.mockResolvedValue({ error: RLS_VIOLATION })

    // scheduled is calendar-relevant (isCalendarRelevantJob = true)
    syncCalendarEntriesForJobs([makeJob('job-3', 'scheduled')])
    await drainCalendarInFlightWrites(500)

    // No failure recorded
    expect(failureSet.size).toBe(0)
    // Optimistic insert was reverted — entry not in local cache
    expect(getEntries(repo).some((e) => e.jobId === 'job-3')).toBe(false)
  })
})

// ===========================================================================
// T4 — Passive add() success: entry stays in cache
// ===========================================================================

describe('T4 — passive add() success: entry persists in local cache', () => {
  it('successful passive insert → entry visible in repo, no failure', async () => {
    const repo = freshRepo([])
    mockInsert.mockResolvedValue({ error: null })

    syncCalendarEntriesForJobs([makeJob('job-4', 'scheduled')])
    await drainCalendarInFlightWrites(500)

    expect(failureSet.size).toBe(0)
    expect(getEntries(repo).some((e) => e.jobId === 'job-4')).toBe(true)
  })
})

// ===========================================================================
// T5 — Idempotency after passive failure: optimistic update prevents second write
// ===========================================================================

describe('T5 — idempotency: optimistic update after passive failure prevents second write', () => {
  it('second syncCalendarEntriesForJobs call skips write because local status matches', async () => {
    freshRepo([makeEntry('job-5', 'in_progress')])
    // First write fails (passive, class 42 → no failure recorded)
    mockUpdateEq.mockResolvedValue({ error: RLS_VIOLATION })

    // First call: derivedStatus 'completed' ≠ 'in_progress' → passive updateStatus fires
    syncCalendarEntriesForJobs([makeJob('job-5', 'completed')])
    // Optimistic update is synchronous — local entry.status = 'completed' immediately

    // Let the async write settle
    await drainCalendarInFlightWrites(500)

    mockUpdateEq.mockClear()

    // Second call: local entry.status = 'completed' === derivedStatus 'completed' → no write
    syncCalendarEntriesForJobs([makeJob('job-5', 'completed')])
    await drainCalendarInFlightWrites(100)

    expect(mockUpdateEq).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// T6 — Passive transient (non-server-side) failure: no failure in store
// ===========================================================================

describe('T6 — passive transient failure (non-class-42) leaves no failure in store', () => {
  it('non-RLS updateStatus failure with passive=true is silently absorbed', async () => {
    freshRepo([makeEntry('job-6', 'in_progress')])
    // Transient error — not class 42, not class 23
    mockUpdateEq.mockResolvedValue({ error: TRANSIENT_ERROR })

    syncCalendarEntriesForJobs([makeJob('job-6', 'completed')])
    await drainCalendarInFlightWrites(500)

    // No failure recorded for passive transient path
    expect(failureSet.size).toBe(0)
  })
})

// ===========================================================================
// T7 — hasPersistenceFailureForEntity guard blocks retries for pre-recorded failures
// ===========================================================================

describe('T7 — hasPersistenceFailureForEntity guard skips write when failure pre-recorded', () => {
  it('syncCalendarEntriesForJobs skips write when entity already has a recorded failure', async () => {
    freshRepo([makeEntry('job-7', 'in_progress')])
    // Pre-record a failure (simulates prior non-passive write failure or explicit record)
    failureSet.add('calendar:job-7')

    mockUpdateEq.mockResolvedValue({ error: null })

    syncCalendarEntriesForJobs([makeJob('job-7', 'completed')])
    await drainCalendarInFlightWrites(100)

    // Guard must have fired — no write attempted
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('guard fires for INSERT path too: no add() when created entry id has recorded failure', async () => {
    // Empty repo — would normally trigger add() for calendar-relevant job
    freshRepo([])
    // Pre-record failure for the entry id that createCalendarEntryFromJob would produce
    failureSet.add('calendar:job-8')

    mockInsert.mockResolvedValue({ error: null })

    syncCalendarEntriesForJobs([makeJob('job-8', 'scheduled')])
    await drainCalendarInFlightWrites(100)

    // Guard fired — no insert attempted
    expect(mockInsert).not.toHaveBeenCalled()
  })
})
