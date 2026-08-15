/**
 * SupabaseSpatialSceneRepository · H1 CAS + L4.b verify-state RPC — Supabase
 * impl unit tests with a fully-mocked client (mirrors editHistoryRepository.test).
 *
 * Asserts the protocol contract the in-memory repo cannot model:
 *   - update() bumps parametric_version and compares-and-sets it
 *     (.eq('parametric_version', expected)); a 0-row result is a CONFLICT.
 *   - updateCustomerVerifyState() routes through the SECURITY DEFINER RPC
 *     spatial_set_customer_verify_state with NULL-safe p_state/p_stage and
 *     does NOT forward the client active-at (the server stamps now()).
 *
 * NOTE: this is protocol-shape verification, not RLS enforcement — the real
 * recipient gate / column-scoping is verified by the migration-text test
 * + the pre-deploy MCP repro against Prod.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const rpcMock = vi.fn()
const fromMock = vi.fn()
vi.mock('../../../../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}))

import { SupabaseSpatialSceneRepository } from '../../../../../src/lib/spatial/canonical/repository/SupabaseSpatialSceneRepository.ts'

interface Row {
  id: string
  source_scan_id: string | null
  source_job_id: string | null
  parent_scene_id: string | null
  parametric_storage_path: string
  parametric_size_bytes: number | null
  parametric_sha256: string | null
  parametric_version: number
  schema_version: string
  validation_state: string
  is_renderable: boolean
  requires_user_confirmation: boolean
  customer_verify_state: string
  customer_verify_last_stage: number | null
  customer_verify_last_active_at: string | null
  customer_id: string | null
  provider_id: string | null
  provider_org_id: string | null
  metadata: Record<string, unknown>
  origin: string
  created_at: string
  updated_at: string
}

function buildRow(over: Partial<Row> = {}): Row {
  return {
    id: 's1',
    source_scan_id: 'scan-1',
    source_job_id: null,
    parent_scene_id: null,
    parametric_storage_path: 'a.gz',
    parametric_size_bytes: null,
    parametric_sha256: null,
    parametric_version: 0,
    schema_version: '1.0',
    validation_state: 'pending',
    is_renderable: false,
    requires_user_confirmation: false,
    customer_verify_state: 'not_started',
    customer_verify_last_stage: null,
    customer_verify_last_active_at: null,
    customer_id: 'cust-1',
    provider_id: null,
    provider_org_id: null,
    metadata: {},
    origin: 'roomplan',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

// FIFO of terminal results consumed by maybeSingle()/returns()/single().
const terminalQueue: Array<{ data: unknown; error: unknown }> = []
const eqCalls: Array<[string, unknown]> = []
const updatePayloads: Array<Record<string, unknown>> = []

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.order = () => c
  c.limit = () => c
  c.update = (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return c
  }
  c.eq = (col: string, val: unknown) => {
    eqCalls.push([col, val])
    return c
  }
  c.maybeSingle = async () => terminalQueue.shift()
  c.single = async () => terminalQueue.shift()
  c.returns = async () => terminalQueue.shift()
  return c
}

describe('SupabaseSpatialSceneRepository · update() H1 compare-and-set', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    fromMock.mockReset()
    terminalQueue.length = 0
    eqCalls.length = 0
    updatePayloads.length = 0
    fromMock.mockImplementation(() => chain())
  })

  it('bumps parametric_version and pins the expected version in the WHERE', async () => {
    terminalQueue.push({ data: buildRow({ parametric_version: 3 }), error: null }) // findById
    terminalQueue.push({
      data: [buildRow({ parametric_version: 4, parametric_storage_path: 'b.gz' })],
      error: null,
    }) // update().returns()

    const repo = new SupabaseSpatialSceneRepository()
    const result = await repo.update('s1', { parametricStoragePath: 'b.gz' })

    expect(eqCalls).toContainEqual(['parametric_version', 3])
    // Both predicates must be present — a CAS that dropped .eq('id') would
    // version-match-update every row at that version.
    expect(eqCalls).toContainEqual(['id', 's1'])
    expect(updatePayloads[0].parametric_version).toBe(4)
    expect(result.parametricVersion).toBe(4)
  })

  it('throws CanonicalError(CONFLICT) when the CAS matches zero rows', async () => {
    terminalQueue.push({ data: buildRow({ parametric_version: 3 }), error: null }) // findById
    terminalQueue.push({ data: [], error: null }) // update().returns() — CAS miss

    const repo = new SupabaseSpatialSceneRepository()
    await expect(repo.update('s1', { parametricStoragePath: 'b.gz' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})

describe('SupabaseSpatialSceneRepository · updateCustomerVerifyState() L4.b RPC', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    fromMock.mockReset()
  })

  it('calls spatial_set_customer_verify_state with the mapped state + stage', async () => {
    rpcMock.mockResolvedValue({
      data: buildRow({ customer_verify_state: 'in_progress', customer_verify_last_stage: 2 }),
      error: null,
    })
    const repo = new SupabaseSpatialSceneRepository()
    const result = await repo.updateCustomerVerifyState('s1', {
      customerVerifyState: 'in_progress',
      customerVerifyLastStage: 2,
      // intentionally passed — the server stamps now(), so it must NOT be forwarded
      customerVerifyLastActiveAt: '2026-06-01T10:00:00.000Z',
    })

    expect(rpcMock).toHaveBeenCalledWith('spatial_set_customer_verify_state', {
      p_scene_id: 's1',
      p_state: 'in_progress',
      p_stage: 2,
    })
    expect(result.customerVerifyState).toBe('in_progress')
    expect(result.customerVerifyLastStage).toBe(2)
  })

  it('passes NULL p_state for a stage-only touch (no FSM transition)', async () => {
    rpcMock.mockResolvedValue({ data: buildRow({ customer_verify_last_stage: 4 }), error: null })
    const repo = new SupabaseSpatialSceneRepository()
    await repo.updateCustomerVerifyState('s1', { customerVerifyLastStage: 4 })

    expect(rpcMock).toHaveBeenCalledWith('spatial_set_customer_verify_state', {
      p_scene_id: 's1',
      p_state: null,
      p_stage: 4,
    })
  })
})
