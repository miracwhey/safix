/**
 * Scheduling Realtime Propagation Tests
 *
 * Validates that SupabaseCalendarRepository and SupabaseScheduleRepository
 * respond to Supabase Realtime INSERT/UPDATE events — without a manual reload.
 *
 * Approach: mocks the Supabase client so tests can trigger channel events
 * directly without a live Supabase connection.  The mock captures INSERT and
 * UPDATE handlers registered by each repository so tests can call them with
 * synthetic payloads.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- Hoisted mock state -------------------------------------------------------

interface ChannelCapture {
  name: string
  insertHandler: ((payload: { new: unknown }) => void) | null
  updateHandler: ((payload: { new: unknown }) => void) | null
  statusCallback: ((status: string) => void) | null
  channelRef: unknown
}

const mockState = vi.hoisted(() => ({
  channels: [] as ChannelCapture[],
  removedChannels: [] as unknown[],
  authListener: null as ((event: string, session: unknown) => void) | null,
  fromCallCount: 0,
}))

// --- Supabase mock ------------------------------------------------------------

vi.mock('../../src/lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'uid-test' } } },
        }),
        onAuthStateChange: vi.fn().mockImplementation((cb: (event: string, session: unknown) => void) => {
          mockState.authListener = cb
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: vi.fn().mockImplementation((table: string): any => {
        mockState.fromCallCount++
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q: any = {
          select: () => q,
          eq: () => q,
          or: () => q,
          order: () => q,
          limit: () => Promise.resolve({ data: [], error: null }),
          // providers table returns a provider row so Calendar proceeds to realtime
          maybeSingle: () => Promise.resolve({
            data: table === 'providers' ? { id: 'provider-test' } : null,
            error: null,
          }),
          insert: () => Promise.resolve({ error: null }),
          update: () => q,
          delete: () => q,
          then: (resolve: (v: { error: null }) => void) => Promise.resolve({ error: null }).then(resolve),
        }
        return q
      }),
      channel: vi.fn().mockImplementation((name: string) => {
        const cap: ChannelCapture = {
          name,
          insertHandler: null,
          updateHandler: null,
          statusCallback: null,
          channelRef: null,
        }
        mockState.channels.push(cap)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ch: any = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          on: (_type: string, filter: any, handler: (payload: { new: unknown }) => void) => {
            if (filter.event === 'INSERT') cap.insertHandler = handler
            else if (filter.event === 'UPDATE') cap.updateHandler = handler
            return ch
          },
          subscribe: (cb: (status: string) => void) => {
            cap.statusCallback = cb
            cap.channelRef = ch
            return ch
          },
        }
        return ch
      }),
      removeChannel: vi.fn().mockImplementation((ch: unknown) => {
        mockState.removedChannels.push(ch)
        return Promise.resolve()
      }),
    },
  }
})

// Mock observability to suppress test output noise
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarning: vi.fn(),
  logBreadcrumb: vi.fn(),
}))

// Mock persistence failure recording
vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

// Imports after vi.mock calls
import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import { SupabaseScheduleRepository } from '../../src/lib/operations/repository/SupabaseScheduleRepository'

// --- Row fixture helpers -------------------------------------------------------

function makeCalendarEntryRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    job_id: 'job-1',
    kind: 'job',
    provider_id: 'provider-test',
    title: 'Test Entry',
    customer_name: 'Kunde',
    location: 'Berlin',
    date_label: 'Heute',
    date_key: '2026-04-17',
    starts_at_label: '09:00',
    ends_at_label: '11:00',
    assigned_member_ids: [] as string[],
    status: 'scheduled',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  }
}

function makeScheduleRow(id: string, jobId = 'job-1', status = 'scheduled') {
  const now = Date.now()
  return {
    id,
    job_id: jobId,
    scheduled_start: now,
    scheduled_end: now + 7200000,
    execution_window: 120,
    scheduling_status: status,
    created_at: now,
    updated_at: now,
  }
}

/** Find the most recently created channel by name prefix */
function latestChannel(prefix: string): ChannelCapture {
  const matches = mockState.channels.filter((c) => c.name.startsWith(prefix))
  return matches[matches.length - 1]
}

// =============================================================================
// SupabaseCalendarRepository
// =============================================================================

describe('SupabaseCalendarRepository — Realtime', () => {
  let repo: SupabaseCalendarRepository

  beforeEach(async () => {
    mockState.channels = []
    mockState.removedChannels = []
    mockState.authListener = null
    mockState.fromCallCount = 0
    repo = new SupabaseCalendarRepository()
    await repo.initialize()
  })

  // ── INSERT events ────────────────────────────────────────────────────────

  describe('INSERT events', () => {
    it('adds new entry to cache and notifies subscribers', () => {
      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      const ch = latestChannel('fixup-calendar-')
      expect(ch).toBeDefined()

      const row = makeCalendarEntryRow('cal-new')
      ch.insertHandler!({ new: row })

      expect(repo.getAll().some((e) => e.id === 'cal-new')).toBe(true)
      expect(listener).toHaveBeenCalledOnce()
    })

    it('deduplicates INSERT — drops event if entry already in cache', () => {
      const ch = latestChannel('fixup-calendar-')
      const row = makeCalendarEntryRow('cal-dup')

      // First insert
      ch.insertHandler!({ new: row })
      const countAfterFirst = repo.getAll().length

      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      // Second insert same ID
      ch.insertHandler!({ new: row })

      expect(repo.getAll().length).toBe(countAfterFirst)
      expect(listener).not.toHaveBeenCalled()
    })
  })

  // ── UPDATE events ────────────────────────────────────────────────────────

  describe('UPDATE events', () => {
    it('replaces existing entry and notifies subscribers', () => {
      const ch = latestChannel('fixup-calendar-')
      // First insert the entry
      ch.insertHandler!({ new: makeCalendarEntryRow('cal-upd', { status: 'scheduled' }) })

      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      // Now update it
      const updatedRow = makeCalendarEntryRow('cal-upd', {
        status: 'in_progress',
        assigned_member_ids: ['m-1'],
      })
      ch.updateHandler!({ new: updatedRow })

      const found = repo.getAll().find((e) => e.id === 'cal-upd')
      expect(found?.status).toBe('in_progress')
      expect(found?.assignedMemberIds).toContain('m-1')
      expect(listener).toHaveBeenCalledOnce()
    })

    it('adds entry on UPDATE if not already in cache (add-if-missing)', () => {
      const ch = latestChannel('fixup-calendar-')
      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      const row = makeCalendarEntryRow('cal-missing')
      ch.updateHandler!({ new: row })

      expect(repo.getAll().some((e) => e.id === 'cal-missing')).toBe(true)
      expect(listener).toHaveBeenCalledOnce()
    })
  })

  // ── Subscription lifecycle ────────────────────────────────────────────────

  describe('Subscription lifecycle', () => {
    it('startRealtimeSubscription is idempotent — removes old channel before creating new', async () => {
      // Auth state change triggers loadForUser again → startRealtimeSubscription called twice
      const channelsBefore = mockState.channels.length
      const removedBefore = mockState.removedChannels.length

      // Simulate re-initialization → startRealtimeSubscription (removes old, creates new)
      await repo.initialize()

      // A new channel was created
      expect(mockState.channels.length).toBeGreaterThan(channelsBefore)
      // The old channel was removed
      expect(mockState.removedChannels.length).toBeGreaterThan(removedBefore)
    })

    it('SIGNED_OUT clears cache and removes channel', () => {
      // Insert something first
      const ch = latestChannel('fixup-calendar-')
      ch.insertHandler!({ new: makeCalendarEntryRow('cal-x') })
      expect(repo.getAll().length).toBeGreaterThan(0)

      const removedBefore = mockState.removedChannels.length

      mockState.authListener!('SIGNED_OUT', null)

      expect(repo.getAll()).toHaveLength(0)
      expect(mockState.removedChannels.length).toBeGreaterThan(removedBefore)
    })

    it('SIGNED_IN triggers re-fetch and starts new realtime subscription', async () => {
      const channelsBefore = mockState.channels.length

      mockState.authListener!('SIGNED_IN', { user: { id: 'uid-other' } })
      await new Promise((r) => setTimeout(r, 0))

      expect(mockState.channels.length).toBeGreaterThan(channelsBefore)
      const newCh = latestChannel('fixup-calendar-')
      expect(newCh.name).toBe('fixup-calendar-uid-other')
    })
  })

  // ── Fallback refresh ──────────────────────────────────────────────────────

  describe('Fallback refresh', () => {
    it('re-fetches calendar entries on CHANNEL_ERROR', async () => {
      const fromCountBefore = mockState.fromCallCount

      const ch = latestChannel('fixup-calendar-')
      ch.statusCallback!('CHANNEL_ERROR')
      await new Promise((r) => setTimeout(r, 0))

      // fetchCalendarEntriesFromDatabase was called again (re-fetch)
      expect(mockState.fromCallCount).toBeGreaterThan(fromCountBefore)
    })
  })
})

// =============================================================================
// SupabaseScheduleRepository
// =============================================================================

describe('SupabaseScheduleRepository — Realtime', () => {
  let repo: SupabaseScheduleRepository

  beforeEach(async () => {
    mockState.channels = []
    mockState.removedChannels = []
    mockState.authListener = null
    mockState.fromCallCount = 0
    repo = new SupabaseScheduleRepository()
    await repo.initialize()
  })

  // ── INSERT events ────────────────────────────────────────────────────────

  describe('INSERT events', () => {
    it('adds new schedule to cache and notifies subscribers', () => {
      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      const ch = latestChannel('fixup-schedules-')
      expect(ch).toBeDefined()

      const row = makeScheduleRow('sched-new')
      ch.insertHandler!({ new: row })

      expect(repo.getAll().some((s) => s.id === 'sched-new')).toBe(true)
      expect(listener).toHaveBeenCalledOnce()
    })

    it('deduplicates INSERT — drops event if schedule already in cache', () => {
      const ch = latestChannel('fixup-schedules-')
      const row = makeScheduleRow('sched-dup')

      ch.insertHandler!({ new: row })
      const countAfterFirst = repo.getAll().length

      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      ch.insertHandler!({ new: row })

      expect(repo.getAll().length).toBe(countAfterFirst)
      expect(listener).not.toHaveBeenCalled()
    })
  })

  // ── UPDATE events ────────────────────────────────────────────────────────

  describe('UPDATE events', () => {
    it('replaces existing schedule and notifies subscribers', () => {
      const ch = latestChannel('fixup-schedules-')
      ch.insertHandler!({ new: makeScheduleRow('sched-upd', 'job-1', 'scheduled') })

      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      const updatedRow = makeScheduleRow('sched-upd', 'job-1', 'execution_started')
      ch.updateHandler!({ new: updatedRow })

      const found = repo.getAll().find((s) => s.id === 'sched-upd')
      expect(found?.schedulingStatus).toBe('execution_started')
      expect(listener).toHaveBeenCalledOnce()
    })

    it('adds schedule on UPDATE if not already in cache (add-if-missing)', () => {
      const ch = latestChannel('fixup-schedules-')
      const listener = vi.fn()
      repo.subscribe(listener)
      listener.mockClear()

      const row = makeScheduleRow('sched-missing')
      ch.updateHandler!({ new: row })

      expect(repo.getAll().some((s) => s.id === 'sched-missing')).toBe(true)
      expect(listener).toHaveBeenCalledOnce()
    })
  })

  // ── Subscription lifecycle ────────────────────────────────────────────────

  describe('Subscription lifecycle', () => {
    it('startRealtimeSubscription is idempotent — removes old channel before creating new', async () => {
      const channelsBefore = mockState.channels.length
      const removedBefore = mockState.removedChannels.length

      await repo.initialize()

      expect(mockState.channels.length).toBeGreaterThan(channelsBefore)
      expect(mockState.removedChannels.length).toBeGreaterThan(removedBefore)
    })

    it('SIGNED_OUT clears cache and removes channel', () => {
      const ch = latestChannel('fixup-schedules-')
      ch.insertHandler!({ new: makeScheduleRow('sched-x') })
      expect(repo.getAll().length).toBeGreaterThan(0)

      const removedBefore = mockState.removedChannels.length

      mockState.authListener!('SIGNED_OUT', null)

      expect(repo.getAll()).toHaveLength(0)
      expect(mockState.removedChannels.length).toBeGreaterThan(removedBefore)
    })

    it('SIGNED_IN triggers re-fetch and starts new realtime subscription', async () => {
      const channelsBefore = mockState.channels.length

      mockState.authListener!('SIGNED_IN', { user: { id: 'uid-other' } })
      await new Promise((r) => setTimeout(r, 0))

      expect(mockState.channels.length).toBeGreaterThan(channelsBefore)
      const newCh = latestChannel('fixup-schedules-')
      expect(newCh.name).toBe('fixup-schedules-uid-other')
    })
  })

  // ── Fallback refresh ──────────────────────────────────────────────────────

  describe('Fallback refresh', () => {
    it('re-fetches schedules on CHANNEL_ERROR', async () => {
      const fromCountBefore = mockState.fromCallCount

      const ch = latestChannel('fixup-schedules-')
      ch.statusCallback!('CHANNEL_ERROR')
      await new Promise((r) => setTimeout(r, 0))

      // fetchSchedulesFromDatabase was called again
      expect(mockState.fromCallCount).toBeGreaterThan(fromCountBefore)
    })
  })
})
