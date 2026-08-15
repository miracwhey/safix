// vi.mock hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Block 7.2.1d — POST /api/account/team-code-email role gate, rate-limit,
 * and happy path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

type ProfileRow = {
  role: 'customer' | 'craftsman' | null
  craftsman_role: 'owner' | 'worker' | null
  is_operator: boolean
} | null

type TableResult = { data: unknown; error: unknown } | undefined

const mockGetUser = vi.fn()
const mockGetUserById = vi.fn()
const tableResults: Record<string, TableResult[]> = {}

function queueTableResult(table: string, result: TableResult): void {
  if (!tableResults[table]) tableResults[table] = []
  tableResults[table].push(result)
}

function nextTableResult(table: string): TableResult {
  const queue = tableResults[table]
  if (!queue || queue.length === 0) return { data: null, error: null }
  return queue.shift() ?? { data: null, error: null }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { getUserById: mockGetUserById },
    },
    from: (table: string) => {
      const result = nextTableResult(table)
      const chain: Record<string, unknown> = {}
      const passthrough = () => chain
      chain.select = passthrough
      chain.eq = passthrough
      chain.maybeSingle = () => Promise.resolve(result ?? { data: null, error: null })
      return chain
    },
  })),
}))

const FAKE_OWNER = {
  id: 'owner-uuid',
  email: 'owner@example.com',
  aud: 'authenticated',
  role: 'authenticated',
}
const FAKE_WORKER = { ...FAKE_OWNER, id: 'worker-uuid', email: 'worker@example.com' }
const FAKE_CUSTOMER = { ...FAKE_OWNER, id: 'cust-uuid', email: 'cust@example.com' }

function makeReq(): VercelRequest {
  return {
    method: 'POST',
    url: '/api/account/team-code-email',
    headers: { authorization: 'Bearer fake.jwt' },
    body: {},
    query: {},
  } as unknown as VercelRequest
}

interface Captured {
  statusCode: number
  body: unknown
  headers: Record<string, string>
}

function makeRes(): { res: VercelResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: undefined, headers: {} }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value
    },
    end() {
      return res
    },
  } as unknown as VercelResponse
  return { res, captured }
}

function setProfile(profile: ProfileRow): void {
  queueTableResult('profiles', { data: profile, error: null })
}

function setSupabaseEnv(): void {
  process.env.SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  process.env.RESEND_API_KEY = 'resend-test'
  process.env.NOTIFICATION_FROM_EMAIL = 'noreply@fixup.test'
}

function silenceLogs(): { restore: () => void } {
  const w = console.warn
  const l = console.log
  const e = console.error
  console.warn = () => {}
  console.log = () => {}
  console.error = () => {}
  return {
    restore: () => {
      console.warn = w
      console.log = l
      console.error = e
    },
  }
}

function isForbidden(captured: Captured): boolean {
  return (
    captured.statusCode === 403 &&
    (captured.body as { code?: string } | undefined)?.code === 'forbidden_role'
  )
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  setSupabaseEnv()
  for (const k of Object.keys(tableResults)) delete tableResults[k]
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

describe('POST /api/account/team-code-email — role gate', () => {
  it('returns 403 forbidden_role for worker JWT', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_WORKER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'worker', is_operator: false })

    const { default: handler } = await import('../../api/account/team-code-email.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq(), res)
    cap.restore()

    expect(isForbidden(captured)).toBe(true)
  })

  it('returns 403 forbidden_role for customer JWT', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    const { default: handler } = await import('../../api/account/team-code-email.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq(), res)
    cap.restore()

    expect(isForbidden(captured)).toBe(true)
  })

  it('rejects non-POST methods with 405', async () => {
    const { default: handler } = await import('../../api/account/team-code-email.js')
    const { res, captured } = makeRes()
    const req = { ...makeReq(), method: 'GET' } as unknown as VercelRequest
    await handler(req, res)
    expect(captured.statusCode).toBe(405)
  })
})

describe('POST /api/account/team-code-email — happy path + provider missing', () => {
  it('sends email and returns masked recipient on success', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })
    queueTableResult('providers', { data: { id: 'p-1' }, error: null })
    queueTableResult('company_join_codes', { data: { code: 'ABCDEF' }, error: null })
    mockGetUserById.mockResolvedValueOnce({
      data: { user: { id: FAKE_OWNER.id, email: FAKE_OWNER.email } },
      error: null,
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'resend-msg-1' }),
    })

    const { default: handler } = await import('../../api/account/team-code-email.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq(), res)
    cap.restore()

    expect(captured.statusCode).toBe(200)
    const body = captured.body as { sent?: boolean; maskedEmail?: string }
    expect(body.sent).toBe(true)
    expect(body.maskedEmail).toContain('@example.com')
    expect(body.maskedEmail).not.toBe(FAKE_OWNER.email)
  })

  it('returns 404 when no provider profile is linked to the owner', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })
    queueTableResult('providers', { data: null, error: null })

    const { default: handler } = await import('../../api/account/team-code-email.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq(), res)
    cap.restore()

    expect(captured.statusCode).toBe(404)
  })
})
