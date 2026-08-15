import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ tag: 'admin-client' })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'VITE_SUPABASE_URL']
const savedEnv: Record<string, string | undefined> = {}

function clearSupabaseEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

async function loadModule() {
  vi.resetModules()
  return import('../../api/_supabase')
}

describe('getSupabaseAdminWithStatus', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  beforeEach(() => {
    clearSupabaseEnv()
    mockCreateClient.mockClear()
  })

  it('reports missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY when unset', async () => {
    const { getSupabaseAdminWithStatus } = await loadModule()

    const result = getSupabaseAdminWithStatus()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
    }
  })

  it('creates an admin client when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present', async () => {
    process.env.SUPABASE_URL = 'https://project.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const { getSupabaseAdminWithStatus } = await loadModule()

    const result = getSupabaseAdminWithStatus()

    expect(result.ok).toBe(true)
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'service-role-key',
      expect.objectContaining({
        auth: { autoRefreshToken: false, persistSession: false },
      }),
    )
  })

  it('falls back to SUPABASE_SERVICE_KEY when service role key is absent', async () => {
    process.env.SUPABASE_URL = 'https://project.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key-fallback'
    const { getSupabaseAdminWithStatus } = await loadModule()

    const result = getSupabaseAdminWithStatus()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.client).toEqual({ tag: 'admin-client' })
    }
  })

  it('treats whitespace-only env vars as missing', async () => {
    process.env.SUPABASE_URL = '   '
    process.env.SUPABASE_SERVICE_ROLE_KEY = '   '
    const { getSupabaseAdminWithStatus } = await loadModule()

    const result = getSupabaseAdminWithStatus()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
    }
  })
})
