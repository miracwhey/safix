/**
 * FCM HTTP v1 sender — Android push transport.
 *
 * Mirror of `apns-jwt.ts` in spirit: pure Web Crypto helpers plus the two
 * network calls FCM v1 needs (OAuth2 token exchange + message send). No Deno /
 * Node specifics, so this is testable under vitest with the same WebCrypto API
 * the Supabase Edge runtime exposes.
 *
 * ── Why FCM v1 and not the legacy server key ──────────────────────────────
 * Google shut down the legacy `key=<server key>` FCM endpoint. HTTP v1 requires
 * a short-lived OAuth2 access token minted from a Firebase *service account*:
 *   1. Sign a JWT (RS256) with the service account's private key, claiming the
 *      `firebase.messaging` scope, audience = the account's token_uri.
 *   2. Exchange that JWT at the token endpoint (jwt-bearer grant) for an
 *      access token (~1 h TTL).
 *   3. Send with `Authorization: Bearer <access token>` to
 *      `/v1/projects/<project_id>/messages:send`.
 *
 * The service account JSON (Firebase console → Project Settings → Service
 * accounts → Generate new private key) is provided to `notify-push` as the
 * `FIREBASE_SERVICE_ACCOUNT` secret. `project_id` is read FROM that JSON, so no
 * separate project-id secret is needed.
 */

import { pemToPkcs8Bytes } from './apns-jwt.ts'

const TEXT_ENCODER = new TextEncoder()

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** Google token endpoint caps assertion lifetime at 1 h. */
const ASSERTION_TTL_SECONDS = 3600

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(TEXT_ENCODER.encode(JSON.stringify(obj)))
}

/** The fields of a Firebase service account JSON that this module consumes. */
export type ServiceAccount = {
  clientEmail: string
  privateKeyPem: string
  projectId: string
  tokenUri: string
}

/**
 * Parses the `FIREBASE_SERVICE_ACCOUNT` secret (raw JSON string) into the
 * subset of fields we use. Throws on anything malformed so a misconfigured
 * secret surfaces as a clear 500 instead of a cryptic crypto error later.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`fcm: FIREBASE_SERVICE_ACCOUNT is not valid JSON (${(e as Error).message})`)
  }
  const clientEmail = json.client_email
  const privateKeyPem = json.private_key
  const projectId = json.project_id
  const tokenUri = json.token_uri ?? 'https://oauth2.googleapis.com/token'
  if (typeof clientEmail !== 'string' || clientEmail.length === 0) {
    throw new Error('fcm: service account missing client_email')
  }
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    throw new Error('fcm: service account missing private_key')
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('fcm: service account missing project_id')
  }
  if (typeof tokenUri !== 'string' || tokenUri.length === 0) {
    throw new Error('fcm: service account has empty token_uri')
  }
  return { clientEmail, privateKeyPem, projectId, tokenUri }
}

/** Imports the service account's PKCS#8 PEM private key for RS256 signing. */
export async function importServiceAccountKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8Bytes(pem)
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export type BuildAssertionArgs = {
  key: CryptoKey
  clientEmail: string
  tokenUri: string
  /** Override for testing — defaults to current unix seconds. */
  nowSeconds?: number
}

/**
 * Builds a signed JWT (RS256) suitable for the OAuth2 jwt-bearer grant.
 * Claims: iss/sub = service account email, scope = firebase.messaging,
 * aud = token endpoint, iat/exp within the 1 h cap.
 */
export async function buildServiceAccountAssertion(
  args: BuildAssertionArgs,
): Promise<string> {
  const { key, clientEmail, tokenUri } = args
  if (!clientEmail) throw new Error('fcm: clientEmail required')
  if (!tokenUri) throw new Error('fcm: tokenUri required')

  const iat = Math.floor(args.nowSeconds ?? Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    scope: FCM_SCOPE,
    aud: tokenUri,
    iat,
    exp: iat + ASSERTION_TTL_SECONDS,
  }

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    TEXT_ENCODER.encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

export type AccessToken = { token: string; expiresInSeconds: number }

/**
 * Exchanges a signed assertion for an OAuth2 access token at the service
 * account's token endpoint. Throws with the provider's error detail so a bad
 * key / clock skew is diagnosable in the function logs.
 */
export async function exchangeAssertionForAccessToken(
  tokenUri: string,
  assertion: string,
): Promise<AccessToken> {
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail =
      typeof json.error_description === 'string'
        ? json.error_description
        : typeof json.error === 'string'
          ? json.error
          : `http_${res.status}`
    throw new Error(`fcm: token exchange failed — ${detail}`)
  }
  const token = json.access_token
  const expiresIn = json.expires_in
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('fcm: token exchange returned no access_token')
  }
  return {
    token,
    expiresInSeconds: typeof expiresIn === 'number' ? expiresIn : 3600,
  }
}

export type FcmSendItem = {
  token: string
  title: string
  body: string
  /** Already route-enriched, arbitrary-valued data (may hold non-strings). */
  data?: Record<string, unknown>
}

export type FcmSendResult = {
  token: string
  status: number
  error?: string
}

/**
 * FCM v1 requires `message.data` to be a flat string→string map. Scalars are
 * kept as-is (strings) or String()-ified; objects/arrays are JSON-encoded.
 * The app's Android tap-routing reads scalar fields (route/type/ids), so this
 * round-trips the fields that matter for deep-linking.
 */
export function stringifyDataMap(
  data: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data || typeof data !== 'object') return out
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

/**
 * FCM v1 errorCodes that mean the registration token is permanently invalid
 * and MUST be pruned. Transient / server errors (UNAVAILABLE, INTERNAL,
 * QUOTA_EXCEEDED) are excluded — the token is fine, retry later.
 */
const PRUNABLE_FCM_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNREGISTERED', // 404 — token no longer valid (app uninstalled / token rotated)
  'INVALID_ARGUMENT', // 400 — malformed token for this project
])

/** True when an FCM result indicates a permanently dead token. */
export function isPrunableFcmResult(r: FcmSendResult): boolean {
  if (r.status === 404) return true
  return typeof r.error === 'string' && PRUNABLE_FCM_ERROR_CODES.has(r.error)
}

export type SendFcmArgs = {
  accessToken: string
  projectId: string
  item: FcmSendItem
}

/**
 * Sends a single message via FCM HTTP v1. Never throws for a per-token failure
 * — returns a structured result so one dead token cannot abort the batch
 * (matches the APNs `sendOne` contract).
 */
export async function sendFcmMessage(args: SendFcmArgs): Promise<FcmSendResult> {
  const { accessToken, projectId, item } = args
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
  const message = {
    message: {
      token: item.token,
      notification: { title: item.title, body: item.body },
      data: stringifyDataMap(item.data),
      android: { priority: 'high' as const },
    },
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    })
  } catch (e) {
    return { token: item.token, status: 0, error: `fetch_failed: ${(e as Error).message}` }
  }

  if (res.ok) {
    return { token: item.token, status: res.status }
  }

  // Extract the FCM v1 errorCode (details[].errorCode) — richer than the HTTP
  // status for prune decisions. Falls back to status.error or http_<code>.
  //
  // CRITICAL for prune-safety: FCM answers `INVALID_ARGUMENT` for BOTH a
  // malformed registration token (→ dead, prune) AND a bad request payload
  // (oversize body, reserved data key → the token is LIVE, do NOT prune). The
  // two are only distinguishable by the BadRequest fieldViolations: a token
  // fault points at `message.token`. So we downgrade a non-token
  // INVALID_ARGUMENT to `INVALID_ARGUMENT_PAYLOAD` (absent from the prunable
  // set) — a payload bug must never delete a healthy device.
  let errorCode: string | undefined
  let tokenFieldViolation = false
  try {
    const json = (await res.json()) as {
      error?: {
        status?: string
        details?: Array<{
          errorCode?: string
          fieldViolations?: Array<{ field?: string }>
        }>
      }
    }
    const details = json.error?.details ?? []
    const fromDetails = details.find((d) => typeof d?.errorCode === 'string')?.errorCode
    errorCode = fromDetails ?? json.error?.status
    tokenFieldViolation = details.some((d) =>
      (d?.fieldViolations ?? []).some(
        (fv) => fv?.field === 'message.token' || fv?.field?.endsWith('.token') === true,
      ),
    )
  } catch {
    // non-JSON body during an FCM incident — status alone drives the decision
  }
  // INVALID_ARGUMENT is only a dead-token signal when a fieldViolation blames
  // message.token; otherwise it is a payload fault against a live token.
  if (errorCode === 'INVALID_ARGUMENT' && !tokenFieldViolation) {
    return { token: item.token, status: res.status, error: 'INVALID_ARGUMENT_PAYLOAD' }
  }
  return { token: item.token, status: res.status, error: errorCode ?? `http_${res.status}` }
}
