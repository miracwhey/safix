/**
 * Realtime channel lifecycle tests — intentional vs unexpected teardown,
 * stale payload callback isolation, and stale async refresh continuations.
 *
 * 1. Intentional channel replacement (token refresh, re-init, SIGNED_OUT)
 *    must not trigger fallbackRefresh or reconnect from the old channel's
 *    async CLOSED status callback.
 *
 * 2. Stale data payload callbacks (INSERT/UPDATE) on an old channel must
 *    not mutate the cache or notify subscribers after the channel was
 *    intentionally replaced or cleared.
 *
 * 3. In-flight DB fetches started before SIGNED_OUT or account-switch must
 *    not write to cache or call startRealtimeSubscription when they resolve.
 *
 * Core invariant: no old callback — status, data, or async continuation —
 * can affect repository state after it has been superseded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted mock state ────────────────────────────────────────────────────────

interface ChannelCapture {
  name: string
  statusCallback: ((status: string) => void) | null
  /** First INSERT handler registered on this channel (first table wins). */
  insertHandler: ((payload: { new: unknown }) => void) | null
  /** First UPDATE handler registered on this channel (first table wins). */
  updateHandler: ((payload: { new: unknown }) => void) | null
}

const mockState = vi.hoisted(() => ({
  channels: [] as ChannelCapture[],
  removedChannels: [] as unknown[],
  authListener: null as ((event: string, session: unknown) => void) | null,
  /** When true, limit() returns a promise that won't resolve until unblocked. */
  blockQueries: false,
  /** Resolvers for blocked limit() calls — call each to unblock one query. */
  pendingQueryResolvers: [] as Array<() => void>,
}))

// ── Supabase mock ─────────────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeFluentQuery = (): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      or: () => q,
      order: () => q,
      limit: () => {
        if (mockState.blockQueries) {
          return new Promise<{ data: never[]; error: null }>((resolve) => {
            mockState.pendingQueryResolvers.push(() => resolve({ data: [], error: null }))
          })
        }
        return Promise.resolve({ data: [], error: null })
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => Promise.resolve({ error: null }),
      update: () => q,
      delete: () => q,
      then: (resolve: (v: { error: null }) => void) => Promise.resolve({ error: null }).then(resolve),
    }
    return q
  }

  return {
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'uid-lifecycle' } } },
        }),
        onAuthStateChange: vi.fn().mockImplementation((cb: (event: string, session: unknown) => void) => {
          mockState.authListener = cb
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        }),
      },
      from: vi.fn().mockImplementation(makeFluentQuery),
      channel: vi.fn().mockImplementation((name: string) => {
        const cap: ChannelCapture = { name, statusCallback: null, insertHandler: null, updateHandler: null }
        mockState.channels.push(cap)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ch: any = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          on: (_type: string, filter: any, handler: (payload: { new: unknown }) => void) => {
            // Capture the first INSERT and first UPDATE handler registered
            // (first-table wins — sufficient for lifecycle / payload tests).
            if (filter.event === 'INSERT' && !cap.insertHandler) cap.insertHandler = handler
            if (filter.event === 'UPDATE' && !cap.updateHandler) cap.updateHandler = handler
            return ch
          },
          subscribe: (cb: (status: string) => void) => {
            cap.statusCallback = cb
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

vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarning: vi.fn(),
  logBreadcrumb: vi.fn(),
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

// These imports must come AFTER the vi.mock calls
import { supabase } from '../../src/lib/supabase'
import { SupabaseEscrowPlanRepository } from '../../src/lib/payments/escrow/SupabaseEscrowPlanRepository'
import { SupabaseFundingRequestRepository } from '../../src/lib/payments/fundingRequest/SupabaseFundingRequestRepository'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flush the microtask queue. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** Most recently created channel matching a name prefix. */
function latestChannel(prefix: string): ChannelCapture {
  const ch = [...mockState.channels].reverse().find((c) => c.name.startsWith(prefix))
  if (!ch) throw new Error(`No channel found for prefix: ${prefix}`)
  return ch
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Realtime Channel Lifecycle — intentional vs unexpected teardown', () => {
  beforeEach(() => {
    mockState.channels.length = 0
    mockState.removedChannels.length = 0
    mockState.authListener = null
    mockState.blockQueries = false
    mockState.pendingQueryResolvers.length = 0
    vi.mocked(supabase.from).mockClear()
  })

  // ── EscrowPlanRepository ──────────────────────────────────────────────────

  describe('SupabaseEscrowPlanRepository', () => {
    it('old channel CLOSED after token refresh does not trigger fallbackRefresh', async () => {
      const repo = new SupabaseEscrowPlanRepository()
      await repo.initialize()

      // Capture the original channel (generation 1)
      const originalChannel = mockState.channels[0]
      expect(originalChannel).toBeTruthy()

      // Simulate re-initialization → startRealtimeSubscription (removes old channel, creates new)
      await repo.initialize()

      expect(mockState.channels.length).toBe(2)

      // Record from() calls after the refresh reload (fetchAndLoadFromDatabase)
      const fromCallsAfterRefresh = vi.mocked(supabase.from).mock.calls.length

      // Old channel fires CLOSED asynchronously (simulating Supabase's teardown)
      originalChannel.statusCallback!('CLOSED')
      await tick()

      // No additional from() calls — fallbackRefresh must NOT have run
      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfterRefresh)
      // No extra channel was created by a spurious reconnect
      expect(mockState.channels.length).toBe(2)
    })

    it('old channel CLOSED after SIGNED_OUT does not trigger fallbackRefresh', async () => {
      const repo = new SupabaseEscrowPlanRepository()
      await repo.initialize()

      const originalChannel = mockState.channels[0]

      // Trigger sign-out → resetState (increments generation)
      mockState.authListener!('SIGNED_OUT', null)
      await tick()

      const fromCallsAfterSignOut = vi.mocked(supabase.from).mock.calls.length

      // Old channel fires CLOSED
      originalChannel.statusCallback!('CLOSED')
      await tick()

      // No fallbackRefresh, no new channel
      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfterSignOut)
      expect(mockState.channels.length).toBe(1)
    })

    it('unexpected CLOSED on current channel triggers fallbackRefresh', async () => {
      const repo = new SupabaseEscrowPlanRepository()
      await repo.initialize()

      const currentChannel = latestChannel('fixup-escrow-plans-')
      const fromCallsBefore = vi.mocked(supabase.from).mock.calls.length

      // Unexpected disconnect — generation matches, so error handling should run
      currentChannel.statusCallback!('CLOSED')
      await tick()

      // fallbackRefresh must have called fetchAndLoadFromDatabase → supabase.from
      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(fromCallsBefore)
    })

    it('unexpected CHANNEL_ERROR on current channel triggers fallbackRefresh', async () => {
      const repo = new SupabaseEscrowPlanRepository()
      await repo.initialize()

      const currentChannel = latestChannel('fixup-escrow-plans-')
      const fromCallsBefore = vi.mocked(supabase.from).mock.calls.length

      currentChannel.statusCallback!('CHANNEL_ERROR')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(fromCallsBefore)
    })

    it('multiple token refreshes do not accumulate stale reconnect schedules', async () => {
      const repo = new SupabaseEscrowPlanRepository()
      await repo.initialize()

      // Two consecutive re-initializations
      await repo.initialize()
      await repo.initialize()

      // Three channels total (initial + 2 re-inits)
      expect(mockState.channels.length).toBe(3)

      const fromCallsAfter = vi.mocked(supabase.from).mock.calls.length

      // Fire CLOSED on the first two (stale) channels
      mockState.channels[0].statusCallback!('CLOSED')
      mockState.channels[1].statusCallback!('CLOSED')
      await tick()

      // No spurious fallback from stale callbacks
      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfter)
      // No extra channel from spurious reconnect
      expect(mockState.channels.length).toBe(3)
    })
  })

  // ── FundingRequestRepository ──────────────────────────────────────────────

  describe('SupabaseFundingRequestRepository', () => {
    it('old channel CLOSED after token refresh does not trigger fallbackRefresh', async () => {
      const repo = new SupabaseFundingRequestRepository()
      await repo.initialize()

      const originalChannel = mockState.channels[0]

      // Simulate re-initialization → startRealtimeSubscription (removes old channel, creates new)
      await repo.initialize()

      expect(mockState.channels.length).toBe(2)

      const fromCallsAfterRefresh = vi.mocked(supabase.from).mock.calls.length

      originalChannel.statusCallback!('CLOSED')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfterRefresh)
      expect(mockState.channels.length).toBe(2)
    })

    it('old channel CLOSED after SIGNED_OUT does not trigger fallbackRefresh', async () => {
      const repo = new SupabaseFundingRequestRepository()
      await repo.initialize()

      const originalChannel = mockState.channels[0]

      mockState.authListener!('SIGNED_OUT', null)
      await tick()

      const fromCallsAfterSignOut = vi.mocked(supabase.from).mock.calls.length

      originalChannel.statusCallback!('CLOSED')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfterSignOut)
      expect(mockState.channels.length).toBe(1)
    })

    it('unexpected CLOSED on current channel triggers fallbackRefresh', async () => {
      const repo = new SupabaseFundingRequestRepository()
      await repo.initialize()

      const currentChannel = latestChannel('fixup-funding-requests-')
      const fromCallsBefore = vi.mocked(supabase.from).mock.calls.length

      currentChannel.statusCallback!('CLOSED')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(fromCallsBefore)
    })

    it('unexpected CHANNEL_ERROR on current channel triggers fallbackRefresh', async () => {
      const repo = new SupabaseFundingRequestRepository()
      await repo.initialize()

      const currentChannel = latestChannel('fixup-funding-requests-')
      const fromCallsBefore = vi.mocked(supabase.from).mock.calls.length

      currentChannel.statusCallback!('CHANNEL_ERROR')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(fromCallsBefore)
    })

    it('multiple token refreshes do not accumulate stale reconnect schedules', async () => {
      const repo = new SupabaseFundingRequestRepository()
      await repo.initialize()

      // Two consecutive re-initializations
      await repo.initialize()
      await repo.initialize()

      expect(mockState.channels.length).toBe(3)

      const fromCallsAfter = vi.mocked(supabase.from).mock.calls.length

      mockState.channels[0].statusCallback!('CLOSED')
      mockState.channels[1].statusCallback!('CLOSED')
      await tick()

      expect(vi.mocked(supabase.from).mock.calls.length).toBe(fromCallsAfter)
      expect(mockState.channels.length).toBe(3)
    })
  })

  // ── Stale payload callback isolation ─────────────────────────────────────
  // These tests verify that INSERT/UPDATE payload handlers on old channels
  // cannot mutate the cache or notify subscribers after channel replacement
  // or sign-out. The generation guard in each payload callback is what
  // prevents the mutation; the tests prove it fires correctly.

  describe('Stale INSERT/UPDATE payload callbacks are fully isolated', () => {
    // Minimal valid PlanRow for escrow_payment_plans INSERT tests.
    function makePlanPayload(id: string) {
      return {
        new: {
          id,
          source_offer_id: 'offer-1',
          job_id: 'job-1',
          customer_user_id: 'cust-1',
          provider_id: 'prov-1',
          currency: 'EUR',
          total_amount: 1000,
          funding_mode: 'full_upfront',
          release_model: 'milestone',
          status: 'awaiting_customer_funding',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          funding_initiated_at: null,
          funded_at: null,
          external_funding_ref: null,
          funding_idempotency_key: null,
          platform_fee_rate: null,
          platform_fee_amount: null,
          commercial_origin: null,
        },
      }
    }

    // Minimal valid FundingRequestRow for funding_requests INSERT tests.
    function makeFundingRequestPayload(id: string) {
      return {
        new: {
          id,
          source_offer_id: 'offer-1',
          job_id: 'job-1',
          escrow_plan_id: 'plan-1',
          customer_user_id: 'cust-1',
          provider_id: 'prov-1',
          provider_user_id: 'user-prov-1',
          type: 'escrow_funding',
          status: 'pending',
          amount: 1000,
          currency: 'EUR',
          created_by: 'provider',
          conversation_id: null,
          message_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          sent_at: null,
          funded_at: null,
          external_funding_ref: null,
          funding_idempotency_key: null,
          failure_reason: null,
        },
      }
    }

    describe('SupabaseEscrowPlanRepository', () => {
      it('stale INSERT after token refresh does not mutate cache or notify', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]
        expect(oldChannel.insertHandler).toBeTruthy()

        // Replace channel via re-initialization
        await repo.initialize()

        const notified = vi.fn()
        repo.subscribe(notified)

        // Old channel fires INSERT — must be a no-op
        oldChannel.insertHandler!(makePlanPayload('stale-plan-1'))

        expect(repo.getAllPlans()).toHaveLength(0)
        expect(notified).not.toHaveBeenCalled()
      })

      it('stale INSERT after SIGNED_OUT does not mutate cache or notify', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]

        mockState.authListener!('SIGNED_OUT', null)
        await tick()

        const notified = vi.fn()
        repo.subscribe(notified)

        oldChannel.insertHandler!(makePlanPayload('stale-plan-signout'))

        expect(repo.getAllPlans()).toHaveLength(0)
        expect(notified).not.toHaveBeenCalled()
      })

      it('active INSERT on current channel is still processed correctly', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        const currentChannel = latestChannel('fixup-escrow-plans-')
        expect(currentChannel.insertHandler).toBeTruthy()

        const notified = vi.fn()
        repo.subscribe(notified)

        currentChannel.insertHandler!(makePlanPayload('active-plan-1'))

        expect(repo.getAllPlans()).toHaveLength(1)
        expect(repo.getAllPlans()[0].id).toBe('active-plan-1')
        expect(notified).toHaveBeenCalled()
      })

      it('old channel INSERT arrives after new channel INSERT — old does not overwrite', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]

        // Replace channel
        await repo.initialize()

        const newChannel = latestChannel('fixup-escrow-plans-')

        // New channel adds a plan
        newChannel.insertHandler!(makePlanPayload('new-plan-1'))
        expect(repo.getAllPlans()).toHaveLength(1)

        // Old channel attempts to insert a different plan — must be ignored
        oldChannel.insertHandler!(makePlanPayload('stale-plan-2'))
        expect(repo.getAllPlans()).toHaveLength(1)
        expect(repo.getAllPlans()[0].id).toBe('new-plan-1')
      })
    })

    describe('SupabaseFundingRequestRepository', () => {
      it('stale INSERT after token refresh does not mutate cache or notify', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]
        expect(oldChannel.insertHandler).toBeTruthy()

        // Replace channel via re-initialization
        await repo.initialize()

        const notified = vi.fn()
        repo.subscribe(notified)

        oldChannel.insertHandler!(makeFundingRequestPayload('stale-fr-1'))

        expect(repo.getAll()).toHaveLength(0)
        expect(notified).not.toHaveBeenCalled()
      })

      it('stale INSERT after SIGNED_OUT does not mutate cache or notify', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]

        mockState.authListener!('SIGNED_OUT', null)
        await tick()

        const notified = vi.fn()
        repo.subscribe(notified)

        oldChannel.insertHandler!(makeFundingRequestPayload('stale-fr-signout'))

        expect(repo.getAll()).toHaveLength(0)
        expect(notified).not.toHaveBeenCalled()
      })

      it('active INSERT on current channel is still processed correctly', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        const currentChannel = latestChannel('fixup-funding-requests-')
        expect(currentChannel.insertHandler).toBeTruthy()

        const notified = vi.fn()
        repo.subscribe(notified)

        currentChannel.insertHandler!(makeFundingRequestPayload('active-fr-1'))

        expect(repo.getAll()).toHaveLength(1)
        expect(repo.getAll()[0].id).toBe('active-fr-1')
        expect(notified).toHaveBeenCalled()
      })

      it('old channel INSERT arrives after new channel INSERT — old does not corrupt cache', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        const oldChannel = mockState.channels[0]

        // Replace channel via re-initialization
        await repo.initialize()

        const newChannel = latestChannel('fixup-funding-requests-')

        newChannel.insertHandler!(makeFundingRequestPayload('new-fr-1'))
        expect(repo.getAll()).toHaveLength(1)

        oldChannel.insertHandler!(makeFundingRequestPayload('stale-fr-2'))
        expect(repo.getAll()).toHaveLength(1)
        expect(repo.getAll()[0].id).toBe('new-fr-1')
      })
    })
  })

  // ── Stale async refresh continuation guard ────────────────────────────────
  // In-flight DB fetches started before SIGNED_OUT or account-switch must not
  // write to cache or call startRealtimeSubscription when the Promise resolves.

  describe('Stale async refresh continuations are dropped', () => {
    describe('SupabaseEscrowPlanRepository', () => {
      it('in-flight fetch for uid-A + SIGNED_OUT → no cache write, no new channel', async () => {
        // initialize() must complete first so ensureAuthListener registers the callback
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        // Now block subsequent queries and trigger a reload via token refresh
        mockState.blockQueries = true
        mockState.authListener!('TOKEN_REFRESHED', { user: { id: 'uid-lifecycle' } })
        await tick()

        // SIGNED_OUT fires while the reload fetch is in flight
        mockState.authListener!('SIGNED_OUT', null)
        await tick()

        const channelsBeforeResolve = mockState.channels.length
        const notified = vi.fn()
        repo.subscribe(notified)

        // Unblock the in-flight query — stale continuation must be a no-op
        mockState.pendingQueryResolvers.forEach((r) => r())
        await tick()

        // Cache must still be empty (resetState cleared it)
        expect(repo.getAllPlans()).toHaveLength(0)
        // No new channel from stale loadForUser → startRealtimeSubscription
        expect(mockState.channels.length).toBe(channelsBeforeResolve)
        // No subscriber notification from stale continuation
        expect(notified).not.toHaveBeenCalled()
      })

      it('in-flight fetch for uid-A + account-switch to uid-B → no stale cache write, no stale subscribe', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        // Block queries then trigger reload for uid-A
        mockState.blockQueries = true
        mockState.authListener!('TOKEN_REFRESHED', { user: { id: 'uid-lifecycle' } })
        await tick()

        // Unblock so uid-B load proceeds normally, then switch accounts
        mockState.blockQueries = false
        mockState.authListener!('SIGNED_IN', { user: { id: 'uid-B' } })
        await tick()

        const channelsAfterSwitch = mockState.channels.length

        // Resolve the stale uid-A in-flight fetch
        mockState.pendingQueryResolvers.forEach((r) => r())
        await tick()

        // No extra channel from stale uid-A continuation
        expect(mockState.channels.length).toBe(channelsAfterSwitch)
      })

      it('active fetch for current uid completes normally — cache populated, channel created', async () => {
        const repo = new SupabaseEscrowPlanRepository()
        await repo.initialize()

        expect(mockState.channels.length).toBeGreaterThanOrEqual(1)
        expect(repo.getAllPlans()).toHaveLength(0)
        expect(repo.isHydrated()).toBe(true)
      })
    })

    describe('SupabaseFundingRequestRepository', () => {
      it('in-flight fetch for uid-A + SIGNED_OUT → no cache write, no new channel', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        mockState.blockQueries = true
        mockState.authListener!('TOKEN_REFRESHED', { user: { id: 'uid-lifecycle' } })
        await tick()

        mockState.authListener!('SIGNED_OUT', null)
        await tick()

        const channelsBeforeResolve = mockState.channels.length
        const notified = vi.fn()
        repo.subscribe(notified)

        mockState.pendingQueryResolvers.forEach((r) => r())
        await tick()

        expect(repo.getAll()).toHaveLength(0)
        expect(mockState.channels.length).toBe(channelsBeforeResolve)
        expect(notified).not.toHaveBeenCalled()
      })

      it('in-flight fetch for uid-A + account-switch to uid-B → no stale channel', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        mockState.blockQueries = true
        mockState.authListener!('TOKEN_REFRESHED', { user: { id: 'uid-lifecycle' } })
        await tick()

        mockState.blockQueries = false
        mockState.authListener!('SIGNED_IN', { user: { id: 'uid-B' } })
        await tick()

        const channelsAfterSwitch = mockState.channels.length

        mockState.pendingQueryResolvers.forEach((r) => r())
        await tick()

        expect(mockState.channels.length).toBe(channelsAfterSwitch)
      })

      it('active fetch for current uid completes normally — cache ready, channel created', async () => {
        const repo = new SupabaseFundingRequestRepository()
        await repo.initialize()

        expect(mockState.channels.length).toBeGreaterThanOrEqual(1)
        expect(repo.getAll()).toHaveLength(0)
        expect(repo.isHydrated()).toBe(true)
      })
    })
  })
})
