// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Tests for api/_cronAuth.ts — the cron job authentication guard.
 *
 * Verifies:
 *   - When CRON_SECRET is absent, all requests are permitted (dev bypass)
 *   - When CRON_SECRET is set, missing Authorization header → 401
 *   - Non-Bearer Authorization header → 401
 *   - Wrong secret value → 401
 *   - Correct secret value → ok: true
 *   - Observability events are emitted for each outcome
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest } from '@vercel/node'
import { authenticateCronRequest } from '../../api/_cronAuth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string | undefined> = {}): VercelRequest {
  return { headers, url: '/api/cron/test', method: 'GET' } as unknown as VercelRequest
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.warn = orig } }
}

function captureInfos(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.log = orig } }
}

// ---------------------------------------------------------------------------
// When CRON_SECRET is absent (dev bypass)
// ---------------------------------------------------------------------------

describe('authenticateCronRequest — CRON_SECRET not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CRON_SECRET
  })

  it('returns ok:true without checking the Authorization header', () => {
    const cap = captureInfos()
    const result = authenticateCronRequest(makeRequest({}))
    cap.restore()

    expect(result.ok).toBe(true)
  })

  it('emits cron.auth.bypassed', () => {
    const cap = captureInfos()
    authenticateCronRequest(makeRequest({}))
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.auth.bypassed')
  })

  it('returns ok:true even when Authorization header is present but wrong', () => {
    const cap = captureInfos()
    const result = authenticateCronRequest(
      makeRequest({ authorization: 'Bearer wrong-secret' }),
    )
    cap.restore()

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// When CRON_SECRET is configured
// ---------------------------------------------------------------------------

describe('authenticateCronRequest — CRON_SECRET configured', () => {
  const SECRET = 'test-cron-secret-value'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = SECRET
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('returns ok:false with 401 when Authorization header is absent', () => {
    const cap = captureWarnings()
    const result = authenticateCronRequest(makeRequest({}))
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(401)
      expect(result.error).toContain('Unauthorized')
    }
  })

  it('emits cron.auth.missing_token when Authorization header is absent', () => {
    const cap = captureWarnings()
    authenticateCronRequest(makeRequest({}))
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.auth.missing_token')
  })

  it('returns ok:false with 401 for non-Bearer Authorization', () => {
    const cap = captureWarnings()
    const result = authenticateCronRequest(
      makeRequest({ authorization: 'Basic dXNlcjpwYXNz' }),
    )
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.statusCode).toBe(401)
  })

  it('emits cron.auth.missing_token for non-Bearer header', () => {
    const cap = captureWarnings()
    authenticateCronRequest(makeRequest({ authorization: 'Basic abc' }))
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.auth.missing_token')
  })

  it('returns ok:false with 401 when token does not match CRON_SECRET', () => {
    const cap = captureWarnings()
    const result = authenticateCronRequest(
      makeRequest({ authorization: 'Bearer wrong-secret' }),
    )
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.statusCode).toBe(401)
  })

  it('emits cron.auth.invalid_token when token does not match', () => {
    const cap = captureWarnings()
    authenticateCronRequest(makeRequest({ authorization: 'Bearer wrong-secret' }))
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.auth.invalid_token')
  })

  it('returns ok:true when token matches CRON_SECRET exactly', () => {
    const cap = captureInfos()
    const result = authenticateCronRequest(
      makeRequest({ authorization: `Bearer ${SECRET}` }),
    )
    cap.restore()

    expect(result.ok).toBe(true)
  })

  it('emits cron.auth.verified on success', () => {
    const cap = captureInfos()
    authenticateCronRequest(makeRequest({ authorization: `Bearer ${SECRET}` }))
    cap.restore()

    expect(cap.lines.join('\n')).toContain('cron.auth.verified')
  })
})
