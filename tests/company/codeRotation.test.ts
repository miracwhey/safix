import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const { rpcMock, fromMock, getSessionMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getSessionMock: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
    auth: { getSession: getSessionMock },
  },
}))

vi.mock('../../src/lib/api/baseUrl', () => ({
  apiUrl: (p: string) => `https://api.test${p}`,
}))

import {
  rotateCompanyCode,
  getCodeAuditLog,
  sendCodeByEmail,
} from '../../src/lib/company/codeRotation'

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.order = () => chain
  chain.limit = () => Promise.resolve(result)
  chain.maybeSingle = () => Promise.resolve(result)
  return chain
}

describe('rotateCompanyCode — RPC error mapping', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('returns ok with new code on RPC success', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ new_code: 'ABCDEF', new_code_id: 'cc-1' }],
      error: null,
    })
    const result = await rotateCompanyCode('p-1')
    expect(result).toEqual({ ok: true, newCode: 'ABCDEF', newCodeId: 'cc-1' })
    expect(rpcMock).toHaveBeenCalledWith('rotate_company_code', {
      p_provider_id: 'p-1',
      p_reason: null,
    })
  })

  it('maps rate_limit_exceeded RPC error to typed result', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'rate_limit_exceeded' },
    })
    const result = await rotateCompanyCode('p-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rate_limit_exceeded')
  })

  it('maps rbac_owner_required RPC error to typed result', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'rbac_owner_required' },
    })
    const result = await rotateCompanyCode('p-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rbac_owner_required')
  })

  it('maps no_active_code RPC error to typed result', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'no_active_code' },
    })
    const result = await rotateCompanyCode('p-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_active_code')
  })

  it('maps unknown RPC error to unknown code', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'database is on fire' },
    })
    const result = await rotateCompanyCode('p-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unknown')
  })

  it('passes reason argument through to the RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ new_code: 'XYZ', new_code_id: 'cc-2' }],
      error: null,
    })
    await rotateCompanyCode('p-1', 'leak suspected')
    expect(rpcMock).toHaveBeenCalledWith('rotate_company_code', {
      p_provider_id: 'p-1',
      p_reason: 'leak suspected',
    })
  })
})

describe('getCodeAuditLog', () => {
  beforeEach(() => {
    fromMock.mockReset()
  })

  it('maps audit rows to camelCase', async () => {
    fromMock.mockReturnValueOnce(
      makeChain({
        data: [
          {
            id: 'a-1',
            provider_id: 'p-1',
            old_code_id: 'c-old',
            new_code_id: 'c-new',
            rotated_by: 'u-1',
            rotated_at: '2026-05-01T10:00:00Z',
            reason: 'leak',
          },
        ],
        error: null,
      }),
    )
    const audit = await getCodeAuditLog('p-1')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toEqual({
      id: 'a-1',
      providerId: 'p-1',
      oldCodeId: 'c-old',
      newCodeId: 'c-new',
      rotatedBy: 'u-1',
      rotatedAt: '2026-05-01T10:00:00Z',
      reason: 'leak',
    })
  })

  it('returns empty list on error', async () => {
    fromMock.mockReturnValueOnce(
      makeChain({ data: null, error: { message: 'rls denied' } }),
    )
    const audit = await getCodeAuditLog('p-1')
    expect(audit).toEqual([])
  })
})

describe('sendCodeByEmail', () => {
  const fetchMock = vi.fn()
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    getSessionMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it('returns auth error when no session token is present', async () => {
    getSessionMock.mockResolvedValueOnce({ data: { session: null } })
    const result = await sendCodeByEmail()
    expect(result).toEqual({ ok: false, error: 'Bitte erneut anmelden.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns ok and masked email on 200 response', async () => {
    getSessionMock.mockResolvedValueOnce({
      data: { session: { access_token: 'tok' } },
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sent: true, maskedEmail: 'o***@example.com' }),
    })
    const result = await sendCodeByEmail()
    expect(result).toEqual({ ok: true, maskedEmail: 'o***@example.com' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/account/team-code-email')
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok')
  })

  it('maps server error response to typed failure', async () => {
    getSessionMock.mockResolvedValueOnce({
      data: { session: { access_token: 'tok' } },
    })
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Limit von 3 E-Mails pro Stunde erreicht.' }),
    })
    const result = await sendCodeByEmail()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Limit von 3 E-Mails pro Stunde erreicht.')
    }
  })

  it('returns network failure on fetch throw', async () => {
    getSessionMock.mockResolvedValueOnce({
      data: { session: { access_token: 'tok' } },
    })
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    const result = await sendCodeByEmail()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Netzwerk')
  })
})
