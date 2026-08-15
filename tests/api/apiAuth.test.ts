// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Tests for api/_auth.ts — the shared API authentication helper.
 *
 * Verifies:
 *   - missing Authorization header → 401
 *   - malformed Bearer token (empty, whitespace) → 401
 *   - valid header format but invalid JWT → 401
 *   - valid JWT → ok: true with userId and user
 *   - Supabase admin unavailable → 401
 *   - extractBearerToken correctly parses the header
 *   - observability events are emitted for each outcome
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest } from '@vercel/node'
import { extractBearerToken, authenticateRequest } from '../../api/_auth'

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js createClient
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock VercelRequest with the given headers.
 */
function makeRequest(headers: Record<string, string | undefined> = {}): VercelRequest {
  return {
    headers,
    url: '/api/test',
    method: 'POST',
  } as unknown as VercelRequest
}

/**
 * Capture console.warn output (used by logWarning) during a block.
 */
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
// extractBearerToken
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('returns null when Authorization header is absent', () => {
    expect(extractBearerToken(makeRequest({}))).toBeNull()
  })

  it('returns null when Authorization header is not Bearer', () => {
    expect(extractBearerToken(makeRequest({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull()
  })

  it('returns null when Bearer value is empty', () => {
    expect(extractBearerToken(makeRequest({ authorization: 'Bearer ' }))).toBeNull()
    expect(extractBearerToken(makeRequest({ authorization: 'Bearer   ' }))).toBeNull()
  })

  it('returns the token for a well-formed Bearer header', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.test.sig'
    expect(extractBearerToken(makeRequest({ authorization: `Bearer ${token}` }))).toBe(token)
  })
})

// ---------------------------------------------------------------------------
// authenticateRequest — missing / malformed token
// ---------------------------------------------------------------------------

describe('authenticateRequest — missing token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Ensure Supabase env vars are absent so admin client is unavailable.
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('returns ok:false with 401 when Authorization header is absent', async () => {
    const cap = captureWarnings()
    const result = await authenticateRequest(makeRequest({}))
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(401)
      expect(result.error).toContain('Unauthorized')
    }
  })

  it('emits api.auth.missing_token when Authorization header is absent', async () => {
    const cap = captureWarnings()
    await authenticateRequest(makeRequest({}))
    cap.restore()

    const output = cap.lines.join('\n')
    expect(output).toContain('api.auth.missing_token')
  })

  it('returns ok:false with 401 for malformed Bearer (no token)', async () => {
    const cap = captureWarnings()
    const result = await authenticateRequest(makeRequest({ authorization: 'Bearer ' }))
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.statusCode).toBe(401)
  })

  it('returns ok:false with 401 for non-Bearer Authorization', async () => {
    const cap = captureWarnings()
    const result = await authenticateRequest(makeRequest({ authorization: 'Basic abc123' }))
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// authenticateRequest — Supabase admin unavailable
// ---------------------------------------------------------------------------

describe('authenticateRequest — Supabase admin unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('returns ok:false with 503 when env vars are missing', async () => {
    const cap = captureWarnings()
    const result = await authenticateRequest(
      makeRequest({ authorization: 'Bearer validlooking.token.here' }),
    )
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(503)
    }
  })

  it('emits api.auth.invalid_token (supabase_admin_unavailable) when env vars absent', async () => {
    const cap = captureWarnings()
    await authenticateRequest(makeRequest({ authorization: 'Bearer some.token' }))
    cap.restore()

    const output = cap.lines.join('\n')
    expect(output).toContain('api.auth.invalid_token')
  })
})

// ---------------------------------------------------------------------------
// authenticateRequest — invalid / expired JWT
// ---------------------------------------------------------------------------

describe('authenticateRequest — invalid JWT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('returns ok:false with 401 when Supabase reports an auth error', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid JWT' },
    })

    const cap = captureWarnings()
    const result = await authenticateRequest(
      makeRequest({ authorization: 'Bearer expired.or.invalid.token' }),
    )
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(401)
      expect(result.error).toContain('Unauthorized')
    }
  })

  it('emits api.auth.invalid_token when JWT validation fails', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'token expired' },
    })

    const cap = captureWarnings()
    await authenticateRequest(makeRequest({ authorization: 'Bearer bad.token' }))
    cap.restore()

    const output = cap.lines.join('\n')
    expect(output).toContain('api.auth.invalid_token')
  })

  it('returns ok:false when Supabase returns no error but user is null', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null })

    const cap = captureWarnings()
    const result = await authenticateRequest(makeRequest({ authorization: 'Bearer ghost.token' }))
    cap.restore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// authenticateRequest — valid token
// ---------------------------------------------------------------------------

describe('authenticateRequest — valid token', () => {
  const fakeUser = {
    id: 'user-uuid-123',
    email: 'test@example.com',
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2024-01-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('returns ok:true with userId and user when JWT is valid', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: fakeUser }, error: null })

    const cap = captureInfos()
    const result = await authenticateRequest(
      makeRequest({ authorization: 'Bearer valid.jwt.token' }),
    )
    cap.restore()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.userId).toBe('user-uuid-123')
      expect(result.user).toMatchObject({ id: 'user-uuid-123', email: 'test@example.com' })
    }
  })

  it('emits api.auth.verified with userId on success', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: fakeUser }, error: null })

    const cap = captureInfos()
    await authenticateRequest(makeRequest({ authorization: 'Bearer valid.jwt.token' }))
    cap.restore()

    const output = cap.lines.join('\n')
    expect(output).toContain('api.auth.verified')
    expect(output).toContain('user-uuid-123')
  })

  it('passes the raw token to Supabase auth.getUser', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: fakeUser }, error: null })

    const cap = captureInfos()
    await authenticateRequest(makeRequest({ authorization: 'Bearer my.exact.token' }))
    cap.restore()

    expect(mockGetUser).toHaveBeenCalledWith('my.exact.token')
  })
})
