/**
 * CalendarRepository.updateScheduling — Block 7.2.7a foundation tests.
 *
 * Verifies the narrow scheduling-update contract for both adapters:
 *   - InMemory: mutates only date_key/starts_at_label/ends_at_label/updatedAt,
 *               preserves provider_id/job_id/assignedMemberIds/status/title
 *               /description/customerName/location/dateLabel/createdAt.
 *   - Supabase: same in-cache behavior **plus** the wire payload to
 *               supabase.from('calendar_entries').update(...) contains only
 *               the four scheduling-related columns (date_key, starts_at_label,
 *               ends_at_label, updated_at). Identity / ownership columns are
 *               never re-sent.
 *
 * Missing entries: silent no-op for both adapters, mirroring replace() and
 * updateStatus() conventions.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase mock (Supabase-adapter-suite only) — capture .update() payload.
// ---------------------------------------------------------------------------

const { mockUpdate, mockUpdateEq } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
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
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: (payload: unknown) => {
            mockUpdate(payload)
            return {
              eq: (col: string, val: unknown) => {
                mockUpdateEq(col, val)
                return Promise.resolve({ error: null })
              },
            }
          },
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

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  hasPersistenceFailureForEntity: vi.fn().mockReturnValue(false),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'cal-entry-1',
    jobId: 'job-uuid-1',
    kind: 'job',
    providerId: 'prov-abc',
    title: 'Badezimmer renovieren',
    description: '',
    customerName: 'Mustermann',
    location: 'Hannover',
    dateLabel: 'Mo., 04.05.',
    dateKey: '2026-05-04',
    startsAtLabel: '08:00',
    endsAtLabel: '12:00',
    assignedMemberIds: ['tm-worker-1'],
    status: 'scheduled',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

// ===========================================================================
// InMemory adapter
// ===========================================================================

describe('InMemoryCalendarRepository.updateScheduling', () => {
  it('updates only dateKey / startsAtLabel / endsAtLabel and bumps updatedAt', async () => {
    const repo = new InMemoryCalendarRepository([makeEntry()])
    const before = repo.getById('cal-entry-1')!

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    const after = repo.getById('cal-entry-1')!
    expect(after.dateKey).toBe('2026-05-05')
    expect(after.startsAtLabel).toBe('09:30')
    expect(after.endsAtLabel).toBe('13:30')
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  it('preserves identity / ownership / display fields', async () => {
    const repo = new InMemoryCalendarRepository([makeEntry()])

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    const after = repo.getById('cal-entry-1')!
    expect(after.providerId).toBe('prov-abc')
    expect(after.jobId).toBe('job-uuid-1')
    expect(after.kind).toBe('job')
    expect(after.assignedMemberIds).toEqual(['tm-worker-1'])
    expect(after.status).toBe('scheduled')
    expect(after.title).toBe('Badezimmer renovieren')
    expect(after.description).toBe('')
    expect(after.customerName).toBe('Mustermann')
    expect(after.location).toBe('Hannover')
    expect(after.dateLabel).toBe('Mo., 04.05.')
    expect(after.createdAt).toBe(1_700_000_000_000)
  })

  it('notifies subscribers exactly once', async () => {
    const repo = new InMemoryCalendarRepository([makeEntry()])
    const listener = vi.fn()
    repo.subscribe(listener)

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('is a silent no-op when the entry id is not found', async () => {
    const repo = new InMemoryCalendarRepository([makeEntry()])
    const listener = vi.fn()
    repo.subscribe(listener)

    await expect(
      repo.updateScheduling('cal-entry-missing', {
        dateKey: '2026-05-05',
        startsAtLabel: '09:30',
        endsAtLabel: '13:30',
      }),
    ).resolves.toBeUndefined()

    // Existing entry is untouched
    expect(repo.getById('cal-entry-1')!.startsAtLabel).toBe('08:00')
    // Subscribers are still notified (cache-write convention is to notify
    // unconditionally — matches replace() / updateStatus() behavior).
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not affect other entries in the cache', async () => {
    const other = makeEntry({ id: 'cal-entry-2', dateKey: '2026-06-01' })
    const repo = new InMemoryCalendarRepository([makeEntry(), other])

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    expect(repo.getById('cal-entry-2')!.dateKey).toBe('2026-06-01')
    expect(repo.getById('cal-entry-2')!.startsAtLabel).toBe('08:00')
  })
})

// ===========================================================================
// Supabase adapter — wire payload shape
// ===========================================================================

describe('SupabaseCalendarRepository.updateScheduling — wire payload', () => {
  beforeEach(() => {
    mockUpdate.mockReset()
    mockUpdateEq.mockReset()
  })

  function freshRepo(): SupabaseCalendarRepository {
    const repo = new SupabaseCalendarRepository()
    ;(repo as unknown as { entries: CalendarEntry[] }).entries = [makeEntry()]
    ;(repo as unknown as { _hydrated: boolean })._hydrated = true
    return repo
  }

  it('sends only date_key / starts_at_label / ends_at_label / updated_at', async () => {
    const repo = freshRepo()

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const payload = mockUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(
      ['date_key', 'ends_at_label', 'starts_at_label', 'updated_at'].sort(),
    )
    expect(payload.date_key).toBe('2026-05-05')
    expect(payload.starts_at_label).toBe('09:30')
    expect(payload.ends_at_label).toBe('13:30')
    expect(typeof payload.updated_at).toBe('number')
  })

  it('does NOT include identity / ownership columns in the update payload', async () => {
    const repo = freshRepo()

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    const payload = mockUpdate.mock.calls[0][0] as Record<string, unknown>
    // None of these RLS-sensitive / identity columns may travel on the wire.
    for (const forbidden of [
      'provider_id',
      'job_id',
      'assigned_member_ids',
      'status',
      'title',
      'description',
      'customer_name',
      'location',
      'date_label',
      'created_at',
      'id',
    ]) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  })

  it('targets the row by id via .eq("id", id)', async () => {
    const repo = freshRepo()

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'cal-entry-1')
  })

  it('updates the in-memory cache like the InMemory adapter', async () => {
    const repo = freshRepo()

    await repo.updateScheduling('cal-entry-1', {
      dateKey: '2026-05-05',
      startsAtLabel: '09:30',
      endsAtLabel: '13:30',
    })

    const cached = (repo as unknown as { entries: CalendarEntry[] }).entries[0]
    expect(cached.dateKey).toBe('2026-05-05')
    expect(cached.startsAtLabel).toBe('09:30')
    expect(cached.endsAtLabel).toBe('13:30')
    // Preserved
    expect(cached.providerId).toBe('prov-abc')
    expect(cached.jobId).toBe('job-uuid-1')
    expect(cached.assignedMemberIds).toEqual(['tm-worker-1'])
    expect(cached.status).toBe('scheduled')
    expect(cached.title).toBe('Badezimmer renovieren')
  })
})
