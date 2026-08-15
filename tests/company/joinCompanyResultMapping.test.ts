import { describe, it, expect, beforeEach, vi } from 'vitest'

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
}))

import { joinCompanyWithCode } from '../../src/lib/company/joinCode'

describe('joinCompanyWithCode — Block 4 reason mapping', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('maps invalid_format reason from RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Code muss 6 Zeichen aus A–Z (ohne I, O) und 2–9 sein.',
        code: 'invalid_format',
      },
      error: null,
    })
    const result = await joinCompanyWithCode('abc', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid_format')
      expect(result.error).toContain('A–Z')
    }
  })

  it('maps not_found reason from RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Code unbekannt. Bitte den aktuellen Code beim Chef erfragen.',
        code: 'not_found',
      },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not_found')
  })

  it('maps rotated reason from RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Dieser Code wurde geändert. Bitte den neuen Code erfragen.',
        code: 'rotated',
      },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rotated')
  })

  it('maps expired reason from RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Dieser Code ist abgelaufen.',
        code: 'expired',
      },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('expired')
  })

  it('maps rate_limited reason from RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Zu viele Versuche. Bitte in einer Stunde nochmal.',
        code: 'rate_limited',
      },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rate_limited')
  })

  it('falls back to "unknown" when RPC returns an unrecognised code', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { ok: false, error: 'something weird', code: 'mystery_code' },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unknown')
  })

  it('preserves legacy invalid_code for mid-deploy compat', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { ok: false, error: 'Code ungültig oder abgelaufen.', code: 'invalid_code' },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_code')
  })

  it('returns unknown + generic copy when supabase rpc errors', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'network down' },
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unknown')
      expect(result.error).toContain('Verbindung')
    }
  })

  it('returns success with providerId on ok=true', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { ok: true, provider_id: 'p-acme' },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.providerId).toBe('p-acme')
      expect(result.matchedStub).toBeUndefined()
    }
  })

  it('surfaces matchedStub flag when RPC matched a stub by email', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { ok: true, provider_id: 'p-acme', matched_stub: true },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.matchedStub).toBe(true)
  })

  it('uses default copy when RPC omits the error string', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { ok: false, code: 'rate_limited' },
      error: null,
    })
    const result = await joinCompanyWithCode('AB3X7K', 'Anna')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('rate_limited')
      expect(result.error).toContain('Versuche')
    }
  })
})
