/**
 * Calendar Provider Injection — add() RLS fix
 *
 * Root cause: addCustomCalendarEntry() never passes providerId to
 * SupabaseCalendarRepository.add(). Without provider_id the INSERT fails the
 * calendar_entries_owner_insert RLS check (42501):
 *
 *   (provider_id IS NOT NULL AND provider IN owner list)
 *   OR (provider_id IS NULL AND job_id IN owned jobs)
 *
 * Custom entries have neither. Fix: add() injects currentProviderId (resolved
 * during initialize()) when the entry carries no providerId.
 *
 * Coverage:
 *   T1 add() with no providerId → INSERT payload carries currentProviderId
 *   T2 add() with no providerId → in-memory entry also has providerId set
 *   T3 add() with explicit providerId → that value is preserved (no override)
 *   T4 add() when currentProviderId is null → no injection, original null kept (verified via job entry)
 *   T5 add() success with injected providerId → entry in cache, no failure
 *   T6 add() server-side reject (42501) → entry reverted, failure recorded
 *   T7 user-initiated add() 42501 is NOT passive → failure surfaces to store
 *   T8 pre-flight guard: null currentProviderId + non-passive → no INSERT, no persistence failure
 *   T9 passive projection write (jobId set): pre-flight guard skipped → Supabase called
 *   T10 callerStore hydration guard: add before hydration → no INSERT
 *   T11 custom entry INSERT payload: job_id null + provider_id set (23502 regression)
 *   T12 job entry INSERT payload: job_id preserved (regression for job projections)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const { mockInsert, mockSelectEqSingle } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockSelectEqSingle: vi.fn(),
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
              single: () => mockSelectEqSingle(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: (payload: unknown) => mockInsert(payload),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }
      }
      if (table === 'providers') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'prov-abc' }, error: null }),
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
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'uid-owner' } } } }),
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
// Persistence mock
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
    return e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42')
  },
  isDuplicateKeyError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    return e.code === '23505'
  },
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import { setCalendarRepository } from '../../src/lib/calendar/repository'
import { addCustomCalendarEntry } from '../../src/lib/calendar/calendarStore'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RLS_VIOLATION = { code: '42501', message: 'new row violates row-level security policy' }

const now = Date.now()

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'entry-uuid-1',
    kind: 'custom',
    providerId: undefined,
    title: 'Baumarkt',
    description: '',
    customerName: '',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '2026-04-26',
    startsAtLabel: '09:00',
    endsAtLabel: '10:00',
    assignedMemberIds: [],
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function getEntries(repo: SupabaseCalendarRepository): CalendarEntry[] {
  return (repo as unknown as { entries: CalendarEntry[] }).entries
}

function setProviderId(repo: SupabaseCalendarRepository, id: string | null): void {
  ;(repo as unknown as { currentProviderId: string | null }).currentProviderId = id
}

function setHydrated(repo: SupabaseCalendarRepository, hydrated: boolean): void {
  ;(repo as unknown as { _hydrated: boolean })._hydrated = hydrated
}

function freshRepo(providerId: string | null = 'prov-abc', hydrated = true): SupabaseCalendarRepository {
  const repo = new SupabaseCalendarRepository()
  ;(repo as unknown as { entries: CalendarEntry[] }).entries = []
  setProviderId(repo, providerId)
  setHydrated(repo, hydrated)
  setCalendarRepository(repo)
  return repo
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  failureSet.clear()
  mockInsert.mockReset()
  mockSelectEqSingle.mockReset()
})

// ===========================================================================
// T1 — INSERT payload carries currentProviderId when entry has none
// ===========================================================================

describe('T1 — add() with no providerId: INSERT payload carries currentProviderId', () => {
  it('provider_id in DB row matches repo.currentProviderId', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: undefined }))

    expect(mockInsert).toHaveBeenCalledTimes(1)
    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.provider_id).toBe('prov-abc')
  })
})

// ===========================================================================
// T2 — In-memory entry also gets providerId set
// ===========================================================================

describe('T2 — add() with no providerId: in-memory entry has providerId', () => {
  it('local cache entry.providerId === currentProviderId after add()', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: undefined }))

    const cached = getEntries(repo).find((e) => e.id === 'entry-uuid-1')
    expect(cached?.providerId).toBe('prov-abc')
  })
})

// ===========================================================================
// T3 — Explicit providerId is preserved (no override)
// ===========================================================================

describe('T3 — add() with explicit providerId: that value is preserved', () => {
  it('INSERT uses the entry.providerId, not currentProviderId', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: 'prov-explicit' }))

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.provider_id).toBe('prov-explicit')
  })
})

// ===========================================================================
// T4 — No injection when currentProviderId is null
// ===========================================================================

describe('T4 — add() with null currentProviderId: original null preserved', () => {
  it('provider_id in INSERT row is null when repo has no resolved provider (job entry bypasses pre-flight)', async () => {
    const repo = freshRepo(null)
    mockInsert.mockResolvedValue({ error: null })

    // A job-based entry (jobId set) bypasses the pre-flight guard. This verifies
    // that no injection of currentProviderId occurs when currentProviderId is null.
    await repo.add(makeEntry({ providerId: undefined, jobId: 'job-xyz' }), { passive: true })

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.provider_id).toBeNull()
    expect(row.job_id).toBe('job-xyz')
  })
})

// ===========================================================================
// T5 — Successful add with injected providerId: entry stays in cache
// ===========================================================================

describe('T5 — add() success with injected providerId: entry persists', () => {
  it('entry is in cache and no failure is recorded', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: undefined }))

    expect(getEntries(repo).some((e) => e.id === 'entry-uuid-1')).toBe(true)
    expect(failureSet.size).toBe(0)
  })
})

// ===========================================================================
// T6 — Server-side reject (42501): entry reverted from cache
// ===========================================================================

describe('T6 — add() server-side 42501 reject: entry reverted', () => {
  it('entry not in cache after 42501; failure recorded', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: RLS_VIOLATION })

    await repo.add(makeEntry({ providerId: undefined })).catch(() => {})

    expect(getEntries(repo).some((e) => e.id === 'entry-uuid-1')).toBe(false)
    expect(failureSet.has('calendar:entry-uuid-1')).toBe(true)
  })
})

// ===========================================================================
// T7 — User-initiated add() 42501: failure surfaces (NOT passive)
// ===========================================================================

describe('T7 — user-initiated add() 42501 must NOT be silenced', () => {
  it('failure is recorded (not passive — no silent swallow for user actions)', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: RLS_VIOLATION })

    // No passive flag — user-initiated add must record the failure
    let threw = false
    await repo.add(makeEntry({ providerId: undefined })).catch(() => { threw = true })

    expect(threw).toBe(true)
    expect(failureSet.has('calendar:entry-uuid-1')).toBe(true)
  })
})

// ===========================================================================
// T8 — Pre-flight guard: null currentProviderId + non-passive → no INSERT
// ===========================================================================

describe('T8 — pre-flight guard: null currentProviderId, non-passive → no Supabase call', () => {
  it('add() reverts optimistic entry, throws, no INSERT, no persistence failure recorded', async () => {
    // currentProviderId is null (resolve hasn't completed) but repo is hydrated
    // — simulates the timing window where callerStore guard passed but provider
    // resolution was racing or the user has no provider scope.
    const repo = freshRepo(null)

    let threw = false
    await repo.add(makeEntry({ providerId: undefined })).catch(() => { threw = true })

    expect(threw).toBe(true)
    expect(mockInsert).not.toHaveBeenCalled()
    expect(getEntries(repo).some((e) => e.id === 'entry-uuid-1')).toBe(false)
    // Local pre-flight abort is NOT a DB rejection — no persistence failure loop.
    expect(failureSet.size).toBe(0)
  })
})

// ===========================================================================
// T9 — Passive projection write: pre-flight guard bypassed → Supabase called
// ===========================================================================

describe('T9 — passive projection write (jobId set): pre-flight guard skipped', () => {
  it('passive add() with jobId reaches Supabase even when currentProviderId is null', async () => {
    // Job-based projection entries: provider_id null is acceptable — RLS
    // allows them via (provider_id IS NULL AND job_id IN owned jobs).
    const repo = freshRepo(null)
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: undefined, jobId: 'job-abc' }), { passive: true })

    expect(mockInsert).toHaveBeenCalledTimes(1)
    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_id).toBe('job-abc')
    expect(row.provider_id).toBeNull()
  })
})

// ===========================================================================
// T10 — CallerStore hydration guard: add before hydration → no repo.add() call
// ===========================================================================

describe('T10 — callerStore hydration guard: add before hydration skips repo.add()', () => {
  it('addCustomCalendarEntry returns early when isHydrated() is false — no INSERT', async () => {
    // Repo is NOT hydrated (initialize() still in flight). The callerStore guard
    // must short-circuit before repo.add() is ever called so that no null
    // provider_id can reach Supabase, not even as a pre-flight throw.
    const repo = freshRepo('prov-abc', false)

    addCustomCalendarEntry({
      title: 'Baumarkt',
      dateKey: '2026-04-26',
      startsAtLabel: '09:00',
      endsAtLabel: '10:00',
    })

    // Flush microtask queue — repo.add() is void-fired if it's ever reached.
    await new Promise((r) => setTimeout(r, 0))

    expect(mockInsert).not.toHaveBeenCalled()
    expect(getEntries(repo)).toHaveLength(0)
  })
})

// ===========================================================================
// T11 — Custom entry INSERT payload: job_id null + provider_id set (23502 regression)
// ===========================================================================

describe('T11 — custom entry INSERT payload: job_id null, provider_id set (23502 regression)', () => {
  it('INSERT row for a custom entry has job_id null and provider_id from currentProviderId', async () => {
    // Regression for production error 23502:
    // "null value in column job_id violates not-null constraint"
    // Custom entries (kind: 'custom') must send job_id: null.
    // After the schema fix (job_id nullable), this INSERT succeeds.
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ providerId: undefined }))

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_id).toBeNull()
    expect(row.provider_id).toBe('prov-abc')
  })
})

// ===========================================================================
// T12 — Job entry INSERT payload: job_id preserved (regression for job projections)
// ===========================================================================

describe('T12 — job entry INSERT payload: job_id preserved', () => {
  it('INSERT row for a job-derived entry carries job_id — not overwritten by provider injection', async () => {
    const repo = freshRepo('prov-abc')
    mockInsert.mockResolvedValue({ error: null })

    await repo.add(makeEntry({ jobId: 'job-abc', kind: 'job', providerId: 'prov-abc' }), { passive: true })

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_id).toBe('job-abc')
    expect(row.provider_id).toBe('prov-abc')
  })
})
