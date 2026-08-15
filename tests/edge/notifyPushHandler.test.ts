/**
 * `notify-push` request handler — auth, body validation, dispatch fan-out.
 *
 * Stubs `globalThis.Deno.env`, `globalThis.fetch`, and (via Node's webcrypto)
 * `globalThis.crypto`. APNs is not actually contacted — fetch is a vi.fn
 * that returns canned responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  ;(globalThis as { crypto: unknown }).crypto = webcrypto
}

type EnvMap = Record<string, string>
let envMap: EnvMap = {}

function installDenoEnv(map: EnvMap) {
  envMap = { ...map }
  ;(globalThis as { Deno?: unknown }).Deno = {
    env: { get: (k: string) => envMap[k] },
  }
}

async function generateTestPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  let bin = ''
  for (let i = 0; i < pkcs8.length; i++) bin += String.fromCharCode(pkcs8[i])
  const b64 = btoa(bin)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// Capture token-prune deletes without hitting the network. `vi.mock` is
// hoisted, so the spy must be created with `vi.hoisted` to be referenceable
// inside the factory.
const selectInSpy = vi.hoisted(() => vi.fn())
const deleteInSpy = vi.hoisted(() => vi.fn())
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ in: (...args: unknown[]) => selectInSpy(...args) }),
      delete: () => ({ in: (...args: unknown[]) => deleteInSpy(...args) }),
    }),
  }),
}))

let pem: string

beforeEach(async () => {
  pem = await generateTestPem()
  installDenoEnv({
    APNS_KEY: pem,
    APNS_KEY_ID: 'VMUD73M4W7',
    APNS_TEAM_ID: 'KXJRXU59ZB',
    APNS_BUNDLE_ID: 'app.fixup.main',
    APNS_ENVIRONMENT: 'sandbox',
    FIXUP_TRIGGER_SHARED_SECRET: 'shared-secret-123',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  })
  fetchMock.mockReset()
  // Default success response
  fetchMock.mockResolvedValue(
    new Response(null, { status: 200, headers: { 'apns-id': 'apns-test-id' } }),
  )
  selectInSpy.mockReset()
  // Default: resolve every looked-up token to iOS so the existing APNs + prune
  // tests route + prune as before (platform CONFIDENTLY known). Tests that
  // exercise a lookup failure override this to return an error.
  selectInSpy.mockImplementation((_col: unknown, tokens: unknown) =>
    Promise.resolve({
      data: (Array.isArray(tokens) ? tokens : []).map((t) => ({ token: t, platform: 'ios' })),
      error: null,
    }),
  )
  deleteInSpy.mockReset()
  deleteInSpy.mockResolvedValue({ error: null, count: 1 })
  vi.resetModules()
})

afterEach(() => {
  delete (globalThis as { Deno?: unknown }).Deno
})

async function loadHandler() {
  const mod = await import('../../supabase/functions/notify-push/index.ts')
  return mod.handleRequest
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/notify-push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fixup-trigger-secret': 'shared-secret-123',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('notify-push handler — auth', () => {
  it('rejects without the shared-secret header', async () => {
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/', {
        method: 'POST',
        body: JSON.stringify({ pushes: [] }),
      }),
    )
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('unauthorized')
  })

  it('rejects with a wrong shared-secret value', async () => {
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({ pushes: [] }, { 'x-fixup-trigger-secret': 'wrong' }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects non-POST methods', async () => {
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/', { method: 'GET' }),
    )
    expect(res.status).toBe(405)
  })

  it('returns 500 when FIXUP_TRIGGER_SHARED_SECRET is unset', async () => {
    installDenoEnv({
      APNS_KEY: pem,
      APNS_KEY_ID: 'K1',
      APNS_TEAM_ID: 'T1',
      APNS_BUNDLE_ID: 'app.fixup.main',
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [] }))
    expect(res.status).toBe(500)
  })
})

describe('notify-push handler — body validation', () => {
  it('returns 400 on invalid JSON body', async () => {
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'x-fixup-trigger-secret': 'shared-secret-123' },
        body: 'not-json',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 200 with empty results when pushes is empty', async () => {
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [] }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, delivered: 0, failed: 0, results: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when pushes array exceeds 500 items', async () => {
    const handle = await loadHandler()
    const pushes = Array.from({ length: 501 }, (_, i) => ({
      token: `tok${i}`,
      title: 't',
      body: 'b',
    }))
    const res = await handle(makeRequest({ pushes }))
    expect(res.status).toBe(400)
  })

  it('flags items with missing token / title / body as invalid (status 0)', async () => {
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({
        pushes: [
          { token: '', title: 't', body: 'b' },
          { token: 'tok-1', title: 't', body: 'b' },
          { token: 'tok-2', body: 'b' }, // missing title
        ],
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.delivered).toBe(1)
    expect(json.failed).toBe(2)
    const errors = json.results.filter((r: { error?: string }) => r.error)
    expect(errors.map((e: { error: string }) => e.error)).toEqual(
      expect.arrayContaining(['invalid_token', 'invalid_content']),
    )
  })
})

describe('notify-push handler — APNs dispatch', () => {
  it('fans out one fetch call per valid push, with the right URL + headers', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          { token: 'aaaa', title: 'Hi', body: 'There' },
          { token: 'bbbb', title: 'Yo', body: 'Friend' },
        ],
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const call0 = fetchMock.mock.calls[0]
    expect(call0[0]).toBe('https://api.sandbox.push.apple.com/3/device/aaaa')
    const headers = call0[1].headers
    expect(headers.authorization).toMatch(/^bearer ey/) // JWT prefix
    expect(headers['apns-topic']).toBe('app.fixup.main')
    expect(headers['apns-push-type']).toBe('alert')
  })

  it('uses the production APNs host when APNS_ENVIRONMENT=production', async () => {
    installDenoEnv({
      APNS_KEY: pem,
      APNS_KEY_ID: 'K1',
      APNS_TEAM_ID: 'T1',
      APNS_BUNDLE_ID: 'app.fixup.main',
      APNS_ENVIRONMENT: 'production',
      FIXUP_TRIGGER_SHARED_SECRET: 'shared-secret-123',
    })
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'xx', title: 't', body: 'b' }] }))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.push.apple.com/3/device/xx')
  })

  it('serialises the APNs body with aps.alert.title + aps.alert.body + sound', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [{ token: 'aaaa', title: 'Frist heute', body: 'Bitte antworten' }],
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      aps: {
        alert: { title: 'Frist heute', body: 'Bitte antworten' },
        sound: 'default',
      },
    })
  })

  it('merges optional `data` payload into the APNs body alongside aps', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          {
            token: 'aaaa',
            title: 't',
            body: 'b',
            data: { jobId: 'job-1', type: 'dispute_response_required' },
          },
        ],
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.jobId).toBe('job-1')
    expect(body.type).toBe('dispute_response_required')
    expect(body.aps).toBeDefined()
  })

  it('does NOT set aps.category when payload misses dispatcher pflicht-fields', async () => {
    // Block A · M1 — Defense-in-Depth gate: category-Type ist eingetragen
    // (correction_created), aber data hat keine entityId/actionType/etc.
    // → Lockscreen-Buttons würden im Dispatcher als "malformed" fallen,
    // also gar nicht erst rendern.
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          {
            token: 'aaaa',
            title: 't',
            body: 'b',
            data: {
              jobId: 'job-1',
              type: 'correction_created',
              signalId: 'sig-1',
              priority: 1,
            },
          },
        ],
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.aps.category).toBeUndefined()
    expect(body.aps['mutable-content']).toBeUndefined()
  })

  it('SETS aps.category when payload carries all dispatcher pflicht-fields', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          {
            token: 'aaaa',
            title: 't',
            body: 'b',
            data: {
              jobId: 'job-1',
              type: 'correction_created',
              signalId: 'sig-1',
              priority: 1,
              entityId: 'corr-1',
              entityType: 'correction',
              actionType: 'review',
              roleTarget: 'provider',
              expectedStatus: 'pending_review',
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            },
          },
        ],
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.aps.category).toBe('CORRECTION_DECISION')
    expect(body.aps['mutable-content']).toBe(1)
  })

  it('reports per-token APNs failures (BadDeviceToken) without aborting the batch', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reason: 'BadDeviceToken' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({
        pushes: [
          { token: 'good', title: 't', body: 'b' },
          { token: 'gone', title: 't', body: 'b' },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.delivered).toBe(1)
    expect(json.failed).toBe(1)
    const failed = json.results.find((r: { error?: string }) => r.error)
    expect(failed.error).toBe('BadDeviceToken')
    expect(failed.status).toBe(410)
  })

  it('reports a fetch_failed result when fetch throws (network)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'))
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({ pushes: [{ token: 'xx', title: 't', body: 'b' }] }),
    )
    const json = await res.json()
    expect(json.delivered).toBe(0)
    expect(json.failed).toBe(1)
    expect(json.results[0].error).toMatch(/^fetch_failed/)
  })

  it('prunes a token on 410 Unregistered and reports pruned count', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reason: 'Unregistered' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({
        pushes: [
          { token: 'live', title: 't', body: 'b' },
          { token: 'dead', title: 't', body: 'b' },
        ],
      }),
    )
    const json = await res.json()
    expect(json.pruned).toBe(1)
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['dead'])
  })

  it('prunes a BadDeviceToken (400) token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'bad', title: 't', body: 'b' }] }))
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['bad'])
  })

  it('prunes a DeviceTokenNotForTopic (400) token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'DeviceTokenNotForTopic' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'foreign', title: 't', body: 'b' }] }))
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['foreign'])
  })

  it('does NOT prune on a transient TooManyRequests (429) failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'TooManyRequests' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'busy', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(0)
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('does NOT prune on a successful delivery', async () => {
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'ok', title: 't', body: 'b' }] }))
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('does NOT prune invalid-payload tokens (status 0 / invalid_token)', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [{ token: 'no-content', body: 'b' }], // missing title → invalid_content
      }),
    )
    expect(deleteInSpy).not.toHaveBeenCalled()
  })
})

describe('notify-push handler — prune safety on unresolved platform', () => {
  it('does NOT prune a token when the platform lookup ERRORS (could be a live Android token)', async () => {
    // Lookup fails → platform UNKNOWN → token defaults to APNs, APNs answers
    // BadDeviceToken (prunable), but deleting it could wipe a live Android reg.
    selectInSpy.mockReset()
    selectInSpy.mockResolvedValue({ data: null, error: { message: 'statement timeout' } })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    )
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'maybe-android', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(0)
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('STILL prunes a token whose platform was confidently resolved (iOS row)', async () => {
    selectInSpy.mockReset()
    selectInSpy.mockResolvedValue({ data: [{ token: 'ios-tok', platform: 'ios' }], error: null })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    )
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'ios-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(1)
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['ios-tok'])
  })

  it('prunes a confidently-resolved token even when the platform value is capitalised', async () => {
    // Client may persist 'Android'/'IOS'; routing + confidence are case-insensitive.
    selectInSpy.mockReset()
    selectInSpy.mockResolvedValue({ data: [{ token: 'up-tok', platform: 'IOS' }], error: null })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    )
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'up-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(1)
  })
})
