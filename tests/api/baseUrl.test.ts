import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('apiUrl base normalization', () => {
  it('does not duplicate /api when a configured absolute base already includes it', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_API_BASE_URL', 'https://app.safix.digital/api')
    vi.stubEnv('VITE_STRIPE_BACKEND_URL', '')
    const { apiUrl } = await import('../../src/lib/api/baseUrl')

    expect(apiUrl('/api/payout-account-status')).toBe('https://app.safix.digital/api/payout-account-status')
  })
})
