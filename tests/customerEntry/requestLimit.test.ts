import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Force in-memory mode for all tests
vi.stubEnv('VITE_DATA_SOURCE', 'in-memory')

// Mock supabase to avoid real calls
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ count: 0, error: null }) }) }),
      insert: () => ({ error: null }),
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}))

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('VITE_DATA_SOURCE', 'in-memory')
})

async function loadModule() {
  return import('../../src/lib/customerEntry/requestLimitService')
}

describe('request limit service (in-memory)', () => {
  it('starts with zero sends', async () => {
    const m = await loadModule()
    m._resetInMemorySends()
    const count = await m.getSendsToday('user-1')
    expect(count).toBe(0)
  })

  it('canSendRequest returns true when under limit', async () => {
    const m = await loadModule()
    m._resetInMemorySends()
    const can = await m.canSendRequest('user-1')
    expect(can).toBe(true)
  })

  it('recordRequestSend increments the count', async () => {
    const m = await loadModule()
    m._resetInMemorySends()

    const count1 = await m.recordRequestSend('user-1', 'prov-1')
    expect(count1).toBe(1)

    const count2 = await m.recordRequestSend('user-1', 'prov-2')
    expect(count2).toBe(2)

    const sends = await m.getSendsToday('user-1')
    expect(sends).toBe(2)
  })

  it('canSendRequest returns false at limit', async () => {
    const m = await loadModule()
    m._resetInMemorySends()

    await m.recordRequestSend('user-1', 'prov-1')
    await m.recordRequestSend('user-1', 'prov-2')
    await m.recordRequestSend('user-1', 'prov-3')

    const can = await m.canSendRequest('user-1')
    expect(can).toBe(false)
  })

  it('recordRequestSend throws when limit exceeded', async () => {
    const m = await loadModule()
    m._resetInMemorySends()

    await m.recordRequestSend('user-1', 'prov-1')
    await m.recordRequestSend('user-1', 'prov-2')
    await m.recordRequestSend('user-1', 'prov-3')

    await expect(
      m.recordRequestSend('user-1', 'prov-4'),
    ).rejects.toThrow('Tageslimit erreicht')
  })

  it('remainingSendsToday returns correct value', async () => {
    const m = await loadModule()
    m._resetInMemorySends()

    expect(await m.remainingSendsToday('user-1')).toBe(3)

    await m.recordRequestSend('user-1', 'prov-1')
    expect(await m.remainingSendsToday('user-1')).toBe(2)

    await m.recordRequestSend('user-1', 'prov-2')
    await m.recordRequestSend('user-1', 'prov-3')
    expect(await m.remainingSendsToday('user-1')).toBe(0)
  })

  it('different users have independent limits', async () => {
    const m = await loadModule()
    m._resetInMemorySends()

    await m.recordRequestSend('user-1', 'prov-1')
    await m.recordRequestSend('user-1', 'prov-2')
    await m.recordRequestSend('user-1', 'prov-3')

    // user-2 should still be able to send
    const can = await m.canSendRequest('user-2')
    expect(can).toBe(true)
    expect(await m.getSendsToday('user-2')).toBe(0)
  })

  it('MAX_DAILY_SENDS is 3', async () => {
    const m = await loadModule()
    expect(m.MAX_DAILY_SENDS).toBe(3)
  })
})
