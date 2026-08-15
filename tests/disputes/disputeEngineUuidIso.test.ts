/**
 * Block 5.5c — Dispute Domain UUID/ISO Completion
 *
 * Asserts that `createDispute` (the only domain entry point that mints a fresh
 * `Dispute`) produces a UUID-v4 id and ISO 8601 timestamptz strings — never
 * synthetic `dispute-${jobId}-${ms}` ids and never epoch-ms numbers.
 *
 * Also pins the `SupabaseDisputeRepository` UUID guard: a non-UUID `dispute.id`
 * must be rejected at the boundary with a clear error rather than silently
 * normalised, so domain-side ID bugs surface loudly.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    from: vi.fn().mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
    })),
    channel: vi.fn().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: function (this: any) { return this },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe: function (this: any) { return this },
    }),
    removeChannel: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}))

import { createDispute } from '../../src/lib/disputes/disputeEngine'
import { SupabaseDisputeRepository } from '../../src/lib/disputes/repository/SupabaseDisputeRepository'
import { isValidUUID } from '../../src/lib/shared/generateUUID'

describe('Block 5.5c — createDispute UUID + ISO contract', () => {
  it('mints a UUID-v4 compatible id (not a `dispute-${jobId}-${ms}` synthetic id)', () => {
    const dispute = createDispute({
      jobId: '00000000-0000-4000-8000-000000000001',
      reason: 'work_quality',
      title: 'T',
      description: 'D',
    })

    expect(isValidUUID(dispute.id)).toBe(true)
    expect(dispute.id).not.toMatch(/^dispute-/)
    expect(dispute.id).not.toContain(dispute.jobId)
  })

  it('produces ISO 8601 timestamptz strings for createdAt + updatedAt (no epoch-ms numbers)', () => {
    const before = Date.now()
    const dispute = createDispute({
      jobId: '00000000-0000-4000-8000-000000000002',
      reason: 'work_quality',
      title: 'T',
      description: 'D',
    })
    const after = Date.now()

    expect(typeof dispute.createdAt).toBe('string')
    expect(typeof dispute.updatedAt).toBe('string')
    expect(dispute.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(dispute.updatedAt).toBe(dispute.createdAt)
    const ms = Date.parse(dispute.createdAt)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })

  it('does not preset settlementStatus — pending is set on resolve, not on open', () => {
    const dispute = createDispute({
      jobId: '00000000-0000-4000-8000-000000000003',
      reason: 'work_quality',
      title: 'T',
      description: 'D',
    })
    expect(dispute.settlementStatus).toBeUndefined()
    expect(dispute.status).toBe('open')
    expect(dispute.resolvedAt).toBeUndefined()
  })

  it('returns a fresh UUID per invocation (no collisions even with identical params)', () => {
    const params = {
      jobId: '00000000-0000-4000-8000-000000000004',
      reason: 'work_quality' as const,
      title: 'T',
      description: 'D',
    }
    const a = createDispute(params)
    const b = createDispute(params)
    expect(a.id).not.toBe(b.id)
    expect(isValidUUID(a.id)).toBe(true)
    expect(isValidUUID(b.id)).toBe(true)
  })
})

describe('Block 5.5c — SupabaseDisputeRepository UUID guard', () => {
  const NON_UUID_DISPUTE = {
    id: 'dispute-job-1-1234567890',
    jobId: '00000000-0000-4000-8000-00000000aaaa',
    status: 'open' as const,
    reason: 'work_quality' as const,
    title: 'T',
    description: 'D',
    createdAt: '2026-04-28T10:00:00.000Z',
    updatedAt: '2026-04-28T10:00:00.000Z',
  }

  it('add() refuses to insert a dispute with a non-UUID id (no silent normalisation)', async () => {
    const repo = new SupabaseDisputeRepository()
    await expect(repo.add(NON_UUID_DISPUTE)).rejects.toThrow(/dispute_id_not_uuid/)
  })

  it('openDisputeAtomic() refuses to call the RPC when dispute.id is not a UUID', async () => {
    const repo = new SupabaseDisputeRepository()
    await expect(repo.openDisputeAtomic(NON_UUID_DISPUTE)).rejects.toThrow(/dispute_id_not_uuid/)
  })

  it('add() accepts a freshly-minted createDispute() result without raising', async () => {
    const dispute = createDispute({
      jobId: '00000000-0000-4000-8000-00000000bbbb',
      reason: 'work_quality',
      title: 'T',
      description: 'D',
    })
    const repo = new SupabaseDisputeRepository()
    await expect(repo.add(dispute)).resolves.toBeUndefined()
  })
})
