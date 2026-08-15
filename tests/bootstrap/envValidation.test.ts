import { describe, it, expect } from 'vitest'
import {
  validateClientEnvWith,
  getClientEnvReportWith,
  resolveDataSourceWith,
} from '../../src/lib/env/envValidation'

// ---------------------------------------------------------------------------
// validateClientEnv
// ---------------------------------------------------------------------------

describe('validateClientEnv', () => {
  it('passes when VITE_DATA_SOURCE is in-memory (no Supabase vars needed)', () => {
    expect(() =>
      validateClientEnvWith({ VITE_DATA_SOURCE: 'in-memory' }),
    ).not.toThrow()
  })

  it('passes when VITE_DATA_SOURCE is absent (defaults to in-memory)', () => {
    expect(() => validateClientEnvWith({})).not.toThrow()
  })

  it('throws when VITE_DATA_SOURCE=supabase but VITE_SUPABASE_URL is missing', () => {
    expect(() =>
      validateClientEnvWith({
        VITE_DATA_SOURCE: 'supabase',
        VITE_SUPABASE_ANON_KEY: 'test-key',
      }),
    ).toThrow('VITE_SUPABASE_URL')
  })

  it('throws when VITE_DATA_SOURCE=supabase but VITE_SUPABASE_ANON_KEY is missing', () => {
    expect(() =>
      validateClientEnvWith({
        VITE_DATA_SOURCE: 'supabase',
        VITE_SUPABASE_URL: 'https://example.supabase.co',
      }),
    ).toThrow('VITE_SUPABASE_ANON_KEY')
  })

  it('passes when VITE_DATA_SOURCE=supabase and both Supabase vars are present', () => {
    expect(() =>
      validateClientEnvWith({
        VITE_DATA_SOURCE: 'supabase',
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'anon-key-value',
      }),
    ).not.toThrow()
  })

  it('passes when VITE_DATA_SOURCE is absent but both credentials are present (auto-detected)', () => {
    expect(() =>
      validateClientEnvWith({
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'anon-key-value',
      }),
    ).not.toThrow()
  })

  it('throws when VITE_PAYMENT_PROVIDER=stripe but VITE_STRIPE_PUBLISHABLE_KEY is missing', () => {
    expect(() =>
      validateClientEnvWith({ VITE_PAYMENT_PROVIDER: 'stripe' }),
    ).toThrow('VITE_STRIPE_PUBLISHABLE_KEY')
  })

  it('passes when VITE_PAYMENT_PROVIDER=stripe and publishable key is present', () => {
    expect(() =>
      validateClientEnvWith({
        VITE_PAYMENT_PROVIDER: 'stripe',
        VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123',
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Production provider gate
// ---------------------------------------------------------------------------

// Minimal env fixture that satisfies every prod gate EXCEPT the payment
// provider. Individual tests mutate this to exercise one gate at a time.
const PROD_ENV_BASE = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-value',
  VITE_API_BASE_URL: 'https://fix-up-psi.vercel.app',
}

describe('production provider gate', () => {
  it('throws when isProd=true and payment provider is absent (defaults to mock)', () => {
    expect(() => validateClientEnvWith(PROD_ENV_BASE, true)).toThrow(
      'VITE_PAYMENT_PROVIDER=stripe',
    )
  })

  it('throws when isProd=true and payment provider is explicitly mock', () => {
    expect(() =>
      validateClientEnvWith({ ...PROD_ENV_BASE, VITE_PAYMENT_PROVIDER: 'mock' }, true),
    ).toThrow('VITE_PAYMENT_PROVIDER=stripe')
  })

  it('passes when isProd=true and payment provider is stripe with key', () => {
    expect(() =>
      validateClientEnvWith(
        {
          ...PROD_ENV_BASE,
          VITE_PAYMENT_PROVIDER: 'stripe',
          VITE_STRIPE_PUBLISHABLE_KEY: 'pk_live_abc123',
        },
        true,
      ),
    ).not.toThrow()
  })

  it('rejects a Stripe test publishable key in production', () => {
    expect(() =>
      validateClientEnvWith(
        {
          ...PROD_ENV_BASE,
          VITE_PAYMENT_PROVIDER: 'stripe',
          VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123',
        },
        true,
      ),
    ).toThrow('pk_live_')
  })

  it('does not enforce provider gate when isProd=false', () => {
    expect(() => validateClientEnvWith({})).not.toThrow()
    expect(() =>
      validateClientEnvWith({ VITE_PAYMENT_PROVIDER: 'mock' }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Production data-source gate
// ---------------------------------------------------------------------------

describe('production data-source gate', () => {
  it('throws when isProd=true and data source resolves to in-memory', () => {
    expect(() =>
      validateClientEnvWith(
        { VITE_PAYMENT_PROVIDER: 'stripe', VITE_STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' },
        true,
      ),
    ).toThrow('Supabase data source')
  })

  it('throws when isProd=true and VITE_DATA_SOURCE is explicitly in-memory', () => {
    expect(() =>
      validateClientEnvWith(
        { VITE_DATA_SOURCE: 'in-memory', VITE_API_BASE_URL: 'https://x.vercel.app' },
        true,
      ),
    ).toThrow('Supabase data source')
  })

  it('does not enforce data-source gate when isProd=false', () => {
    expect(() => validateClientEnvWith({ VITE_DATA_SOURCE: 'in-memory' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// API-origin handling
// ---------------------------------------------------------------------------
// The API-origin requirement is enforced by apiUrl() at call time on native
// platforms, not by validateClientEnv. Same-origin web builds must therefore
// boot without VITE_API_BASE_URL set.

describe('API-origin handling', () => {
  it('passes isProd=true without VITE_API_BASE_URL (same-origin web prod)', () => {
    expect(() =>
      validateClientEnvWith(
        {
          VITE_SUPABASE_URL: 'https://example.supabase.co',
          VITE_SUPABASE_ANON_KEY: 'anon',
          VITE_PAYMENT_PROVIDER: 'stripe',
          VITE_STRIPE_PUBLISHABLE_KEY: 'pk_live_abc',
        },
        true,
      ),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// getClientEnvReport
// ---------------------------------------------------------------------------

describe('getClientEnvReport', () => {
  it('returns expected structure with status for each var', () => {
    const report = getClientEnvReportWith({
      VITE_DATA_SOURCE: 'in-memory',
      VITE_SENTRY_DSN: 'https://sentry.io/dsn',
    })

    expect(report).toHaveProperty('VITE_DATA_SOURCE')
    expect(report).toHaveProperty('VITE_SUPABASE_URL')
    expect(report).toHaveProperty('VITE_SUPABASE_ANON_KEY')
    expect(report).toHaveProperty('VITE_PAYMENT_PROVIDER')
    expect(report).toHaveProperty('VITE_STRIPE_PUBLISHABLE_KEY')
    expect(report).toHaveProperty('VITE_SENTRY_DSN')
    expect(report).toHaveProperty('VITE_STRIPE_BACKEND_URL')
  })

  it('marks VITE_DATA_SOURCE as present when set', () => {
    const report = getClientEnvReportWith({ VITE_DATA_SOURCE: 'in-memory' })
    expect(report.VITE_DATA_SOURCE).toBe('present')
  })

  it('marks Supabase vars as not_required when data source is in-memory', () => {
    const report = getClientEnvReportWith({ VITE_DATA_SOURCE: 'in-memory' })
    expect(report.VITE_SUPABASE_URL).toBe('not_required')
    expect(report.VITE_SUPABASE_ANON_KEY).toBe('not_required')
  })

  it('marks Supabase vars as missing when data source is supabase and vars absent', () => {
    const report = getClientEnvReportWith({ VITE_DATA_SOURCE: 'supabase' })
    expect(report.VITE_SUPABASE_URL).toBe('missing')
    expect(report.VITE_SUPABASE_ANON_KEY).toBe('missing')
  })

  it('marks Supabase vars as present when data source is supabase and vars configured', () => {
    const report = getClientEnvReportWith({
      VITE_DATA_SOURCE: 'supabase',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
    })
    expect(report.VITE_SUPABASE_URL).toBe('present')
    expect(report.VITE_SUPABASE_ANON_KEY).toBe('present')
  })

  it('marks Stripe publishable key as not_required when payment provider is mock', () => {
    const report = getClientEnvReportWith({ VITE_PAYMENT_PROVIDER: 'mock' })
    expect(report.VITE_STRIPE_PUBLISHABLE_KEY).toBe('not_required')
  })

  it('marks Stripe publishable key as missing when provider is stripe and key absent', () => {
    const report = getClientEnvReportWith({ VITE_PAYMENT_PROVIDER: 'stripe' })
    expect(report.VITE_STRIPE_PUBLISHABLE_KEY).toBe('missing')
  })

  it('marks VITE_SENTRY_DSN as present when configured', () => {
    const report = getClientEnvReportWith({ VITE_SENTRY_DSN: 'https://sentry.io/dsn' })
    expect(report.VITE_SENTRY_DSN).toBe('present')
  })

  it('marks VITE_SENTRY_DSN as missing when not configured', () => {
    const report = getClientEnvReportWith({})
    expect(report.VITE_SENTRY_DSN).toBe('missing')
  })

  it('marks Supabase vars as present when auto-detected (VITE_DATA_SOURCE absent, credentials set)', () => {
    const report = getClientEnvReportWith({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
    })
    expect(report.VITE_SUPABASE_URL).toBe('present')
    expect(report.VITE_SUPABASE_ANON_KEY).toBe('present')
  })
})

// ---------------------------------------------------------------------------
// resolveDataSourceWith
// ---------------------------------------------------------------------------

describe('resolveDataSourceWith', () => {
  it('returns supabase when VITE_DATA_SOURCE is explicitly supabase', () => {
    expect(resolveDataSourceWith({ VITE_DATA_SOURCE: 'supabase' })).toBe('supabase')
  })

  it('returns in-memory when VITE_DATA_SOURCE is explicitly in-memory', () => {
    expect(resolveDataSourceWith({ VITE_DATA_SOURCE: 'in-memory' })).toBe('in-memory')
  })

  it('returns in-memory when VITE_DATA_SOURCE is absent and no credentials', () => {
    expect(resolveDataSourceWith({})).toBe('in-memory')
  })

  it('auto-detects supabase when VITE_DATA_SOURCE absent but both credentials present', () => {
    expect(
      resolveDataSourceWith({
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'anon-key',
      }),
    ).toBe('supabase')
  })

  it('returns in-memory when only VITE_SUPABASE_URL is present (key absent)', () => {
    expect(
      resolveDataSourceWith({ VITE_SUPABASE_URL: 'https://example.supabase.co' }),
    ).toBe('in-memory')
  })

  it('returns in-memory when only VITE_SUPABASE_ANON_KEY is present (url absent)', () => {
    expect(resolveDataSourceWith({ VITE_SUPABASE_ANON_KEY: 'anon-key' })).toBe('in-memory')
  })

  it('explicit in-memory wins over present credentials', () => {
    expect(
      resolveDataSourceWith({
        VITE_DATA_SOURCE: 'in-memory',
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'anon-key',
      }),
    ).toBe('in-memory')
  })

  it('returns in-memory when credentials are empty strings', () => {
    expect(
      resolveDataSourceWith({
        VITE_SUPABASE_URL: '   ',
        VITE_SUPABASE_ANON_KEY: '',
      }),
    ).toBe('in-memory')
  })
})
