/**
 * Tests for api/cron/reconcile-payments.ts
 *
 * Verifies:
 *   - 405 for disallowed HTTP methods
 *   - 401 when cron secret is wrong
 *   - 503 when Supabase admin client is unavailable
 *   - 503 when STRIPE_SECRET_KEY is missing
 *   - 200 with structured summary on success
 *   - 200 with zero counts on no-op run (no risky payments)
 *   - 500 on unexpected error from reconcileRiskyPayments
 *   - Observability events emitted for started / completed / failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// ---------------------------------------------------------------------------
// Hoisted mock functions (must be defined before vi.mock factories run)
// ---------------------------------------------------------------------------

const { mockReconcileRiskyPayments } = vi.hoisted(() => ({
  mockReconcileRiskyPayments: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}))

// ---------------------------------------------------------------------------
// Mock Stripe constructor
// ---------------------------------------------------------------------------

vi.mock('stripe', () => {
  class MockStripe {}
  return { default: MockStripe }
})

// ---------------------------------------------------------------------------
// Mock _serverReconciliation
// ---------------------------------------------------------------------------

vi.mock('../../api/_serverReconciliation', () => ({
  reconcileRiskyPayments: mockReconcileRiskyPayments,
  RECONCILIATION_BATCH_LIMIT: 50,
  // Mirrors api/_serverReconciliation.ts — 'disputed' is deliberately excluded
  // (C2: disputed payments are dispute-domain, never cron-reconciled).
  RISKY_PAYMENT_STATES: ['deposit_required', 'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending'],
}))

// ---------------------------------------------------------------------------
// Mock @sentry/node
// ---------------------------------------------------------------------------

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import handler after mocks
// ---------------------------------------------------------------------------

import handler from '../../api/cron/reconcile-payments'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  headers: Record<string, string | undefined> = {},
): VercelRequest {
  return { method, headers, url: '/api/cron/reconcile-payments' } as unknown as VercelRequest
}

function makeResponse(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let _statusCode = 0
  let _body: unknown = null
  const res = {
    status: vi.fn((code: number) => {
      _statusCode = code
      return res
    }),
    json: vi.fn((b: unknown) => {
      _body = b
    }),
  } as unknown as VercelResponse
  return { res, statusCode: () => _statusCode, body: () => _body }
}

function captureInfos(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.log = orig } }
}

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.error = orig } }
}

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

describe('reconcile-payments — method guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.STRIPE_SECRET_KEY
  })

  it('returns 405 for DELETE', async () => {
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('DELETE'), res)
    expect(statusCode()).toBe(405)
  })

  it('returns 405 for PUT', async () => {
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('PUT'), res)
    expect(statusCode()).toBe(405)
  })

  it('accepts GET requests', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 0, aligned: 0, recovered: 0, inconsistent: 0, failed: 0,
    })

    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
  })

  it('accepts POST requests', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 0, aligned: 0, recovered: 0, inconsistent: 0, failed: 0,
    })

    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('POST'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Cron auth
// ---------------------------------------------------------------------------

describe('reconcile-payments — cron auth', () => {
  const SECRET = 'my-reconcile-cron-secret'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  })

  it('returns 401 when Authorization header is absent', async () => {
    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET', {}), res)
    cap.restore()

    expect(statusCode()).toBe(401)
  })

  it('returns 401 when Bearer token is wrong', async () => {
    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET', { authorization: 'Bearer wrong' }), res)
    cap.restore()

    expect(statusCode()).toBe(401)
  })

  it('proceeds when Bearer token matches CRON_SECRET', async () => {
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 0, aligned: 0, recovered: 0, inconsistent: 0, failed: 0,
    })

    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET', { authorization: `Bearer ${SECRET}` }), res)
    cap.restore()

    expect(statusCode()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Missing services
// ---------------------------------------------------------------------------

describe('reconcile-payments — missing services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
  })

  it('returns 503 when Supabase env vars are not set', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.STRIPE_SECRET_KEY

    const cap = captureErrors()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(503)
  })

  it('returns 503 when STRIPE_SECRET_KEY is not set', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    delete process.env.STRIPE_SECRET_KEY

    const cap = captureErrors()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(503)
  })

  it('returns ok:false in body for 503', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const cap = captureErrors()
    const { res, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect((body() as Record<string, unknown>).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Successful execution
// ---------------------------------------------------------------------------

describe('reconcile-payments — successful runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  })

  it('returns 200 with full summary shape', async () => {
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 10,
      aligned: 7,
      recovered: 2,
      inconsistent: 1,
      failed: 0,
    })

    const cap = captureInfos()
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
    const b = body() as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.checked).toBe(10)
    expect(b.aligned).toBe(7)
    expect(b.recovered).toBe(2)
    expect(b.inconsistent).toBe(1)
    expect(b.failed).toBe(0)
  })

  it('returns 200 with all-zero summary on no-op run', async () => {
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 0,
      aligned: 0,
      recovered: 0,
      inconsistent: 0,
      failed: 0,
    })

    const cap = captureInfos()
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
    const b = body() as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.checked).toBe(0)
  })

  it('emits cron.payment_reconciliation.started', async () => {
    mockReconcileRiskyPayments.mockResolvedValueOnce({
      checked: 0, aligned: 0, recovered: 0, inconsistent: 0, failed: 0,
    })

    const cap = captureInfos()
    const { res } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.payment_reconciliation.started')
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('reconcile-payments — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  })

  it('returns 500 when reconcileRiskyPayments throws', async () => {
    mockReconcileRiskyPayments.mockRejectedValueOnce(new Error('Stripe API unavailable'))

    const cap = captureErrors()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(500)
  })

  it('returns ok:false in body on thrown error', async () => {
    mockReconcileRiskyPayments.mockRejectedValueOnce(new Error('connection reset'))

    const cap = captureErrors()
    const { res, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect((body() as Record<string, unknown>).ok).toBe(false)
  })

  it('emits cron.payment_reconciliation.failed on error', async () => {
    mockReconcileRiskyPayments.mockRejectedValueOnce(new Error('network timeout'))

    const cap = captureErrors()
    const { res } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.payment_reconciliation.failed')
  })
})
