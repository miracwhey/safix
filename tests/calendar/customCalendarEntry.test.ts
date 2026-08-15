/**
 * Custom Calendar Entry — Domain Contract Tests
 *
 * Verifies that custom calendar entries (kind: 'custom') are correctly
 * persisted, hydrated, and distinguished from job-derived entries.
 *
 * Coverage:
 *   T1  addCustomCalendarEntry stores title and description
 *   T2  description is '' when not provided (no undefined in INSERT)
 *   T3  entryToRow maps description to DB column
 *   T4  rowToEntry restores description on hydration
 *   T5  custom entry kind === 'custom', no jobId
 *   T6  job-derived entry description is always ''
 *   T7  custom entry INSERT payload has job_id null (23502 regression guard)
 *   T8  successful custom add records no persistence failure
 *   T9  derivePlanungTab.unassignedScheduled excludes custom entries
 *   T10 existing job-derived calendar entry tests remain unaffected
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn() }))

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
    return typeof e.code === 'string' && (e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42'))
  },
  isDuplicateKeyError: () => false,
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import { setCalendarRepository } from '../../src/lib/calendar/repository'
import { addCustomCalendarEntry } from '../../src/lib/calendar/calendarStore'
import { createCalendarEntryFromJob } from '../../src/lib/calendar/calendarEngine'
import { derivePlanungTab } from '../../src/lib/dashboard/operationsTabSelectors'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now()

function makeJob(overrides: Partial<{ id: string; title: string; status: string; providerId: string }> = {}) {
  return {
    id: overrides.id ?? 'job-uuid-1',
    title: overrides.title ?? 'Badezimmer renovieren',
    status: overrides.status ?? 'scheduled',
    providerId: overrides.providerId ?? 'prov-abc',
    customer: 'Mustermann',
    location: 'Berlin',
    dateLabel: 'Heute',
    amount: '1.500 €',
    assignedMemberIds: [],
  }
}

function freshRepo(providerId: string | null = 'prov-abc', hydrated = true): SupabaseCalendarRepository {
  const repo = new SupabaseCalendarRepository()
  ;(repo as unknown as { entries: CalendarEntry[] }).entries = []
  ;(repo as unknown as { currentProviderId: string | null }).currentProviderId = providerId
  ;(repo as unknown as { _hydrated: boolean })._hydrated = hydrated
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
  mockInsert.mockReset()
  mockInsert.mockResolvedValue({ error: null })
})

// ===========================================================================
// T1 — addCustomCalendarEntry stores title and description
// ===========================================================================

describe('T1 — addCustomCalendarEntry stores title and description', () => {
  it('returned entry carries the provided title and description', () => {
    freshRepo()
    const entry = addCustomCalendarEntry({
      title: 'Materialabholung',
      description: 'Bauschutt von Baustelle A abholen',
      dateKey: '2026-04-26',
      startsAtLabel: '08:00',
      endsAtLabel: '10:00',
    })
    expect(entry.title).toBe('Materialabholung')
    expect(entry.description).toBe('Bauschutt von Baustelle A abholen')
  })
})

// ===========================================================================
// T2 — description defaults to '' when not provided
// ===========================================================================

describe('T2 — description defaults to empty string when omitted', () => {
  it('entry.description is "" when description param is absent', () => {
    freshRepo()
    const entry = addCustomCalendarEntry({
      title: 'Bürozeit',
      dateKey: '2026-04-26',
      startsAtLabel: '09:00',
      endsAtLabel: '12:00',
    })
    expect(entry.description).toBe('')
  })
})

// ===========================================================================
// T3 — entryToRow maps description to DB column
// ===========================================================================

describe('T3 — entryToRow maps description into INSERT payload', () => {
  it('INSERT row carries description from the CalendarEntry', async () => {
    const repo = freshRepo('prov-abc')
    const entry: CalendarEntry = {
      id: 'entry-t3',
      kind: 'custom',
      providerId: 'prov-abc',
      title: 'Besprechung',
      description: 'Quartalszahlen besprechen',
      customerName: '',
      location: '',
      dateLabel: 'Heute',
      dateKey: '2026-04-26',
      startsAtLabel: '14:00',
      endsAtLabel: '15:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    await repo.add(entry)

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.description).toBe('Quartalszahlen besprechen')
  })
})

// ===========================================================================
// T4 — rowToEntry restores description on hydration
// ===========================================================================

describe('T4 — rowToEntry preserves description from DB row', () => {
  it('description from DB row is mapped back to CalendarEntry', async () => {
    const { supabase } = await import('../../src/lib/supabase')
    const dbRow = {
      id: 'entry-t4',
      job_id: null,
      provider_id: 'prov-abc',
      title: 'Urlaub',
      description: 'Urlaub in Bayern',
      customer_name: '',
      location: '',
      date_label: 'Mo. 27. Apr.',
      date_key: '2026-04-27',
      starts_at_label: '00:00',
      ends_at_label: '23:59',
      assigned_member_ids: [],
      status: 'scheduled',
      created_at: now,
      updated_at: now,
    }

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === 'calendar_entries') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue({ data: [dbRow], error: null }),
            }),
          }),
          insert: (payload: unknown) => mockInsert(payload),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        } as unknown as ReturnType<typeof supabase.from>
      }
      if (table === 'providers') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'prov-abc' }, error: null }),
            }),
          }),
        } as unknown as ReturnType<typeof supabase.from>
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
        } as unknown as ReturnType<typeof supabase.from>
      }
      return { select: vi.fn().mockReturnValue({ order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) }) } as unknown as ReturnType<typeof supabase.from>
    })

    const repo = new SupabaseCalendarRepository()
    await repo.initialize()

    const loaded = repo.getAll().find((e) => e.id === 'entry-t4')
    expect(loaded?.description).toBe('Urlaub in Bayern')
    expect(loaded?.kind).toBe('custom')
  })
})

// ===========================================================================
// T5 — Custom entry: kind === 'custom', no jobId
// ===========================================================================

describe('T5 — custom entry is kind custom and has no jobId', () => {
  it('kind is custom and jobId is undefined', () => {
    freshRepo()
    const entry = addCustomCalendarEntry({
      title: 'Blockerzeit',
      dateKey: '2026-04-26',
      startsAtLabel: '10:00',
      endsAtLabel: '11:00',
    })
    expect(entry.kind).toBe('custom')
    expect(entry.jobId).toBeUndefined()
  })
})

// ===========================================================================
// T6 — Job-derived entry description is always ''
// ===========================================================================

describe('T6 — job-derived entry description is empty string', () => {
  it('createCalendarEntryFromJob sets description to empty string', () => {
    const entry = createCalendarEntryFromJob(makeJob() as Parameters<typeof createCalendarEntryFromJob>[0])
    expect(entry.description).toBe('')
    expect(entry.kind).toBe('job')
  })
})

// ===========================================================================
// T7 — Custom entry INSERT: job_id null (23502 regression guard)
// ===========================================================================

describe('T7 — custom entry INSERT payload has job_id null (23502 regression)', () => {
  it('INSERT row has job_id null and provider_id set for custom entry', async () => {
    const repo = freshRepo('prov-abc')
    const entry: CalendarEntry = {
      id: 'entry-t7',
      kind: 'custom',
      providerId: 'prov-abc',
      title: 'Bauschutt entsorgen',
      description: '',
      customerName: '',
      location: '',
      dateLabel: 'Heute',
      dateKey: '2026-04-26',
      startsAtLabel: '07:00',
      endsAtLabel: '09:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    await repo.add(entry)

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_id).toBeNull()
    expect(row.provider_id).toBe('prov-abc')
  })
})

// ===========================================================================
// T8 — Successful custom add records no persistence failure
// ===========================================================================

describe('T8 — successful custom add: no SyncStatusBar failure', () => {
  it('no persistence failure recorded after successful INSERT', async () => {
    const repo = freshRepo('prov-abc')

    await repo.add({
      id: 'entry-t8',
      kind: 'custom',
      providerId: 'prov-abc',
      title: 'Materialkauf',
      description: '',
      customerName: '',
      location: '',
      dateLabel: 'Heute',
      dateKey: '2026-04-26',
      startsAtLabel: '11:00',
      endsAtLabel: '12:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    })

    expect(failureSet.size).toBe(0)
    expect(getEntries(repo).some((e) => e.id === 'entry-t8')).toBe(true)
  })
})

// ===========================================================================
// T9 — derivePlanungTab.unassignedScheduled excludes custom entries
// ===========================================================================

describe('T9 — unassignedScheduled excludes custom entries', () => {
  it('custom entry without assignedMemberIds is NOT counted as unassigned gap', () => {
    const customEntry: CalendarEntry = {
      id: 'custom-unassigned',
      kind: 'custom',
      providerId: 'prov-abc',
      title: 'Bürozeit',
      description: '',
      customerName: '',
      location: '',
      dateLabel: 'Heute',
      dateKey: new Date().toISOString().slice(0, 10),
      startsAtLabel: '09:00',
      endsAtLabel: '10:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    const result = derivePlanungTab([customEntry], new Date().toISOString().slice(0, 10), [])
    expect(result.unassignedScheduled).toHaveLength(0)
  })

  it('job entry without assignedMemberIds IS counted as unassigned gap', () => {
    const jobEntry: CalendarEntry = {
      id: 'job-unassigned',
      kind: 'job',
      jobId: 'job-1',
      providerId: 'prov-abc',
      title: 'Dacharbeiten',
      description: '',
      customerName: 'Herr Müller',
      location: 'Dach',
      dateLabel: 'Heute',
      dateKey: new Date().toISOString().slice(0, 10),
      startsAtLabel: '09:00',
      endsAtLabel: '10:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    const result = derivePlanungTab([jobEntry], new Date().toISOString().slice(0, 10), [])
    expect(result.unassignedScheduled).toHaveLength(1)
  })
})

// ===========================================================================
// T10 — Job-derived entries still persist with job_id set
// ===========================================================================

describe('T10 — job-derived entry INSERT preserves job_id', () => {
  it('INSERT row for a job entry carries job_id correctly', async () => {
    const repo = freshRepo('prov-abc')
    await repo.add({
      id: 'job-entry-t10',
      kind: 'job',
      jobId: 'job-abc',
      providerId: 'prov-abc',
      title: 'Elektroinstallation',
      description: '',
      customerName: 'Herr Weber',
      location: 'Hauptstr. 1',
      dateLabel: 'Heute',
      dateKey: '2026-04-26',
      startsAtLabel: '08:00',
      endsAtLabel: '16:00',
      assignedMemberIds: [],
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }, { passive: true })

    const row = mockInsert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_id).toBe('job-abc')
    expect(row.description).toBe('')
  })
})
