// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Integrationstest für /api/submit-widerruf (§356a-Widerrufsbutton).
 *
 * Deckt den vollen Endpunkt-Kontrakt ab: requireOwner-Gate, fail-closed bei
 * fehlender Resend-Konfiguration (§356a Abs. 3 verlangt die Eingangsbestätigung
 * auf dauerhaftem Datenträger — ohne Versand darf der Widerruf NICHT erfasst
 * werden), Email-Validierung, append-only-Insert, confirmationSent-Abbildung
 * von Resend-Erfolg/-Fehler, und das Stunden-Memory-Limit.
 *
 * Resend wird via global fetch gemockt — kein echter Versand, domain-unabhängig.
 * Mock-Shapes spiegeln den echten Producer (Resend `{ id }` / `{ error }`,
 * Supabase insert→select→single → `{ data: { id, declared_at }, error }`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Mocks (vor dem Handler-Import)
// ---------------------------------------------------------------------------

const { mockRequireOwner, mockApplyRateLimit, mockGetAdminWithStatus } = vi.hoisted(() => ({
  mockRequireOwner: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockGetAdminWithStatus: vi.fn(),
}))

vi.mock('../../api/_authRole', () => ({
  requireOwner: mockRequireOwner,
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: mockApplyRateLimit,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetAdminWithStatus,
  formatAdminUnavailable: (missing: string[]) => `missing: ${missing.join(', ')}`,
}))

vi.mock('../../api/_cors', () => ({
  applyCors: vi.fn().mockReturnValue(false),
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import handler from '../../api/submit-widerruf'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown> = {}, method = 'POST'): VercelRequest {
  return {
    method,
    headers: { authorization: 'Bearer test-token' },
    body,
    url: '/api/submit-widerruf',
  } as unknown as VercelRequest
}

function makeResponse() {
  const captured: { status: number | null; body: unknown } = { status: null, body: null }
  const statusChain = { json: vi.fn((data: unknown) => { captured.body = data }) }
  const res = {
    status: vi.fn((code: number) => {
      captured.status = code
      return statusChain
    }),
    setHeader: vi.fn(),
  } as unknown as VercelResponse
  return { res, captured }
}

/** Admin-Mock: insert→select→single liefert das übergebene Ergebnis. */
function makeAdmin(insertResult: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    insert: () => chain,
    select: () => chain,
    single: () => Promise.resolve(insertResult),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

function stubResendOk(messageId = 'resend-msg-1') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: messageId }),
    }),
  )
}

function stubResendFail() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: { name: 'validation_error', message: 'domain not verified' } }),
    }),
  )
}

const INSERT_OK = { data: { id: 'w-1', declared_at: '2026-06-13T10:00:00.000Z' }, error: null }
const VALID_BODY = { contactEmail: 'kunde@example.com' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/submit-widerruf — §356a Widerrufsbutton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApplyRateLimit.mockResolvedValue(false)
    mockGetAdminWithStatus.mockReturnValue({ ok: true, client: makeAdmin(INSERT_OK) })
    process.env.RESEND_API_KEY = 'resend-test-key'
    process.env.NOTIFICATION_FROM_EMAIL = 'SaFix <no-reply@safix.digital>'
    stubResendOk()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('405 bei non-POST', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-405' })
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY, 'GET'), res)
    expect(captured.status).toBe(405)
  })

  it('blockt, wenn requireOwner ablehnt (kein Owner-Abo)', async () => {
    // requireOwner schreibt selbst die Fehlerantwort und gibt null zurück.
    mockRequireOwner.mockImplementation(
      async (_req: VercelRequest, res: VercelResponse) => {
        ;(res.status as unknown as (c: number) => { json: (b: unknown) => void })(403).json({
          error: 'forbidden',
        })
        return null
      },
    )
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)
    expect(captured.status).toBe(403)
  })

  it('503 fail-closed, wenn RESEND_API_KEY fehlt — Widerruf wird NICHT erfasst', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-503a' })
    delete process.env.RESEND_API_KEY
    const admin = makeAdmin(INSERT_OK)
    const fromSpy = vi.spyOn(admin, 'from')
    mockGetAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)

    expect(captured.status).toBe(503)
    expect((captured.body as Record<string, unknown>).code).toBe('confirmation_unavailable')
    // Kein Insert: ohne Bestätigungsweg darf nichts geschrieben werden.
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('503 fail-closed, wenn NOTIFICATION_FROM_EMAIL fehlt', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-503b' })
    delete process.env.NOTIFICATION_FROM_EMAIL
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)
    expect(captured.status).toBe(503)
  })

  it('400 bei ungültiger E-Mail', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-400' })
    const { res, captured } = makeResponse()
    await handler(makeRequest({ contactEmail: 'keine-email' }), res)
    expect(captured.status).toBe(400)
    expect((captured.body as Record<string, unknown>).code).toBe('invalid_email')
  })

  it('200 + confirmationSent=true bei erfolgreichem Resend-Versand', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-200ok' })
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)

    expect(captured.status).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body.received).toBe(true)
    expect(body.confirmationSent).toBe(true)
    // Maskierte Adresse, keine Klartext-PII in der Antwort.
    expect(body.maskedEmail).toBe('k****@example.com')
    // Resend wurde mit der konfigurierten From-Adresse aufgerufen.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' }),
    )
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(sentBody.from).toBe('SaFix <no-reply@safix.digital>')
    expect(sentBody.to).toEqual(['kunde@example.com'])
  })

  it('200 + confirmationSent=false, wenn Resend fehlschlägt — Row dennoch erfasst', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-200fail' })
    stubResendFail()
    const admin = makeAdmin(INSERT_OK)
    const fromSpy = vi.spyOn(admin, 'from')
    mockGetAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)

    expect(captured.status).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body.received).toBe(true)
    expect(body.confirmationSent).toBe(false)
    // Insert lief — der Widerruf ist erfasst, nur die Zustellung scheiterte.
    expect(fromSpy).toHaveBeenCalledWith('widerruf_requests')
  })

  it('500, wenn der DB-Insert fehlschlägt', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-500' })
    mockGetAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({ data: null, error: { message: 'insert failed' } }),
    })
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)
    expect(captured.status).toBe(500)
  })

  it('429 nach 5 Widerrufen/Stunde (Memory-Limit)', async () => {
    mockRequireOwner.mockResolvedValue({ userId: 'owner-rate' })
    // 5 erlaubte Durchläufe
    for (let i = 0; i < 5; i++) {
      const { res, captured } = makeResponse()
      await handler(makeRequest(VALID_BODY), res)
      expect(captured.status).toBe(200)
    }
    // 6. → 429
    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_BODY), res)
    expect(captured.status).toBe(429)
    expect((captured.body as Record<string, unknown>).code).toBe('rate_limit_exceeded')
  })
})
