/**
 * Realtime state propagation tests for Jobs, Payments, and Disputes.
 *
 * Validates that Supabase Realtime INSERT/UPDATE events update the local cache
 * and notify subscribers — without a manual reload — for the three primary
 * multi-user domains.
 *
 * Approach: mocks the Supabase client so tests can trigger channel events
 * directly without a live Supabase connection.  The mock captures INSERT and
 * UPDATE handlers registered by each repository so tests can call them with
 * synthetic payloads.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- Hoisted mock state -------------------------------------------------------
// Must use vi.hoisted so that these variables are available inside the
// vi.mock factory (which is hoisted to the top of the file before imports).

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
}))

// --- Supabase mock ------------------------------------------------------------

vi.mock('../../src/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeFluentQuery = (): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      or: () => q,
      order: () => q,
      limit: () => Promise.resolve({ data: [], error: null }),
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
          data: { session: { user: { id: 'uid-test' } } },
        }),
        onAuthStateChange: vi.fn().mockImplementation((cb: (event: string, session: unknown) => void) => {
          mockState.authListener = cb
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        }),
      },
      from: vi.fn().mockImplementation(makeFluentQuery),
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

// Mock observability to avoid noise in test output
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarning: vi.fn(),
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

// These imports must come after the vi.mock calls
import { SupabaseJobRepository } from '../../src/lib/jobs/repository/SupabaseJobRepository'
import { SupabasePaymentRepository } from '../../src/lib/payments/repository/SupabasePaymentRepository'
import { SupabaseDisputeRepository } from '../../src/lib/disputes/repository/SupabaseDisputeRepository'

// --- Helpers -----------------------------------------------------------------

/** Minimal valid JobRow shape for realtime event payloads */
function makeJobRow(id: string, status = 'new', paymentState = 'deposit_required') {
  return {
    id,
    title: 'Test Job',
    description: '',
    status,
    payment_state: paymentState,
    project_id: 'proj-1',
    customer: 'Kunde',
    location: 'Berlin',
    date_label: 'Termin offen',
    documentation_status: 'Noch keine Dokumentation',
    photo_count: 0,
  }
}

/** Minimal valid PaymentRow shape for realtime event payloads */
function makePaymentRow(id: string, jobId: string, status = 'deposit_required') {
  return {
    id,
    job_id: jobId,
    project_id: null,
    customer_user_id: null,
    craftsman_user_id: null,
    offer_id: null,
    status,
    total_amount: 1000,
    deposit_amount: 250,
    final_amount: 750,
    provider_ref: null,
    client_secret: null,
    refunded_amount: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/** Minimal valid DisputeRow shape for realtime event payloads (Block 5.5b production schema) */
function makeDisputeRow(id: string, jobId: string, status = 'open') {
  const nowIso = new Date().toISOString()
  return {
    id,
    job_id: jobId,
    payment_id: null,
    project_id: null,
    opened_by_profile_id: null,
    customer_profile_id: null,
    provider_id: null,
    status,
    reason: 'work_quality',
    description: 'Test',
    resolution_type: null,
    resolution_note: null,
    refund_amount: 0,
    release_amount: 0,
    provider_award_amount: 0,
    customer_refund_amount: 0,
    split_ratio: null,
    settlement_status: null,
    raised_by: null,
    decision: null,
    metadata: { title: 'Test Dispute', evidence: [] },
    context_snapshot: null,
    opened_at: nowIso,
    resolved_at: null,
    closed_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  }
}

/** Find the most recently created channel by name prefix */
function findChannel(prefix: string): ChannelCapture | undefined {
  return [...mockState.channels].reverse().find((c) => c.name.startsWith(prefix))
}

// --- Tests -------------------------------------------------------------------

describe('Realtime State Propagation', () => {
  beforeEach(() => {
    mockState.channels.length = 0
    mockState.removedChannels.length = 0
    mockState.authListener = null
  })

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  describe('SupabaseJobRepository', () => {
    it('INSERT event adds job to cache and notifies subscribers', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const notified = vi.fn()
      repo.subscribe(notified)

      const channel = findChannel('fixup-jobs-')
      expect(channel?.insertHandler).toBeTruthy()

      channel!.insertHandler!({ new: makeJobRow('job-rt-1') })

      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].id).toBe('job-rt-1')
      expect(notified).toHaveBeenCalled()
    })

    it('INSERT event is ignored when job already in cache (dedup)', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const channel = findChannel('fixup-jobs-')

      // First insertion
      channel!.insertHandler!({ new: makeJobRow('job-dedup-1') })
      expect(repo.getAll()).toHaveLength(1)

      const notified = vi.fn()
      repo.subscribe(notified)

      // Duplicate insertion — should be no-op
      channel!.insertHandler!({ new: makeJobRow('job-dedup-1') })
      expect(repo.getAll()).toHaveLength(1)
      expect(notified).not.toHaveBeenCalled()
    })

    it('UPDATE event replaces existing job in cache', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const channel = findChannel('fixup-jobs-')

      // Seed a job via INSERT
      channel!.insertHandler!({ new: makeJobRow('job-upd-1', 'new') })
      expect(repo.getAll()[0].status).toBe('new')

      // Update the job status via UPDATE
      channel!.updateHandler!({ new: makeJobRow('job-upd-1', 'in_progress') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].status).toBe('in_progress')
    })

    it('UPDATE event adds job if not in cache', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const channel = findChannel('fixup-jobs-')
      expect(repo.getAll()).toHaveLength(0)

      channel!.updateHandler!({ new: makeJobRow('job-new-via-update-1', 'scheduled') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].id).toBe('job-new-via-update-1')
    })

    it('startRealtimeSubscription is idempotent — old channel removed before new one', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const firstChannelCount = mockState.channels.length

      // Simulate re-initialization → startRealtimeSubscription (removes old, creates new)
      await repo.initialize()

      // A new channel was created
      expect(mockState.channels.length).toBeGreaterThan(firstChannelCount)
      // The old channel was removed
      expect(mockState.removedChannels.length).toBeGreaterThan(0)
    })

    it('SIGNED_OUT clears job cache and notifies subscribers', async () => {
      const repo = new SupabaseJobRepository()
      await repo.initialize()

      const channel = findChannel('fixup-jobs-')
      channel!.insertHandler!({ new: makeJobRow('job-signout-1') })
      expect(repo.getAll()).toHaveLength(1)

      const notified = vi.fn()
      repo.subscribe(notified)

      mockState.authListener!('SIGNED_OUT', null)

      expect(repo.getAll()).toHaveLength(0)
      expect(notified).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------

  describe('SupabasePaymentRepository', () => {
    it('INSERT event adds payment to cache and notifies subscribers', async () => {
      const repo = new SupabasePaymentRepository()
      await repo.initialize()

      const notified = vi.fn()
      repo.subscribe(notified)

      const channel = findChannel('fixup-payments-')
      expect(channel?.insertHandler).toBeTruthy()

      channel!.insertHandler!({ new: makePaymentRow('pay-rt-1', 'job-1') })

      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].id).toBe('pay-rt-1')
      expect(notified).toHaveBeenCalled()
    })

    it('INSERT event is ignored when payment already in cache (dedup)', async () => {
      const repo = new SupabasePaymentRepository()
      await repo.initialize()

      const channel = findChannel('fixup-payments-')
      channel!.insertHandler!({ new: makePaymentRow('pay-dedup-1', 'job-2') })
      expect(repo.getAll()).toHaveLength(1)

      const notified = vi.fn()
      repo.subscribe(notified)

      channel!.insertHandler!({ new: makePaymentRow('pay-dedup-1', 'job-2') })
      expect(repo.getAll()).toHaveLength(1)
      expect(notified).not.toHaveBeenCalled()
    })

    it('UPDATE event replaces existing payment state in cache', async () => {
      const repo = new SupabasePaymentRepository()
      await repo.initialize()

      const channel = findChannel('fixup-payments-')

      channel!.insertHandler!({ new: makePaymentRow('pay-upd-1', 'job-3', 'deposit_paid') })
      expect(repo.getByJobId('job-3')?.state).toBe('deposit_paid')

      channel!.updateHandler!({ new: makePaymentRow('pay-upd-1', 'job-3', 'in_escrow') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getByJobId('job-3')?.state).toBe('in_escrow')
    })

    it('UPDATE event adds payment if not in cache', async () => {
      const repo = new SupabasePaymentRepository()
      await repo.initialize()

      const channel = findChannel('fixup-payments-')
      expect(repo.getAll()).toHaveLength(0)

      channel!.updateHandler!({ new: makePaymentRow('pay-via-update-1', 'job-4', 'released') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].state).toBe('released')
    })

    it('SIGNED_OUT clears payment cache', async () => {
      const repo = new SupabasePaymentRepository()
      await repo.initialize()

      const channel = findChannel('fixup-payments-')
      channel!.insertHandler!({ new: makePaymentRow('pay-out-1', 'job-5') })
      expect(repo.getAll()).toHaveLength(1)

      mockState.authListener!('SIGNED_OUT', null)
      expect(repo.getAll()).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Disputes
  // ---------------------------------------------------------------------------

  describe('SupabaseDisputeRepository', () => {
    it('INSERT event adds dispute to cache and notifies subscribers', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const notified = vi.fn()
      repo.subscribe(notified)

      const channel = findChannel('fixup-disputes-')
      expect(channel?.insertHandler).toBeTruthy()

      channel!.insertHandler!({ new: makeDisputeRow('dis-rt-1', 'job-d1') })

      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].id).toBe('dis-rt-1')
      expect(notified).toHaveBeenCalled()
    })

    it('INSERT event is ignored when dispute already in cache (dedup)', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const channel = findChannel('fixup-disputes-')
      channel!.insertHandler!({ new: makeDisputeRow('dis-dedup-1', 'job-d2') })
      expect(repo.getAll()).toHaveLength(1)

      const notified = vi.fn()
      repo.subscribe(notified)

      channel!.insertHandler!({ new: makeDisputeRow('dis-dedup-1', 'job-d2') })
      expect(repo.getAll()).toHaveLength(1)
      expect(notified).not.toHaveBeenCalled()
    })

    it('UPDATE event replaces existing dispute status in cache', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const channel = findChannel('fixup-disputes-')

      channel!.insertHandler!({ new: makeDisputeRow('dis-upd-1', 'job-d3', 'open') })
      expect(repo.getByJobId('job-d3')?.status).toBe('open')

      channel!.updateHandler!({ new: makeDisputeRow('dis-upd-1', 'job-d3', 'under_review') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getByJobId('job-d3')?.status).toBe('under_review')
    })

    it('UPDATE event adds dispute if not in cache', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const channel = findChannel('fixup-disputes-')
      expect(repo.getAll()).toHaveLength(0)

      channel!.updateHandler!({ new: makeDisputeRow('dis-via-update-1', 'job-d4', 'resolved') })
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].status).toBe('resolved')
    })

    it('SIGNED_OUT clears dispute cache', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const channel = findChannel('fixup-disputes-')
      channel!.insertHandler!({ new: makeDisputeRow('dis-out-1', 'job-d5') })
      expect(repo.getAll()).toHaveLength(1)

      mockState.authListener!('SIGNED_OUT', null)
      expect(repo.getAll()).toHaveLength(0)
    })

    it('subscription idempotency — old channel removed on re-subscribe', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.initialize()

      const firstCount = mockState.channels.length

      await repo.initialize()

      expect(mockState.channels.length).toBeGreaterThan(firstCount)
      expect(mockState.removedChannels.length).toBeGreaterThan(0)
    })
  })
})
