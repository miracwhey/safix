import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock wird zur Top-Datei gehoistet — Mocks müssen via vi.hoisted erstellt
// werden, damit sie zur Mock-Eval-Zeit existieren.
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock },
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import { recordPushActionAttempt } from '../../src/lib/notifications/pushActionAudit'

describe('Block A · M1 · pushActionAudit · recordPushActionAttempt', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('calls record_push_action_attempt RPC with notification_id + action_id', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null })
    await recordPushActionAttempt('sig-uuid-1', 'APPROVE')
    expect(rpcMock).toHaveBeenCalledWith('record_push_action_attempt', {
      p_notification_id: 'sig-uuid-1',
      p_action_id: 'APPROVE',
    })
  })

  it('returns true when RPC returns true (first attempt)', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null })
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(true)
  })

  it('returns false when RPC returns false (duplicate)', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null })
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(false)
  })

  it('returns false when RPC returns null (server-side guard rejected input)', async () => {
    // RPC gibt NULL zurück, wenn auth.uid() oder Input-Validation fehlschlägt
    // (siehe Migration 20260507000006). Adapter MUSS das als duplicate
    // werten — never-throw, never-skip.
    rpcMock.mockResolvedValue({ data: null, error: null })
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(false)
  })

  it('returns false when RPC returns an error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'PGRST116: function not found', code: 'PGRST116' },
    })
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(false)
  })

  it('returns false when supabase.rpc throws synchronously', async () => {
    rpcMock.mockImplementation(() => {
      throw new Error('network down')
    })
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(false)
  })

  it('returns false when supabase.rpc rejects asynchronously', async () => {
    rpcMock.mockRejectedValue(new Error('timeout'))
    const result = await recordPushActionAttempt('sig-1', 'APPROVE')
    expect(result).toBe(false)
  })

  it('passes through REJECT action_id verbatim', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null })
    await recordPushActionAttempt('sig-2', 'REJECT')
    expect(rpcMock).toHaveBeenCalledWith('record_push_action_attempt', {
      p_notification_id: 'sig-2',
      p_action_id: 'REJECT',
    })
  })
})
