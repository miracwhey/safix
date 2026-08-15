// DEPLOY HELD until explicit 'ja deploy'
/**
 * Edge Function `notify-push` — cross-platform push dispatcher.
 *
 * Routes each token to its transport: iOS → APNs HTTP/2, Android → FCM HTTP v1.
 * The platform is resolved per token from `notification_device_tokens` (the
 * triggers forward only tokens), so one mixed batch fans out to both.
 *
 * Invoked by the Postgres trigger `notification_signals_after_insert`
 * (migration `20260503000003_notification_push_dispatch.sql`) via
 * `pg_net.http_post`.
 *
 * ── Auth ──────────────────────────────────────────────────────────────
 * `verify_jwt: false` — there is no end-user JWT on the trigger call.
 * Instead we accept a shared secret in `x-fixup-trigger-secret`. The
 * trigger reads the same secret from Supabase Vault and includes it in
 * the request headers. Anything without the matching header gets a 401.
 *
 * ── Body shape ───────────────────────────────────────────────────────
 *   {
 *     "pushes": [
 *       {
 *         "token": "<APNs device token, hex>",
 *         "title": "…",
 *         "body":  "…",
 *         "data":  { "jobId": "…", "type": "…" }   // optional
 *       },
 *       …
 *     ]
 *   }
 *
 * ── Env vars (set via `supabase secrets set`) ────────────────────────
 *   APNS_KEY                   PEM-wrapped PKCS#8 private key (.p8 contents)
 *   APNS_KEY_ID                10-char id from Apple Developer
 *   APNS_TEAM_ID               10-char team id from Apple Developer
 *   APNS_BUNDLE_ID             e.g. "app.fixup.main" (== apns-topic)
 *   APNS_ENVIRONMENT           "production" | "sandbox"
 *   FIREBASE_SERVICE_ACCOUNT   Firebase service-account JSON (Android/FCM). The
 *                              project_id is read from it — no separate secret.
 *                              Optional: absent → Android pushes soft-fail,
 *                              iOS unaffected.
 *   FIXUP_TRIGGER_SHARED_SECRET   shared with Vault entry `notify_push.shared_secret`
 *
 * ── Response ─────────────────────────────────────────────────────────
 *   200 — { ok: true, delivered: N, failed: M, results: [...] }
 *   400 — { error: "<reason>" }      (malformed body, missing env)
 *   401 — { error: "unauthorized" }  (bad / missing shared secret)
 *   502 — { error: "apns_unreachable", … }
 *
 * Per-push failures are reported in the 200 body, NOT as HTTP failures —
 * one bad token must not block the rest of the batch.
 */

import { buildApnsJwt, importApnsPrivateKey } from './apns-jwt.ts'
import {
  enrichPushDataWithRoute,
  getInlineActionCategoryForType,
} from './routeMap.ts'
import {
  buildServiceAccountAssertion,
  exchangeAssertionForAccessToken,
  importServiceAccountKey,
  isPrunableFcmResult,
  parseServiceAccount,
  sendFcmMessage,
  type ServiceAccount,
} from './fcm.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DenoLike = {
  env?: { get?: (name: string) => string | undefined }
  serve?: (handler: (req: Request) => Promise<Response>) => unknown
}

function getDeno(): DenoLike | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno
}

type PushItem = {
  token: string
  title: string
  body: string
  data?: Record<string, unknown>
  /**
   * Optional transport hint. Triggers currently omit it and the sender resolves
   * the platform from notification_device_tokens; when present it wins and
   * skips the lookup. 'android' → FCM v1, anything else → APNs.
   */
  platform?: string
}

type PushResult = {
  token: string
  status: number
  apnsId?: string
  error?: string
}

/**
 * APNs reasons that mean a token is permanently invalid for this topic and
 * MUST be pruned from notification_device_tokens. Transient failures
 * (TooManyRequests, InternalServerError, ServiceUnavailable, ExpiredProviderToken,
 * fetch_failed) are deliberately excluded — the token is fine, the failure is not.
 */
const PRUNABLE_APNS_REASONS: ReadonlySet<string> = new Set([
  'Unregistered',          // 410 — token no longer registered for the topic
  'BadDeviceToken',        // 400 — token is malformed / for the wrong environment
  'DeviceTokenNotForTopic',// 400 — token belongs to a different bundle id
])

/** True when a per-push result indicates a permanently dead token. */
function isPrunableResult(r: PushResult): boolean {
  if (r.status === 410) return true
  return typeof r.error === 'string' && PRUNABLE_APNS_REASONS.has(r.error)
}

/**
 * Service-role Supabase client for token bookkeeping (platform lookup + prune).
 * Returns null when the runtime env is unset (e.g. local invocation without
 * secrets) so callers degrade gracefully instead of throwing.
 */
function getAdminClient(): ReturnType<typeof createClient> | null {
  const url = getDeno()?.env?.get?.('SUPABASE_URL')
  const serviceKey = getDeno()?.env?.get?.('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * PostgREST serialises the `.in(...)` filter into the request URL, so a very
 * large token list can overflow the URL-length limit (→ 414) and fail the whole
 * lookup. Chunk the IN-list so even a big fan-out resolves every platform
 * instead of silently falling back to the APNs default.
 */
const PLATFORM_LOOKUP_CHUNK = 100

/**
 * Looks up the `platform` of each token in the batch so the dispatcher can
 * route iOS→APNs and Android→FCM. Tokens are device-unique, so token→platform
 * is unambiguous. A token that is ABSENT from the returned map was NOT resolved
 * (lookup failure or no DB row) — the caller then defaults it to APNs for a
 * best-effort delivery attempt but treats its platform as UNKNOWN and must not
 * prune it on a transport rejection (see `confidentPlatform` in handleRequest).
 * On error we keep whatever chunks already resolved and stop, so partial
 * success still yields confident routing for those tokens.
 */
async function resolveTokenPlatforms(tokens: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (tokens.length === 0) return map
  const admin = getAdminClient()
  if (!admin) {
    console.warn('notify-push: platform lookup skipped — service role unset; tokens stay unresolved')
    return map
  }
  const unique = Array.from(new Set(tokens))
  try {
    for (let i = 0; i < unique.length; i += PLATFORM_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + PLATFORM_LOOKUP_CHUNK)
      const { data, error } = await admin
        .from('notification_device_tokens')
        .select('token, platform')
        .in('token', chunk)
      if (error) {
        console.warn('notify-push: platform lookup failed', error.message)
        break
      }
      for (const row of (data ?? []) as Array<{ token?: unknown; platform?: unknown }>) {
        if (typeof row.token === 'string' && typeof row.platform === 'string') {
          map.set(row.token, row.platform)
        }
      }
    }
  } catch (e) {
    console.warn('notify-push: platform lookup exception', (e as Error).message)
  }
  return map
}

/**
 * Deletes dead device tokens (APNs or FCM) from notification_device_tokens
 * using the service role. Fail-soft: any error is logged and swallowed —
 * pruning must never turn a successful dispatch into an HTTP failure.
 */
async function pruneDeadTokens(deadTokens: string[]): Promise<number> {
  if (deadTokens.length === 0) return 0
  const admin = getAdminClient()
  if (!admin) {
    console.warn('notify-push: prune skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset')
    return 0
  }
  try {
    // Dedupe to keep the IN list small; delete across all users that hold them.
    const unique = Array.from(new Set(deadTokens))
    const { error, count } = await admin
      .from('notification_device_tokens')
      .delete({ count: 'exact' })
      .in('token', unique)
    if (error) {
      console.warn('notify-push: token prune failed', error.message)
      return 0
    }
    console.info('notify-push: pruned dead tokens', { requested: unique.length, deleted: count ?? 0 })
    return count ?? 0
  } catch (e) {
    console.warn('notify-push: token prune exception', (e as Error).message)
    return 0
  }
}

const APNS_HOSTS: Record<'production' | 'sandbox', string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

const JWT_TTL_MS = 50 * 60 * 1000 // Apple recommends rotating within an hour.
let cachedJwt: { token: string; expiresAt: number } | null = null
let cachedKey: { key: CryptoKey; pem: string } | null = null

async function getJwt(): Promise<string> {
  const now = Date.now()
  if (cachedJwt && cachedJwt.expiresAt > now + 60_000) {
    return cachedJwt.token
  }

  const pem = mustGetEnv('APNS_KEY')
  const keyId = mustGetEnv('APNS_KEY_ID')
  const teamId = mustGetEnv('APNS_TEAM_ID')

  if (!cachedKey || cachedKey.pem !== pem) {
    cachedKey = { key: await importApnsPrivateKey(pem), pem }
  }
  const token = await buildApnsJwt({ key: cachedKey.key, keyId, teamId })
  cachedJwt = { token, expiresAt: now + JWT_TTL_MS }
  return token
}

function mustGetEnv(name: string): string {
  const value = getDeno()?.env?.get?.(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing env: ${name}`)
  }
  return value
}

function getEnvOrDefault(name: string, fallback: string): string {
  const value = getDeno()?.env?.get?.(name)
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

// ── FCM (Android) OAuth2 access-token cache ──────────────────────────────
// Access tokens live ~1 h; we refresh 5 min early. The parsed service account
// + imported RSA key are cached separately, keyed by the raw secret, so a
// rotated FIREBASE_SERVICE_ACCOUNT re-imports the key.
let cachedFcmToken: { token: string; projectId: string; expiresAt: number } | null = null
let cachedFcmAccount: { raw: string; key: CryptoKey; account: ServiceAccount } | null = null

/**
 * Returns a valid FCM v1 access token + the target project id, minting a fresh
 * one via the service-account jwt-bearer grant when the cache is cold/stale.
 * Throws when FIREBASE_SERVICE_ACCOUNT is unset/invalid — the caller degrades
 * that into per-token soft failures so the APNs leg is unaffected.
 */
async function getFcmAccessToken(): Promise<{ token: string; projectId: string }> {
  const now = Date.now()
  if (cachedFcmToken && cachedFcmToken.expiresAt > now) {
    return { token: cachedFcmToken.token, projectId: cachedFcmToken.projectId }
  }
  const raw = mustGetEnv('FIREBASE_SERVICE_ACCOUNT')
  if (!cachedFcmAccount || cachedFcmAccount.raw !== raw) {
    const account = parseServiceAccount(raw)
    const key = await importServiceAccountKey(account.privateKeyPem)
    cachedFcmAccount = { raw, key, account }
  }
  const { key, account } = cachedFcmAccount
  const assertion = await buildServiceAccountAssertion({
    key,
    clientEmail: account.clientEmail,
    tokenUri: account.tokenUri,
  })
  const { token, expiresInSeconds } = await exchangeAssertionForAccessToken(
    account.tokenUri,
    assertion,
  )
  cachedFcmToken = {
    token,
    projectId: account.projectId,
    expiresAt: now + Math.max(0, expiresInSeconds - 300) * 1000,
  }
  return { token, projectId: account.projectId }
}

/**
 * Route-enriches a push's data the same way the APNs path does (see
 * buildApnsPayload) so Android deep-linking has route/focus/fallbackRoute/
 * actionVersion. FCM stringifies the values downstream.
 */
function buildFcmData(item: PushItem): Record<string, unknown> {
  const enriched = enrichPushDataWithRoute(item.data)
  return enriched && typeof enriched === 'object'
    ? (enriched as Record<string, unknown>)
    : (item.data ?? {})
}

function buildApnsPayload(item: PushItem): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: { title: item.title, body: item.body },
    sound: 'default',
  }
  // Block A · M1 — wenn der Notification-Type eine Inline-Action-Category in
  // PUSH_ROUTE_MAP hat, setze `aps.category` (sonst zeigt iOS keine Buttons)
  // und `mutable-content: 1` (erlaubt Notification-Service-Extensions, falls
  // der User-Lockscreen-Render später angereichert werden soll). Types ohne
  // Category bleiben unverändert.
  //
  // Defense-in-Depth: Category-Buttons werden NUR gesetzt, wenn der
  // Daten-Payload alle Pflichtfelder enthält, die `pushActionDispatcher`
  // (Step 5/8 — Required identification fields) braucht. Solange die
  // Trigger-SQL nicht alle Felder pro Type emittiert, würde ein
  // Lockscreen-Tap im App-seitigen Dispatcher als `malformed` fallen und
  // dem User eine Failure-Notif zeigen. Lieber kein Button als ein toter.
  const dataType =
    item.data && typeof (item.data as Record<string, unknown>).type === 'string'
      ? ((item.data as Record<string, unknown>).type as string)
      : null
  const category = dataType ? getInlineActionCategoryForType(dataType) : undefined
  if (category && hasInlineActionPayloadFields(item.data)) {
    aps.category = category
    aps['mutable-content'] = 1
  }
  const payload: Record<string, unknown> = { aps }
  // Block 7.2 / B3 — enrich data with route/focus/fallbackRoute/
  // actionVersion based on data.type. Pre-Edge-Function-Aufruf-Trigger
  // setzt nur {jobId, type, signalId, priority}; das App-seitige
  // pushRouteResolver braucht die Routing-Felder, um Deep-Link-Navigate
  // auszulösen. Pure: types ohne Map-Eintrag bleiben unverändert.
  const enriched = enrichPushDataWithRoute(item.data)
  if (enriched && typeof enriched === 'object') {
    Object.assign(payload, enriched)
  }
  return payload
}

/**
 * Block A · M1 — Pflichtfelder für `pushActionDispatcher` Step 5/8. Müssen
 * alle im `data`-Payload des Push vorhanden sein, sonst fällt ein Lockscreen-
 * Action-Tap garantiert auf `{ kind: 'fallback', reason: 'malformed' }` und
 * der User sieht eine Failure-Notif. In dem Fall lieber gar keine Buttons
 * rendern. Spiegelt die Felder von `dispatchPushAction` Step 5/8 in
 * `src/lib/notifications/pushActionDispatcher.ts`.
 */
function hasInlineActionPayloadFields(
  data: Record<string, unknown> | undefined,
): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    typeof d.entityId === 'string' &&
    d.entityId.length > 0 &&
    typeof d.entityType === 'string' &&
    d.entityType.length > 0 &&
    typeof d.actionType === 'string' &&
    typeof d.roleTarget === 'string' &&
    d.roleTarget.length > 0 &&
    typeof d.expectedStatus === 'string' &&
    typeof d.expiresAt === 'number'
  )
}

async function sendOne(item: PushItem, jwt: string, host: string, topic: string): Promise<PushResult> {
  const url = `${host}/3/device/${item.token}`
  let response: Response
  try {
    // Build the payload INSIDE the try: enrichPushDataWithRoute /
    // getInlineActionCategoryForType (via buildApnsPayload) run per-item, so a
    // throw here must fail only THIS token, not reject Promise.all and 500 the
    // whole batch (the FCM leg included). Mirrors the fail-soft FCM path.
    const body = JSON.stringify(buildApnsPayload(item))
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body,
    })
  } catch (e) {
    return { token: item.token, status: 0, error: `fetch_failed: ${(e as Error).message}` }
  }

  const apnsId = response.headers.get('apns-id') ?? undefined
  if (response.ok) {
    return { token: item.token, status: response.status, ...(apnsId ? { apnsId } : {}) }
  }
  let reason: string | undefined
  try {
    const json = await response.json()
    reason = typeof json?.reason === 'string' ? json.reason : undefined
  } catch {
    // ignore — non-JSON error bodies happen during APNs incidents.
  }
  return {
    token: item.token,
    status: response.status,
    error: reason ?? `http_${response.status}`,
    ...(apnsId ? { apnsId } : {}),
  }
}

function jsonResponse(body: unknown, init: number | ResponseInit = 200): Response {
  const status = typeof init === 'number' ? init : init.status ?? 200
  const headers = typeof init === 'number' ? {} : (init.headers ?? {})
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

// Constant-time secret comparison so a brute-force probe cannot recover the
// expected secret byte-by-byte from response-timing differences.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }

  const expectedSecret = mustGetEnvSafe('FIXUP_TRIGGER_SHARED_SECRET')
  if (!expectedSecret.value) {
    return jsonResponse({ error: 'server_misconfigured', detail: expectedSecret.error }, 500)
  }
  const provided = req.headers.get('x-fixup-trigger-secret')
  if (!provided || !timingSafeEqual(provided, expectedSecret.value)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let parsed: { pushes?: PushItem[] }
  try {
    parsed = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400)
  }
  const pushes = Array.isArray(parsed.pushes) ? parsed.pushes : []
  if (pushes.length === 0) {
    return jsonResponse({ ok: true, delivered: 0, failed: 0, results: [] })
  }
  if (pushes.length > 500) {
    return jsonResponse({ error: 'batch_too_large', max: 500 }, 400)
  }

  const valid: PushItem[] = []
  const invalid: PushResult[] = []
  for (const p of pushes) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.token !== 'string' || p.token.length === 0) {
      invalid.push({ token: String(p?.token ?? ''), status: 0, error: 'invalid_token' })
      continue
    }
    if (typeof p.title !== 'string' || typeof p.body !== 'string') {
      invalid.push({ token: p.token, status: 0, error: 'invalid_content' })
      continue
    }
    valid.push({
      token: p.token,
      title: p.title,
      body: p.body,
      data: p.data,
      ...(typeof p.platform === 'string' ? { platform: p.platform } : {}),
    })
  }

  // Partition by platform: 'android' → FCM v1, everything else → APNs. The
  // trigger forwards only tokens, so the platform is resolved here from
  // notification_device_tokens (unless the item already carries a hint).
  const platformByToken = await resolveTokenPlatforms(
    valid.filter((p) => !p.platform).map((p) => p.token),
  )
  const apnsItems: PushItem[] = []
  const fcmItems: PushItem[] = []
  // Tokens whose platform we know with CONFIDENCE — an explicit item hint or a
  // resolved DB row. ONLY these may be pruned on a transport rejection. A token
  // that reaches the APNs leg purely via the `?? 'ios'` default (platform
  // unresolved: lookup failure or missing row) could actually be a live Android
  // token that APNs rejects as BadDeviceToken — pruning it would delete a
  // healthy device. So unresolved tokens are delivered best-effort but never
  // pruned. Platform compare is case-insensitive (client may store 'Android').
  const confidentPlatform = new Set<string>()
  for (const p of valid) {
    const known = p.platform ?? platformByToken.get(p.token)
    if (known !== undefined) confidentPlatform.add(p.token)
    const platform = (known ?? 'ios').toLowerCase()
    if (platform === 'android') fcmItems.push(p)
    else apnsItems.push(p)
  }

  // ── APNs leg (iOS) ──────────────────────────────────────────────────────
  let apnsResults: PushResult[] = []
  if (apnsItems.length > 0) {
    let jwt: string
    try {
      jwt = await getJwt()
    } catch (e) {
      return jsonResponse({ error: 'jwt_build_failed', detail: (e as Error).message }, 500)
    }
    const env = getEnvOrDefault('APNS_ENVIRONMENT', 'production') as 'production' | 'sandbox'
    const host = APNS_HOSTS[env] ?? APNS_HOSTS.production
    const topic = mustGetEnv('APNS_BUNDLE_ID')
    apnsResults = await Promise.all(apnsItems.map((p) => sendOne(p, jwt, host, topic)))
  }

  // ── FCM leg (Android) ───────────────────────────────────────────────────
  let fcmResults: PushResult[] = []
  if (fcmItems.length > 0) {
    try {
      const { token: accessToken, projectId } = await getFcmAccessToken()
      fcmResults = await Promise.all(
        fcmItems.map((p) =>
          sendFcmMessage({
            accessToken,
            projectId,
            item: { token: p.token, title: p.title, body: p.body, data: buildFcmData(p) },
          }),
        ),
      )
    } catch (e) {
      // Missing/invalid FIREBASE_SERVICE_ACCOUNT (or token exchange down). Fail
      // the FCM items soft so any APNs leg still returns 200. NOT prunable —
      // the tokens are fine, the server is misconfigured.
      fcmResults = fcmItems.map((p) => ({
        token: p.token,
        status: 0,
        error: `fcm_unconfigured: ${(e as Error).message}`,
      }))
    }
  }

  const all = [...invalid, ...apnsResults, ...fcmResults]
  const delivered = all.filter((r) => r.status === 200).length
  const failed = all.length - delivered

  // Prune tokens each transport reports as permanently invalid (APNs: 410 /
  // Unregistered / BadDeviceToken / DeviceTokenNotForTopic; FCM: 404 /
  // UNREGISTERED / INVALID_ARGUMENT). Fail-soft — never blocks the 200.
  const deadTokens = [
    ...apnsResults.filter(isPrunableResult),
    ...fcmResults.filter(isPrunableFcmResult),
  ]
    .map((r) => r.token)
    // Never prune a token whose platform we could not confidently resolve — it
    // may be a live Android token that only hit APNs via the default route.
    .filter((t) => t.length > 0 && confidentPlatform.has(t))
  const pruned = await pruneDeadTokens(deadTokens)

  return jsonResponse({ ok: true, delivered, failed, pruned, results: all })
}

function mustGetEnvSafe(name: string): { value: string | null; error?: string } {
  try {
    return { value: mustGetEnv(name) }
  } catch (e) {
    return { value: null, error: (e as Error).message }
  }
}

const denoServe = getDeno()?.serve
if (typeof denoServe === 'function') {
  denoServe(handleRequest)
}
