/**
 * `notify-push` FCM (Android) leg — platform routing, FCM v1 send shape,
 * dead-token prune, and soft-fail when the service account is unconfigured.
 * Plus pure unit coverage of the `fcm.ts` helpers.
 *
 * No network: `fetch` is a vi.fn that branches by URL (OAuth2 token endpoint /
 * FCM send / APNs). The service-role client is mocked to serve token→platform
 * rows and capture prune deletes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  ;(globalThis as { crypto: unknown }).crypto = webcrypto
}

import {
  parseServiceAccount,
  stringifyDataMap,
  isPrunableFcmResult,
  buildServiceAccountAssertion,
  importServiceAccountKey,
} from '../../supabase/functions/notify-push/fcm.ts'

type EnvMap = Record<string, string>
let envMap: EnvMap = {}

function installDenoEnv(map: EnvMap) {
  envMap = { ...map }
  ;(globalThis as { Deno?: unknown }).Deno = {
    env: { get: (k: string) => envMap[k] },
  }
}

async function pkcs8ToPem(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey))
  let bin = ''
  for (let i = 0; i < pkcs8.length; i++) bin += String.fromCharCode(pkcs8[i])
  const b64 = btoa(bin)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

/** Generates an RSA service-account JSON with a real signable private key. */
async function generateServiceAccountJson(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const pem = await pkcs8ToPem(kp.privateKey)
  return JSON.stringify({
    type: 'service_account',
    project_id: 'safix-bf24a',
    private_key: pem,
    client_email: 'fcm@safix-bf24a.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

async function generateApnsPem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  return pkcs8ToPem(kp.privateKey)
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

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

let apnsPem: string
let serviceAccountJson: string

beforeEach(async () => {
  apnsPem = await generateApnsPem()
  serviceAccountJson = await generateServiceAccountJson()
  installDenoEnv({
    APNS_KEY: apnsPem,
    APNS_KEY_ID: 'VMUD73M4W7',
    APNS_TEAM_ID: 'KXJRXU59ZB',
    APNS_BUNDLE_ID: 'app.fixup.main',
    APNS_ENVIRONMENT: 'sandbox',
    FIREBASE_SERVICE_ACCOUNT: serviceAccountJson,
    FIXUP_TRIGGER_SHARED_SECRET: 'shared-secret-123',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  })

  fetchMock.mockReset()
  // Branch by URL: OAuth2 token endpoint → access token; FCM → 200; APNs → 200.
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('fcm.googleapis.com')) {
      return new Response(JSON.stringify({ name: 'projects/safix-bf24a/messages/0:1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { 'apns-id': 'apns-test-id' } })
  })

  // token → platform rows served to resolveTokenPlatforms.
  selectInSpy.mockReset()
  selectInSpy.mockResolvedValue({
    data: [
      { token: 'ios-tok', platform: 'ios' },
      { token: 'android-tok', platform: 'android' },
      { token: 'android-tok-2', platform: 'android' },
    ],
    error: null,
  })
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

function makeRequest(body: unknown) {
  return new Request('http://localhost/notify-push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fixup-trigger-secret': 'shared-secret-123',
    },
    body: JSON.stringify(body),
  })
}

function callsTo(host: string): unknown[][] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes(host))
}

describe('notify-push — platform routing', () => {
  it('routes an android token to FCM, not APNs', async () => {
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 'Hi', body: 'There' }] }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.delivered).toBe(1)
    expect(callsTo('fcm.googleapis.com').length).toBe(1)
    expect(callsTo('push.apple.com').length).toBe(0)
  })

  it('routes an ios token to APNs, not FCM', async () => {
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'ios-tok', title: 'Hi', body: 'There' }] }))
    expect(callsTo('push.apple.com').length).toBe(1)
    expect(callsTo('fcm.googleapis.com').length).toBe(0)
  })

  it('fans a mixed batch out to both transports', async () => {
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({
        pushes: [
          { token: 'ios-tok', title: 't', body: 'b' },
          { token: 'android-tok', title: 't', body: 'b' },
          { token: 'android-tok-2', title: 't', body: 'b' },
        ],
      }),
    )
    const json = await res.json()
    expect(json.delivered).toBe(3)
    expect(callsTo('push.apple.com').length).toBe(1)
    expect(callsTo('fcm.googleapis.com').length).toBe(2)
  })

  it('defaults to APNs when the platform lookup finds no row (unknown token)', async () => {
    selectInSpy.mockResolvedValueOnce({ data: [], error: null })
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'mystery', title: 't', body: 'b' }] }))
    expect(callsTo('push.apple.com').length).toBe(1)
    expect(callsTo('fcm.googleapis.com').length).toBe(0)
  })

  it('honours an explicit item.platform hint without a lookup', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({ pushes: [{ token: 'x', title: 't', body: 'b', platform: 'android' }] }),
    )
    // No lookup needed for hinted items → selectInSpy never called.
    expect(selectInSpy).not.toHaveBeenCalled()
    expect(callsTo('fcm.googleapis.com').length).toBe(1)
  })
})

describe('notify-push — FCM v1 send shape', () => {
  it('mints an OAuth2 token then posts to the project messages endpoint', async () => {
    const handle = await loadHandler()
    await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const tokenCall = callsTo('oauth2.googleapis.com')[0]
    expect(String(tokenCall[0])).toBe('https://oauth2.googleapis.com/token')
    const fcmCall = callsTo('fcm.googleapis.com')[0]
    expect(String(fcmCall[0])).toBe(
      'https://fcm.googleapis.com/v1/projects/safix-bf24a/messages:send',
    )
    const headers = (fcmCall[1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe('Bearer ya29.test-token')
  })

  it('builds notification + string data map + android priority high', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          {
            token: 'android-tok',
            title: 'Frist',
            body: 'Antworten',
            data: { jobId: 'job-1', type: 'dispute_response_required', priority: 1 },
          },
        ],
      }),
    )
    const fcmCall = callsTo('fcm.googleapis.com')[0]
    const body = JSON.parse((fcmCall[1] as { body: string }).body)
    expect(body.message.token).toBe('android-tok')
    expect(body.message.notification).toEqual({ title: 'Frist', body: 'Antworten' })
    expect(body.message.android.priority).toBe('high')
    // All data values must be strings for FCM v1.
    expect(body.message.data.jobId).toBe('job-1')
    expect(body.message.data.type).toBe('dispute_response_required')
    expect(body.message.data.priority).toBe('1')
  })

  it('caches the access token across a batch (one token exchange for many sends)', async () => {
    const handle = await loadHandler()
    await handle(
      makeRequest({
        pushes: [
          { token: 'android-tok', title: 't', body: 'b' },
          { token: 'android-tok-2', title: 't', body: 'b' },
        ],
      }),
    )
    expect(callsTo('oauth2.googleapis.com').length).toBe(1)
    expect(callsTo('fcm.googleapis.com').length).toBe(2)
  })
})

describe('notify-push — FCM prune + soft-fail', () => {
  it('prunes a token on FCM 404 UNREGISTERED', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // FCM dead-token error
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            status: 'NOT_FOUND',
            details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.failed).toBe(1)
    expect(json.pruned).toBe(1)
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['android-tok'])
    expect(json.results[0].error).toBe('UNREGISTERED')
  })

  it('does NOT prune on a transient FCM 503 UNAVAILABLE', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', details: [{ errorCode: 'UNAVAILABLE' }] } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(0)
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('prunes on INVALID_ARGUMENT WHEN a fieldViolation blames message.token (dead token)', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] },
              { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' },
            ],
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.results[0].error).toBe('INVALID_ARGUMENT')
    expect(json.pruned).toBe(1)
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['android-tok'])
  })

  it('does NOT prune on INVALID_ARGUMENT from a PAYLOAD fault (live token, no message.token violation)', async () => {
    // FCM answers 400 INVALID_ARGUMENT for an oversize body / reserved data key
    // too — the registration token is perfectly valid. Deleting it would be a
    // data-loss bug, so a non-token INVALID_ARGUMENT must NOT prune.
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [{ field: 'message.notification.body' }],
              },
              { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' },
            ],
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.results[0].error).toBe('INVALID_ARGUMENT_PAYLOAD')
    expect(json.pruned).toBe(0)
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('does NOT prune an unresolved-platform token even on a prunable APNs rejection (data-loss guard)', async () => {
    // Platform lookup fails → the token (no hint) defaults to the APNs leg and
    // APNs rejects it BadDeviceToken. It could be a live Android token, so it
    // must NOT be pruned. This is the fail-soft-routing data-loss guard.
    selectInSpy.mockReset()
    selectInSpy.mockResolvedValue({ data: null, error: { message: 'statement timeout' } })
    const handle = await loadHandler()
    // APNs default response comes from the fallback branch; override to a prunable reason.
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // APNs leg
      return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    })
    const res = await handle(makeRequest({ pushes: [{ token: 'maybe-android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.pruned).toBe(0)
    expect(deleteInSpy).not.toHaveBeenCalled()
  })

  it('soft-fails android pushes (not pruned) when FIREBASE_SERVICE_ACCOUNT is unset', async () => {
    installDenoEnv({
      APNS_KEY: apnsPem,
      APNS_KEY_ID: 'K1',
      APNS_TEAM_ID: 'T1',
      APNS_BUNDLE_ID: 'app.fixup.main',
      APNS_ENVIRONMENT: 'sandbox',
      FIXUP_TRIGGER_SHARED_SECRET: 'shared-secret-123',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    })
    const handle = await loadHandler()
    const res = await handle(makeRequest({ pushes: [{ token: 'android-tok', title: 't', body: 'b' }] }))
    const json = await res.json()
    expect(json.delivered).toBe(0)
    expect(json.failed).toBe(1)
    expect(json.results[0].error).toMatch(/^fcm_unconfigured/)
    expect(deleteInSpy).not.toHaveBeenCalled()
    // FCM never contacted because the token could not be minted.
    expect(callsTo('fcm.googleapis.com').length).toBe(0)
  })

  it('an APNs failure and an FCM success coexist in one mixed batch', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (u.includes('fcm.googleapis.com')) {
        return new Response(JSON.stringify({ name: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // APNs dead token
      return new Response(JSON.stringify({ reason: 'Unregistered' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      })
    })
    const handle = await loadHandler()
    const res = await handle(
      makeRequest({
        pushes: [
          { token: 'ios-tok', title: 't', body: 'b' },
          { token: 'android-tok', title: 't', body: 'b' },
        ],
      }),
    )
    const json = await res.json()
    expect(json.delivered).toBe(1) // FCM ok
    expect(json.failed).toBe(1) // APNs dead
    expect(json.pruned).toBe(1) // ios-tok pruned
    expect(deleteInSpy).toHaveBeenCalledWith('token', ['ios-tok'])
  })
})

describe('fcm.ts — pure helpers', () => {
  it('parseServiceAccount extracts the fields and defaults token_uri', () => {
    const sa = parseServiceAccount(
      JSON.stringify({ client_email: 'a@b.iam', private_key: 'PEM', project_id: 'proj' }),
    )
    expect(sa.clientEmail).toBe('a@b.iam')
    expect(sa.projectId).toBe('proj')
    expect(sa.tokenUri).toBe('https://oauth2.googleapis.com/token')
  })

  it('parseServiceAccount throws on non-JSON and on missing fields', () => {
    expect(() => parseServiceAccount('nope')).toThrow(/not valid JSON/)
    expect(() => parseServiceAccount(JSON.stringify({ client_email: 'a' }))).toThrow(/private_key/)
    expect(() =>
      parseServiceAccount(JSON.stringify({ client_email: 'a', private_key: 'p' })),
    ).toThrow(/project_id/)
  })

  it('stringifyDataMap coerces every value to a string and drops null/undefined', () => {
    const out = stringifyDataMap({
      s: 'str',
      n: 42,
      b: true,
      o: { nested: 1 },
      nil: null,
      undef: undefined,
    })
    expect(out).toEqual({ s: 'str', n: '42', b: 'true', o: '{"nested":1}' })
    expect(out.nil).toBeUndefined()
    expect(out.undef).toBeUndefined()
  })

  it('isPrunableFcmResult flags UNREGISTERED / INVALID_ARGUMENT / 404 only', () => {
    expect(isPrunableFcmResult({ token: 't', status: 404 })).toBe(true)
    expect(isPrunableFcmResult({ token: 't', status: 400, error: 'INVALID_ARGUMENT' })).toBe(true)
    // Payload-fault downgrade is NOT a dead token → must not prune.
    expect(isPrunableFcmResult({ token: 't', status: 400, error: 'INVALID_ARGUMENT_PAYLOAD' })).toBe(false)
    expect(isPrunableFcmResult({ token: 't', status: 200, error: 'UNREGISTERED' })).toBe(true)
    expect(isPrunableFcmResult({ token: 't', status: 503, error: 'UNAVAILABLE' })).toBe(false)
    expect(isPrunableFcmResult({ token: 't', status: 500, error: 'INTERNAL' })).toBe(false)
  })

  it('buildServiceAccountAssertion produces a 3-part RS256 JWT', async () => {
    const sa = parseServiceAccount(serviceAccountJson)
    const key = await importServiceAccountKey(sa.privateKeyPem)
    const jwt = await buildServiceAccountAssertion({
      key,
      clientEmail: sa.clientEmail,
      tokenUri: sa.tokenUri,
      nowSeconds: 1_700_000_000,
    })
    const parts = jwt.split('.')
    expect(parts.length).toBe(3)
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')))
    expect(header.alg).toBe('RS256')
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    expect(payload.iss).toBe('fcm@safix-bf24a.iam.gserviceaccount.com')
    expect(payload.scope).toContain('firebase.messaging')
    expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
    expect(payload.exp - payload.iat).toBe(3600)
  })
})
