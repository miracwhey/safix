/**
 * Tests for api/cron/cleanup-stale-webhooks.ts
 *
 * Verifies:
 *   - 405 for disallowed HTTP methods
 *   - 401 when cron secret is wrong
 *   - 503 when Supabase admin client is unavailable
 *   - 200 with structured result on success (including no-op / empty-result path)
 *   - 500 on unexpected error from cleanupStaleWebhookEvents
 *   - Observability events emitted for started / completed / failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// ---------------------------------------------------------------------------
// Hoisted mock functions (must be defined before vi.mock factories run)
// ---------------------------------------------------------------------------

const { mockCleanupStaleWebhookEvents } = vi.hoisted(() => ({
  mockCleanupStaleWebhookEvents: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock Supabase createClient
// ---------------------------------------------------------------------------

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}))

// ---------------------------------------------------------------------------
// Mock _webhookProcessingRecovery
// ---------------------------------------------------------------------------

vi.mock('../../api/_webhookProcessingRecovery', () => ({
  cleanupStaleWebhookEvents: mockCleanupStaleWebhookEvents,
  STALE_PROCESSING_THRESHOLD_MS: 600_000,
  CLEANUP_BATCH_LIMIT: 100,
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

import handler from '../../api/cron/cleanup-stale-webhooks'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  headers: Record<string, string | undefined> = {},
): VercelRequest {
  return { method, headers, url: '/api/cron/cleanup-stale-webhooks' } as unknown as VercelRequest
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

describe('cleanup-stale-webhooks — method guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
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
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({ checked: 0, recovered: 0, failedToUpdate: 0 })

    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
  })

  it('accepts POST requests', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({ checked: 0, recovered: 0, failedToUpdate: 0 })

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

describe('cleanup-stale-webhooks — cron auth', () => {
  const SECRET = 'my-cron-secret'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
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
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({ checked: 0, recovered: 0, failedToUpdate: 0 })

    const cap = captureInfos()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET', { authorization: `Bearer ${SECRET}` }), res)
    cap.restore()

    expect(statusCode()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Supabase unavailable
// ---------------------------------------------------------------------------

describe('cleanup-stale-webhooks — Supabase unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('returns 503 when Supabase env vars are not set', async () => {
    const cap = captureErrors()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(503)
  })

  it('returns ok:false in body when Supabase unavailable', async () => {
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

describe('cleanup-stale-webhooks — successful runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('returns 200 with checked/recovered/failedToUpdate counts', async () => {
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({
      checked: 5,
      recovered: 4,
      failedToUpdate: 1,
    })

    const cap = captureInfos()
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
    const b = body() as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.checked).toBe(5)
    expect(b.recovered).toBe(4)
    expect(b.failedToUpdate).toBe(1)
  })

  it('returns 200 with zeros when there are no stale events (no-op run)', async () => {
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({
      checked: 0,
      recovered: 0,
      failedToUpdate: 0,
    })

    const cap = captureInfos()
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(200)
    const b = body() as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.checked).toBe(0)
    expect(b.recovered).toBe(0)
    expect(b.failedToUpdate).toBe(0)
  })

  it('emits cron.cleanup_stale_webhooks.started', async () => {
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({ checked: 0, recovered: 0, failedToUpdate: 0 })

    const cap = captureInfos()
    const { res } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.cleanup_stale_webhooks.started')
  })

  it('emits cron.cleanup_stale_webhooks.completed', async () => {
    mockCleanupStaleWebhookEvents.mockResolvedValueOnce({ checked: 2, recovered: 2, failedToUpdate: 0 })

    const cap = captureInfos()
    const { res } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.cleanup_stale_webhooks.completed')
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('cleanup-stale-webhooks — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('returns 500 when cleanupStaleWebhookEvents throws', async () => {
    mockCleanupStaleWebhookEvents.mockRejectedValueOnce(new Error('DB connection lost'))

    const cap = captureErrors()
    const { res, statusCode } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(statusCode()).toBe(500)
  })

  it('returns ok:false in body on thrown error', async () => {
    mockCleanupStaleWebhookEvents.mockRejectedValueOnce(new Error('connection timeout'))

    const cap = captureErrors()
    const { res, body } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect((body() as Record<string, unknown>).ok).toBe(false)
  })

  it('emits cron.cleanup_stale_webhooks.failed on error', async () => {
    mockCleanupStaleWebhookEvents.mockRejectedValueOnce(new Error('unexpected failure'))

    const cap = captureErrors()
    const { res } = makeResponse()
    await handler(makeRequest('GET'), res)
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.cleanup_stale_webhooks.failed')
  })
})
