import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkProductionGate, _resetGateCache } from '../../api/_env'

// ---------------------------------------------------------------------------
// Helpers to manage process.env + gate cache safely
// ---------------------------------------------------------------------------

const CORE_KEYS = ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const EXECUTION_KEYS = ['STRIPE_WEBHOOK_SECRET', 'CRON_SECRET', 'RELEASE_CONFIRM_SECRET', 'FUNDING_CONFIRM_SECRET']
const ALL_KEYS = [...CORE_KEYS, ...EXECUTION_KEYS, 'ALLOWED_ORIGIN', 'VERCEL_ENV']

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const key of ALL_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ALL_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function setAllEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv-key'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  process.env.CRON_SECRET = 'cron-secret'
  process.env.RELEASE_CONFIRM_SECRET = 'release-secret'
  process.env.FUNDING_CONFIRM_SECRET = 'funding-secret'
  process.env.ALLOWED_ORIGIN = 'https://app.safix.digital'
}

function setCoreOnly() {
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv-key'
  process.env.ALLOWED_ORIGIN = 'https://app.safix.digital'
  // Execution secrets intentionally absent
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.CRON_SECRET
  delete process.env.RELEASE_CONFIRM_SECRET
  delete process.env.FUNDING_CONFIRM_SECRET
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkProductionGate — scope behavior', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = saveEnv()
    _resetGateCache()
    process.env.VERCEL_ENV = 'production'
  })

  afterEach(() => {
    restoreEnv(saved)
    _resetGateCache()
  })

  it('full scope passes when all env vars are present', () => {
    setAllEnv()
    const result = checkProductionGate('full')
    expect(result.ok).toBe(true)
  })

  it('core scope passes when only core env vars are present', () => {
    setCoreOnly()
    const result = checkProductionGate('core')
    expect(result.ok).toBe(true)
  })

  it('full scope fails when execution secrets are missing', () => {
    setCoreOnly()
    const result = checkProductionGate('full')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toContain('STRIPE_WEBHOOK_SECRET')
      expect(result.missing).toContain('CRON_SECRET')
      expect(result.missing).toContain('RELEASE_CONFIRM_SECRET')
      expect(result.missing).toContain('FUNDING_CONFIRM_SECRET')
    }
  })

  it('core scope does NOT fail when execution secrets are missing', () => {
    setCoreOnly()
    const result = checkProductionGate('core')
    expect(result.ok).toBe(true)
  })

  it('core scope fails when a core secret is missing', () => {
    setCoreOnly()
    delete process.env.STRIPE_SECRET_KEY
    const result = checkProductionGate('core')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toContain('STRIPE_SECRET_KEY')
      expect(result.missing).not.toContain('CRON_SECRET')
    }
  })

  it('both scopes reject a Stripe test secret in production', () => {
    setAllEnv()
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    _resetGateCache()

    const core = checkProductionGate('core')
    expect(core.ok).toBe(false)
    if (!core.ok) {
      expect(core.missing).toContain('STRIPE_SECRET_KEY (must start with sk_live_ in production)')
    }

    _resetGateCache()
    const full = checkProductionGate('full')
    expect(full.ok).toBe(false)
  })

  it('both scopes require ALLOWED_ORIGIN in production', () => {
    setAllEnv()
    delete process.env.ALLOWED_ORIGIN
    _resetGateCache()

    const core = checkProductionGate('core')
    expect(core.ok).toBe(false)

    _resetGateCache()
    const full = checkProductionGate('full')
    expect(full.ok).toBe(false)
  })

  it('both scopes reject ALLOWED_ORIGIN = "*" in production', () => {
    setAllEnv()
    process.env.ALLOWED_ORIGIN = '*'
    _resetGateCache()

    const core = checkProductionGate('core')
    expect(core.ok).toBe(false)

    _resetGateCache()
    const full = checkProductionGate('full')
    expect(full.ok).toBe(false)
  })

  it('non-production always passes regardless of scope', () => {
    process.env.VERCEL_ENV = 'preview'
    // Remove everything
    for (const key of [...CORE_KEYS, ...EXECUTION_KEYS]) delete process.env[key]
    delete process.env.ALLOWED_ORIGIN

    expect(checkProductionGate('core').ok).toBe(true)
    _resetGateCache()
    expect(checkProductionGate('full').ok).toBe(true)
  })

  it('default scope is full', () => {
    setCoreOnly()
    const result = checkProductionGate()
    expect(result.ok).toBe(false)
  })

  it('caches results per scope independently', () => {
    setCoreOnly()
    const core1 = checkProductionGate('core')
    const full1 = checkProductionGate('full')

    expect(core1.ok).toBe(true)
    expect(full1.ok).toBe(false)

    // Second call uses cache — even if env changes
    process.env.CRON_SECRET = 'added-after'
    const core2 = checkProductionGate('core')
    const full2 = checkProductionGate('full')

    expect(core2).toBe(core1) // exact same object from cache
    expect(full2).toBe(full1)
  })
})
