import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateServerEnv } from '../../api/_env'

// ---------------------------------------------------------------------------
// Helpers to manage process.env safely
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const ALL_KEYS = [
  ...REQUIRED_KEYS,
  'STRIPE_WEBHOOK_SECRET',
  'ALLOWED_ORIGIN',
  'CRON_SECRET',
]

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const key of ALL_KEYS) {
    saved[key] = process.env[key]
  }
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ALL_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
}

function clearRequiredEnv() {
  for (const key of REQUIRED_KEYS) {
    delete process.env[key]
  }
}

function setRequiredEnv() {
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_abc123'
  process.env['SUPABASE_URL'] = 'https://example.supabase.co'
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-key-value'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateServerEnv', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = saveEnv()
    clearRequiredEnv()
  })

  afterEach(() => {
    restoreEnv(saved)
  })

  it('returns ok: false with all missing keys when no env vars are set', () => {
    const result = validateServerEnv()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toContain('STRIPE_SECRET_KEY')
      expect(result.missing).toContain('SUPABASE_URL')
      expect(result.missing).toContain('SUPABASE_SERVICE_ROLE_KEY')
    }
  })

  it('returns ok: false with missing: [STRIPE_SECRET_KEY] when only that key is absent', () => {
    process.env['SUPABASE_URL'] = 'https://example.supabase.co'
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-key'
    const result = validateServerEnv()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual(['STRIPE_SECRET_KEY'])
    }
  })

  it('returns ok: false with missing: [SUPABASE_URL] when only that key is absent', () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_abc'
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-key'
    const result = validateServerEnv()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual(['SUPABASE_URL'])
    }
  })

  it('returns ok: false with missing: [SUPABASE_SERVICE_ROLE_KEY] when only that key is absent', () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_abc'
    process.env['SUPABASE_URL'] = 'https://example.supabase.co'
    const result = validateServerEnv()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY'])
    }
  })

  it('returns ok: true with config when all required vars are present', () => {
    setRequiredEnv()
    const result = validateServerEnv()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.stripeSecretKey).toBe('sk_test_abc123')
      expect(result.config.supabaseUrl).toBe('https://example.supabase.co')
      expect(result.config.supabaseServiceRoleKey).toBe('service-role-key-value')
    }
  })

  it('sets optional fields to null when not provided', () => {
    setRequiredEnv()
    delete process.env['STRIPE_WEBHOOK_SECRET']
    delete process.env['ALLOWED_ORIGIN']
    delete process.env['CRON_SECRET']
    const result = validateServerEnv()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.stripeWebhookSecret).toBeNull()
      expect(result.config.allowedOrigin).toBeNull()
      expect(result.config.cronSecret).toBeNull()
    }
  })

  it('includes optional fields when provided', () => {
    setRequiredEnv()
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test'
    process.env['ALLOWED_ORIGIN'] = 'https://app.safix.digital'
    process.env['CRON_SECRET'] = 'cron-secret-value'
    const result = validateServerEnv()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.stripeWebhookSecret).toBe('whsec_test')
      expect(result.config.allowedOrigin).toBe('https://app.safix.digital')
      expect(result.config.cronSecret).toBe('cron-secret-value')
    }
  })

  it('does not throw — returns structured result instead', () => {
    expect(() => validateServerEnv()).not.toThrow()
  })
})
