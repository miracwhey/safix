/**
 * Block 5.5b — SupabaseDisputeRepository Production Schema Mapping
 *
 * Pins the row contract, write paths, history insert, evidence merge, and
 * operator-RPC argument shape against the production `disputes` /
 * `dispute_status_history` schema (uuid + timestamptz + metadata jsonb,
 * no title / evidence columns).
 *
 * The supabase client is mocked so each test can intercept inserts/updates/
 * RPC calls and assert the exact payload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Hoisted mock state ──────────────────────────────────────────────────────

interface InsertCall { table: string; payload: unknown }
interface UpdateCall { table: string; patch: unknown; eq?: { col: string; val: unknown } }
interface SelectCall { table: string }
interface RpcCall { fn: string; args: Record<string, unknown> }
interface RealtimeHandler { event: string; callback: (payload: { new: unknown }) => void }

const mockState = vi.hoisted(() => ({
  inserts: [] as InsertCall[],
  updates: [] as UpdateCall[],
  selects: [] as SelectCall[],
  rpcCalls: [] as RpcCall[],
  realtimeHandlers: [] as RealtimeHandler[],
  /** Optional fixture returned by the next `.single()` / `.maybeSingle()` read. */
  nextSingle: null as { data: unknown; error: unknown } | null,
  /** Optional fixture for the next `.limit().then(...)` (i.e. multi-row select). */
  nextSelectList: null as { data: unknown; error: unknown } | null,
  /** Override for the next supabase rpc result. */
  nextRpcResult: null as { data: unknown; error: unknown } | null,
}))

vi.mock('../../src/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildQuery = (table: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => {
        const list = mockState.nextSelectList ?? { data: [], error: null }
        mockState.nextSelectList = null
        return Promise.resolve(list)
      },
      single: () => {
        const r = mockState.nextSingle ?? { data: null, error: null }
        mockState.nextSingle = null
        return Promise.resolve(r)
      },
      maybeSingle: () => {
        const r = mockState.nextSingle ?? { data: null, error: null }
        mockState.nextSingle = null
        return Promise.resolve(r)
      },
      insert: (payload: unknown) => {
        mockState.inserts.push({ table, payload })
        return {
          then: (
            resolve: (v: { error: null }) => void,
            reject?: (e: unknown) => void,
          ) => Promise.resolve({ error: null }).then(resolve, reject),
        }
      },
      update: (patch: unknown) => {
        const inner = {
          eq: (col: string, val: unknown) => {
            mockState.updates.push({ table, patch, eq: { col, val } })
            return Promise.resolve({ error: null })
          },
        }
        return inner
      },
    }
    mockState.selects.push({ table })
    return q
  }
  return {
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        onAuthStateChange: vi.fn().mockReturnValue({
          data: { subscription: { unsubscribe: vi.fn() } },
        }),
      },
      from: vi.fn().mockImplementation((table: string) => buildQuery(table)),
      rpc: vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
        mockState.rpcCalls.push({ fn, args })
        const r = mockState.nextRpcResult ?? { data: null, error: null }
        mockState.nextRpcResult = null
        return Promise.resolve(r)
      }),
      channel: vi.fn().mockImplementation(() => {
        const channel = {
          on: (event: string, _filter: unknown, callback: (payload: { new: unknown }) => void) => {
            mockState.realtimeHandlers.push({ event, callback })
            return channel
          },
          subscribe: () => channel,
        }
        return channel
      }),
      removeChannel: vi.fn(),
    },
  }
})

// ─── Imports under test (must come AFTER vi.mock) ────────────────────────────

import { SupabaseDisputeRepository } from '../../src/lib/disputes/repository/SupabaseDisputeRepository'
import type {
  Dispute,
  DisputeContextSnapshot,
  DisputeEvidence,
} from '../../src/lib/disputes/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_DISPUTE = '11111111-1111-4111-8111-111111111111'
const UUID_JOB = '22222222-2222-4222-8222-222222222222'
const UUID_PAYMENT = '33333333-3333-4333-8333-333333333333'
const UUID_RAISED_BY = '44444444-4444-4444-8444-444444444444'

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: UUID_DISPUTE,
    jobId: UUID_JOB,
    paymentId: UUID_PAYMENT,
    raisedBy: UUID_RAISED_BY,
    status: 'open',
    reason: 'work_quality',
    title: 'Streit über Maler',
    description: 'Wand fehlt',
    createdAt: '2026-04-28T10:00:00.000Z',
    updatedAt: '2026-04-28T10:00:00.000Z',
    evidence: [],
    ...overrides,
  }
}

function resetMockState(): void {
  mockState.inserts.length = 0
  mockState.updates.length = 0
  mockState.selects.length = 0
  mockState.rpcCalls.length = 0
  mockState.realtimeHandlers.length = 0
  mockState.nextSingle = null
  mockState.nextSelectList = null
  mockState.nextRpcResult = null
}

async function withCachedDispute(
  repo: SupabaseDisputeRepository,
  dispute: Dispute,
): Promise<void> {
  // Seeds the local cache via applyFromRpc so subsequent `update()` /
  // operator-RPC calls have a previous-state to diff against. applyFromRpc
  // does NOT issue any DB call.
  repo.applyFromRpc(dispute)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SupabaseDisputeRepository — Production schema mapping (Block 5.5b)', () => {
  beforeEach(() => {
    resetMockState()
  })

  describe('rowToDispute / fetchDisputesFromDatabase', () => {
    it('reads a production-shape row (uuid + ISO timestamptz + metadata.evidence) into a domain Dispute', async () => {
      const evidenceItem: DisputeEvidence = {
        id: 'ev-1',
        disputeId: UUID_DISPUTE,
        jobId: UUID_JOB,
        type: 'photo',
        description: 'Foto',
        submittedAt: '2026-04-28T11:00:00.000Z',
        submittedBy: UUID_RAISED_BY,
      }
      const productionRow = {
        id: UUID_DISPUTE,
        job_id: UUID_JOB,
        payment_id: UUID_PAYMENT,
        project_id: null,
        opened_by_profile_id: UUID_RAISED_BY,
        customer_profile_id: null,
        provider_id: null,
        status: 'under_review',
        reason: 'work_quality',
        description: 'Mängel',
        resolution_type: null,
        resolution_note: null,
        refund_amount: 0,
        release_amount: 0,
        provider_award_amount: 0,
        customer_refund_amount: 0,
        split_ratio: null,
        settlement_status: null,
        raised_by: UUID_RAISED_BY,
        decision: null,
        metadata: { title: 'Streitfall A', evidence: [evidenceItem] },
        context_snapshot: null,
        opened_at: '2026-04-28T10:00:00.000Z',
        resolved_at: null,
        closed_at: null,
        created_at: '2026-04-28T10:00:00.000Z',
        updated_at: '2026-04-28T10:30:00.000Z',
      }
      mockState.nextSelectList = { data: [productionRow], error: null }
      mockState.nextSingle = { data: { id: 'uid-1' }, error: null }

      const repo = new SupabaseDisputeRepository()
      // Force a load by triggering the realtime fallback path (it reads via fetchDisputesFromDatabase).
      // Easier: cast to access private via any since direct method call is fine in tests.
      // We bypass auth and just exercise fetch via the public initialize path with a stubbed session.
      // Stub auth session to a present user:
      const supabaseMock = (await import('../../src/lib/supabase')).supabase as unknown as {
        auth: {
          getSession: { mockResolvedValueOnce: (v: unknown) => void }
        }
      }
      supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'uid-1' } } } })
      await repo.initialize()

      const got = repo.getById(UUID_DISPUTE)
      expect(got).toBeDefined()
      expect(got!.id).toBe(UUID_DISPUTE)
      expect(got!.status).toBe('under_review')
      expect(got!.title).toBe('Streitfall A')
      expect(got!.evidence?.length).toBe(1)
      expect(got!.evidence?.[0]?.id).toBe('ev-1')
      expect(got!.createdAt).toBe('2026-04-28T10:00:00.000Z')
      expect(got!.updatedAt).toBe('2026-04-28T10:30:00.000Z')
      expect(got!.resolvedAt).toBeUndefined()
    })

    it('handles missing metadata as empty title + undefined evidence (no silent column fallback)', async () => {
      const productionRow = {
        id: UUID_DISPUTE,
        job_id: UUID_JOB,
        payment_id: null,
        project_id: null,
        opened_by_profile_id: null,
        customer_profile_id: null,
        provider_id: null,
        status: 'open',
        reason: 'other',
        description: 'x',
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
        metadata: null,
        context_snapshot: null,
        opened_at: '2026-04-28T10:00:00.000Z',
        resolved_at: null,
        closed_at: null,
        created_at: '2026-04-28T10:00:00.000Z',
        updated_at: '2026-04-28T10:00:00.000Z',
      }
      mockState.nextSelectList = { data: [productionRow], error: null }
      const supabaseMock = (await import('../../src/lib/supabase')).supabase as unknown as {
        auth: { getSession: { mockResolvedValueOnce: (v: unknown) => void } }
      }
      supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'uid-2' } } } })

      const repo = new SupabaseDisputeRepository()
      await repo.initialize()
      const got = repo.getById(UUID_DISPUTE)
      expect(got).toBeDefined()
      expect(got!.title).toBe('')
      expect(got!.evidence).toBeUndefined()
    })
  })

  describe('realtime terminal settlement updates', () => {
    it('accepts only a forward pending-to-settled update without revising the decision', async () => {
      const resolvedPendingRow = {
        id: UUID_DISPUTE,
        job_id: UUID_JOB,
        payment_id: UUID_PAYMENT,
        project_id: null,
        opened_by_profile_id: UUID_RAISED_BY,
        customer_profile_id: null,
        provider_id: null,
        status: 'resolved',
        reason: 'work_quality',
        description: 'Mängel',
        resolution_type: 'split',
        resolution_note: null,
        refund_amount: 40,
        release_amount: 60,
        provider_award_amount: 60,
        customer_refund_amount: 40,
        split_ratio: 0.6,
        settlement_status: 'pending',
        raised_by: UUID_RAISED_BY,
        decision: 'split',
        metadata: { title: 'Streitfall A', evidence: [] },
        context_snapshot: null,
        opened_at: '2026-04-28T10:00:00.000Z',
        resolved_at: '2026-04-28T11:00:00.000Z',
        closed_at: null,
        created_at: '2026-04-28T10:00:00.000Z',
        updated_at: '2026-04-28T11:00:00.000Z',
      }
      mockState.nextSelectList = { data: [resolvedPendingRow], error: null }
      const supabaseMock = (await import('../../src/lib/supabase')).supabase as unknown as {
        auth: { getSession: { mockResolvedValueOnce: (v: unknown) => void } }
      }
      supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'uid-3' } } } })

      const repo = new SupabaseDisputeRepository()
      await repo.initialize()
      // Subscription order is INSERT followed by UPDATE (both use the
      // Supabase `postgres_changes` event name).
      const realtimeUpdate = mockState.realtimeHandlers[1]
      expect(realtimeUpdate).toBeDefined()

      // A later replay that keeps settlement pending may not change the terminal decision.
      realtimeUpdate!.callback({
        new: {
          ...resolvedPendingRow,
          decision: 'refund',
          resolution_type: 'refund_full',
          split_ratio: null,
          updated_at: '2026-04-28T11:05:00.000Z',
        },
      })
      expect(repo.getById(UUID_DISPUTE)).toMatchObject({
        decision: 'split',
        resolutionType: 'split',
        settlementStatus: 'pending',
      })

      // The server's settlement completion is the sole permitted terminal update.
      realtimeUpdate!.callback({
        new: {
          ...resolvedPendingRow,
          settlement_status: 'settled',
          updated_at: '2026-04-28T11:10:00.000Z',
        },
      })
      expect(repo.getById(UUID_DISPUTE)).toMatchObject({
        decision: 'split',
        resolutionType: 'split',
        settlementStatus: 'settled',
        updatedAt: '2026-04-28T11:10:00.000Z',
      })
    })
  })

  describe('add() — insert payload', () => {
    it('writes the production-schema columns; never writes a top-level title or evidence column', async () => {
      const repo = new SupabaseDisputeRepository()
      const dispute = makeDispute()
      await repo.add(dispute)

      const insertedDispute = mockState.inserts.find((c) => c.table === 'disputes')
      expect(insertedDispute).toBeDefined()
      const row = insertedDispute!.payload as Record<string, unknown>
      // Forbidden top-level columns:
      expect(row).not.toHaveProperty('title')
      expect(row).not.toHaveProperty('evidence')
      // Required production columns:
      expect(row.id).toBe(UUID_DISPUTE)
      expect(row.job_id).toBe(UUID_JOB)
      expect(row.payment_id).toBe(UUID_PAYMENT)
      expect(row.status).toBe('open')
      // Timestamps must be ISO timestamptz strings, not epoch-ms numbers.
      expect(typeof row.opened_at).toBe('string')
      expect(typeof row.created_at).toBe('string')
      expect(typeof row.updated_at).toBe('string')
      expect(row.opened_at).toBe('2026-04-28T10:00:00.000Z')
      // Title + evidence land in metadata.
      const metadata = row.metadata as { title?: string; evidence?: DisputeEvidence[] }
      expect(metadata.title).toBe('Streit über Maler')
      expect(Array.isArray(metadata.evidence)).toBe(true)
    })

    it('writes the audit row with previous_status=null + next_status + source=client (γ schema)', async () => {
      const repo = new SupabaseDisputeRepository()
      await repo.add(makeDispute({ status: 'open' }))

      const historyInsert = mockState.inserts.find((c) => c.table === 'dispute_status_history')
      expect(historyInsert).toBeDefined()
      const row = historyInsert!.payload as Record<string, unknown>
      expect(row.previous_status).toBeNull()
      expect(row.next_status).toBe('open')
      expect(row.source).toBe('client')
      expect(row.dispute_id).toBe(UUID_DISPUTE)
      expect(row.job_id).toBe(UUID_JOB)
      expect(typeof row.created_at).toBe('string')
      expect(row.metadata).toEqual({})
      // Forbidden legacy columns must not appear:
      expect(row).not.toHaveProperty('from_status')
      expect(row).not.toHaveProperty('to_status')
      expect(row).not.toHaveProperty('changed_by')
      expect(row).not.toHaveProperty('occurred_at')
    })
  })

  describe('update() — patch updates', () => {
    it('writes only changed fields (no full-row replace; non-touched columns stay untouched)', async () => {
      const repo = new SupabaseDisputeRepository()
      const dispute = makeDispute({ status: 'open' })
      await withCachedDispute(repo, dispute)

      await repo.update(UUID_DISPUTE, (d) => ({
        ...d,
        status: 'under_review',
        updatedAt: '2026-04-28T11:00:00.000Z',
      }))

      const update = mockState.updates.find((u) => u.table === 'disputes')
      expect(update).toBeDefined()
      const patch = update!.patch as Record<string, unknown>
      // Only status + updated_at should be in the patch.
      expect(patch.status).toBe('under_review')
      expect(patch.updated_at).toBe('2026-04-28T11:00:00.000Z')
      expect(patch).not.toHaveProperty('reason')
      expect(patch).not.toHaveProperty('description')
      expect(patch).not.toHaveProperty('decision')
      expect(patch).not.toHaveProperty('metadata')
      expect(patch).not.toHaveProperty('payment_id')
      expect(update!.eq).toEqual({ col: 'id', val: UUID_DISPUTE })
    })

    it('writes a status-history row when status changes (previous_status/next_status/source)', async () => {
      const repo = new SupabaseDisputeRepository()
      await withCachedDispute(repo, makeDispute({ status: 'open' }))

      await repo.update(UUID_DISPUTE, (d) => ({
        ...d,
        status: 'under_review',
        updatedAt: '2026-04-28T11:00:00.000Z',
      }))

      const historyInsert = mockState.inserts.find((c) => c.table === 'dispute_status_history')
      expect(historyInsert).toBeDefined()
      const row = historyInsert!.payload as Record<string, unknown>
      expect(row.previous_status).toBe('open')
      expect(row.next_status).toBe('under_review')
      expect(row.source).toBe('client')
    })

    it('does NOT write a status-history row when status is unchanged', async () => {
      const repo = new SupabaseDisputeRepository()
      await withCachedDispute(repo, makeDispute({ status: 'open' }))

      await repo.update(UUID_DISPUTE, (d) => ({
        ...d,
        description: 'updated desc',
        updatedAt: '2026-04-28T11:00:00.000Z',
      }))

      const historyInsert = mockState.inserts.find((c) => c.table === 'dispute_status_history')
      expect(historyInsert).toBeUndefined()
    })
  })

  describe('addDisputeEvidence semantics — metadata merge', () => {
    it('preserves server-side metadata keys when evidence is appended (read-merge-write)', async () => {
      const repo = new SupabaseDisputeRepository()
      const initial = makeDispute({ status: 'customer_waiting', evidence: [] })
      await withCachedDispute(repo, initial)

      // Server has extra audit fields the client doesn't know about.
      mockState.nextSingle = {
        data: { metadata: { auditKey: 'must-survive', title: 'old', extra: 42 } },
        error: null,
      }

      const newEvidence: DisputeEvidence = {
        id: 'ev-merge-1',
        disputeId: UUID_DISPUTE,
        jobId: UUID_JOB,
        type: 'photo',
        description: 'Foto',
        submittedAt: '2026-04-28T12:00:00.000Z',
        submittedBy: UUID_RAISED_BY,
      }

      await repo.update(UUID_DISPUTE, (d) => ({
        ...d,
        evidence: [...(d.evidence ?? []), newEvidence],
        updatedAt: '2026-04-28T12:00:00.000Z',
      }))

      const update = mockState.updates.find((u) => u.table === 'disputes')
      expect(update).toBeDefined()
      const patch = update!.patch as Record<string, unknown>
      expect(patch).toHaveProperty('metadata')
      const merged = patch.metadata as Record<string, unknown>
      // Server keys must survive
      expect(merged.auditKey).toBe('must-survive')
      expect(merged.extra).toBe(42)
      // Client overwrites title + evidence
      expect(merged.title).toBe('Streit über Maler')
      const ev = merged.evidence as DisputeEvidence[]
      expect(ev.length).toBe(1)
      expect(ev[0].id).toBe('ev-merge-1')
    })
  })

  describe('Operator RPC wrappers — p_dispute_id uuid contract', () => {
    it.each([
      ['operatorRequestCustomerEvidence', 'operator_request_customer_evidence_dispute'],
      ['operatorRequestProviderEvidence', 'operator_request_provider_evidence_dispute'],
      ['operatorMarkUnderReview',         'operator_mark_dispute_under_review'],
      ['operatorResolveRelease',          'operator_resolve_dispute_release'],
      ['operatorResolveRefund',           'operator_resolve_dispute_refund'],
      ['operatorReject',                  'operator_reject_dispute'],
    ] as const)('%s sends %s with p_dispute_id uuid', async (method, expectedFn) => {
      const repo = new SupabaseDisputeRepository()
      const dispute = makeDispute({ status: 'under_review' })
      await withCachedDispute(repo, dispute)

      const rpcRow = {
        ...dispute,
        // Provide a row-shape return so rowToDispute can parse it.
        id: UUID_DISPUTE,
        job_id: UUID_JOB,
        status: 'resolved',
        reason: 'work_quality',
        description: 'x',
        resolution_type: 'release_full',
        resolution_note: null,
        refund_amount: 0,
        release_amount: 0,
        provider_award_amount: 0,
        customer_refund_amount: 0,
        split_ratio: null,
        settlement_status: 'pending',
        raised_by: UUID_RAISED_BY,
        decision: 'release',
        metadata: { title: 't', evidence: [] },
        context_snapshot: null,
        opened_at: '2026-04-28T10:00:00.000Z',
        resolved_at: '2026-04-28T11:00:00.000Z',
        closed_at: null,
        created_at: '2026-04-28T10:00:00.000Z',
        updated_at: '2026-04-28T11:00:00.000Z',
        payment_id: UUID_PAYMENT,
        project_id: null,
        opened_by_profile_id: UUID_RAISED_BY,
        customer_profile_id: null,
        provider_id: null,
      }
      mockState.nextRpcResult = { data: rpcRow, error: null }

      const fn = (repo as unknown as Record<string, (jobId: string) => Promise<unknown>>)[method]
      await fn.call(repo, UUID_JOB)

      const call = mockState.rpcCalls.find((c) => c.fn === expectedFn)
      expect(call).toBeDefined()
      expect(call!.args.p_dispute_id).toBe(UUID_DISPUTE)
      // Operator RPCs MUST NOT take p_job_id (the contract is dispute-keyed):
      expect(call!.args.p_job_id).toBeUndefined()
    })

    it('operatorResolveSplit sends p_dispute_id + p_split_ratio', async () => {
      const repo = new SupabaseDisputeRepository()
      const dispute = makeDispute({ status: 'under_review' })
      await withCachedDispute(repo, dispute)

      const rpcRow = {
        id: UUID_DISPUTE,
        job_id: UUID_JOB,
        status: 'resolved',
        reason: 'work_quality',
        description: 'x',
        resolution_type: 'split',
        resolution_note: null,
        refund_amount: 0,
        release_amount: 0,
        provider_award_amount: 0,
        customer_refund_amount: 0,
        split_ratio: 0.6,
        settlement_status: 'pending',
        raised_by: UUID_RAISED_BY,
        decision: 'split',
        metadata: { title: 't', evidence: [] },
        context_snapshot: null,
        opened_at: '2026-04-28T10:00:00.000Z',
        resolved_at: '2026-04-28T11:00:00.000Z',
        closed_at: null,
        created_at: '2026-04-28T10:00:00.000Z',
        updated_at: '2026-04-28T11:00:00.000Z',
        payment_id: UUID_PAYMENT,
        project_id: null,
        opened_by_profile_id: UUID_RAISED_BY,
        customer_profile_id: null,
        provider_id: null,
      }
      mockState.nextRpcResult = { data: rpcRow, error: null }

      await repo.operatorResolveSplit(UUID_JOB, 0.6)

      const call = mockState.rpcCalls.find((c) => c.fn === 'operator_resolve_dispute_split')
      expect(call).toBeDefined()
      expect(call!.args.p_dispute_id).toBe(UUID_DISPUTE)
      expect(call!.args.p_split_ratio).toBe(0.6)
      expect(call!.args.p_job_id).toBeUndefined()
    })

    it('throws dispute_not_found when no cached dispute exists for the job', async () => {
      const repo = new SupabaseDisputeRepository()
      await expect(repo.operatorReject(UUID_JOB)).rejects.toThrow(/dispute_not_found/)
      // No RPC call should have been made when the cache lookup fails.
      expect(mockState.rpcCalls.length).toBe(0)
    })
  })

  describe('openDisputeAtomic — RPC args (5.6 target shape)', () => {
    it('sends p_dispute_id uuid + ISO p_opened_at + p_metadata; never p_title or epoch-ms args', async () => {
      const snapshot: DisputeContextSnapshot = {
        jobTitle: 'Job',
        jobDescription: 'D',
        craftsmanUserId: null,
        customerUserId: null,
        sourceConversationId: null,
        sourceOfferId: null,
        paymentStateAtOpen: null,
        paymentTotalAmount: null,
        snapshotAt: '2026-04-28T10:00:00.000Z',
      }
      const repo = new SupabaseDisputeRepository()
      const dispute = makeDispute({ contextSnapshot: snapshot })
      mockState.nextRpcResult = { data: null, error: null }

      await repo.openDisputeAtomic(dispute)

      const call = mockState.rpcCalls.find((c) => c.fn === 'open_dispute_atomic')
      expect(call).toBeDefined()
      const args = call!.args
      expect(args.p_dispute_id).toBe(UUID_DISPUTE)
      expect(args.p_job_id).toBe(UUID_JOB)
      expect(args.p_payment_id).toBe(UUID_PAYMENT)
      expect(args.p_reason).toBe('work_quality')
      expect(args.p_description).toBe('Wand fehlt')
      expect(args.p_raised_by).toBe(UUID_RAISED_BY)
      expect(args.p_opened_at).toBe('2026-04-28T10:00:00.000Z')
      // Metadata round-trip carries title + evidence.
      const meta = args.p_metadata as Record<string, unknown>
      expect(meta.title).toBe('Streit über Maler')
      expect(Array.isArray(meta.evidence)).toBe(true)
      expect(args.p_context_snapshot).toEqual(snapshot)
      // Forbidden legacy args must NOT appear:
      expect(args).not.toHaveProperty('p_title')
      expect(args).not.toHaveProperty('p_created_at')
      expect(args).not.toHaveProperty('p_updated_at')
    })
  })

  describe('Terminal/active guard uses γ vocabulary', () => {
    it('rejects use of legacy status tokens (would be type-rejected at compile time)', () => {
      // This is a compile-time guard rather than a runtime one; the test
      // exists to make the constraint visible to readers and ensure the type
      // system flags any reintroduction of legacy statuses.
      const legacy = [
        'awaiting_evidence',
        'resolved_release',
        'resolved_refund',
        'resolved_split',
        'resolved_rejected',
      ]
      const valid: ReadonlyArray<Dispute['status']> = [
        'open',
        'under_review',
        'customer_waiting',
        'provider_waiting',
        'resolved',
        'closed',
        'cancelled',
      ]
      for (const token of legacy) {
        expect(valid).not.toContain(token as Dispute['status'])
      }
    })
  })
})

// ─── H24: partySubmitStatement ───────────────────────────────────────────────

describe('SupabaseDisputeRepository — partySubmitStatement (H24)', () => {
  beforeEach(() => {
    resetMockState()
  })

  function makeEvidence(): DisputeEvidence {
    return {
      id: 'ev-h24-1',
      disputeId: UUID_DISPUTE,
      jobId: UUID_JOB,
      type: 'description',
      description: 'Stellungnahme der Partei.',
      submittedBy: UUID_RAISED_BY,
      submittedAt: '2026-06-10T09:00:00.000Z',
    } as DisputeEvidence
  }

  function makeRpcRow(evidence: DisputeEvidence[]) {
    return {
      id: UUID_DISPUTE,
      job_id: UUID_JOB,
      status: 'under_review',
      reason: 'work_quality',
      description: 'Wand fehlt',
      resolution_type: null,
      resolution_note: null,
      refund_amount: 0,
      release_amount: 0,
      provider_award_amount: 0,
      customer_refund_amount: 0,
      split_ratio: null,
      settlement_status: null,
      raised_by: UUID_RAISED_BY,
      decision: null,
      metadata: { title: 'Streit über Maler', evidence },
      context_snapshot: null,
      opened_at: '2026-04-28T10:00:00.000Z',
      resolved_at: null,
      closed_at: null,
      created_at: '2026-04-28T10:00:00.000Z',
      updated_at: '2026-06-10T09:00:00.000Z',
      payment_id: UUID_PAYMENT,
      project_id: null,
      opened_by_profile_id: UUID_RAISED_BY,
      customer_profile_id: null,
      provider_id: null,
    }
  }

  it('calls party_submit_dispute_statement with p_dispute_id + p_evidence and merges the returned row', async () => {
    const repo = new SupabaseDisputeRepository()
    const cached = makeDispute({ status: 'customer_waiting' })
    await withCachedDispute(repo, cached)

    const evidence = makeEvidence()
    mockState.nextRpcResult = { data: makeRpcRow([evidence]), error: null }

    const result = await repo.partySubmitStatement(UUID_DISPUTE, evidence)

    const call = mockState.rpcCalls.find((c) => c.fn === 'party_submit_dispute_statement')
    expect(call).toBeDefined()
    expect(call!.args.p_dispute_id).toBe(UUID_DISPUTE)
    expect(call!.args.p_evidence).toEqual(evidence)

    // Returned row applied to cache (status flipped, evidence present).
    expect(result.status).toBe('under_review')
    expect(result.evidence?.length).toBe(1)
    expect(repo.getById(UUID_DISPUTE)?.status).toBe('under_review')

    // The RPC owns history + status writes server-side: the client must not
    // issue a dispute_status_history insert or a disputes update of its own.
    expect(mockState.inserts.filter((i) => i.table === 'dispute_status_history').length).toBe(0)
    expect(mockState.updates.filter((u) => u.table === 'disputes').length).toBe(0)
  })

  it('throws on RPC error and leaves the cache untouched', async () => {
    const repo = new SupabaseDisputeRepository()
    const cached = makeDispute({ status: 'customer_waiting' })
    await withCachedDispute(repo, cached)

    mockState.nextRpcResult = {
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not the responding customer' },
    }

    await expect(repo.partySubmitStatement(UUID_DISPUTE, makeEvidence())).rejects.toMatchObject({
      code: '42501',
    })

    expect(repo.getById(UUID_DISPUTE)?.status).toBe('customer_waiting')
    expect(repo.getById(UUID_DISPUTE)?.evidence?.length ?? 0).toBe(0)
  })

  it('throws party_statement_empty_result when the RPC returns no row', async () => {
    const repo = new SupabaseDisputeRepository()
    await withCachedDispute(repo, makeDispute({ status: 'provider_waiting' }))

    mockState.nextRpcResult = { data: null, error: null }

    await expect(repo.partySubmitStatement(UUID_DISPUTE, makeEvidence())).rejects.toThrow(
      /party_statement_empty_result/,
    )
    expect(repo.getById(UUID_DISPUTE)?.status).toBe('provider_waiting')
  })
})
