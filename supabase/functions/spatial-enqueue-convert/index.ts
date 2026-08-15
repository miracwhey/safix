/**
 * Edge Function `spatial-enqueue-convert` — POST a signed convert request to
 * the Cloud Run worker `services/spatial-convert/`.
 *
 * Invoked by the SaFix client immediately after `uploadScanAsset({kind: 'usdz'})`
 * lands an asset. The function:
 *
 *   1. Verifies the caller's JWT and that they have write access to the scan
 *      (`spatial_can_edit_scan` SECURITY DEFINER helper — same gate the
 *      storage RLS uses).
 *   2. Computes an HMAC-SHA256 over the canonical request body using the
 *      shared `SPATIAL_CONVERT_TOKEN`.
 *   3. Sends `POST {SPATIAL_CONVERT_URL}/convert` with the signature in the
 *      `X-Spatial-Convert-Signature` header.
 *   4. Returns the worker ack to the caller. The worker is async — convert
 *      completion is signalled by a fresh `scan_assets` row of `kind='gltf'`,
 *      which the client picks up via Realtime (`useScanConvertStatus`).
 *
 * Auth: end-user JWT required (`verify_jwt: true` in `supabase/config.toml`
 * or simply present a non-anon `Authorization` header). The function reads
 * `auth.uid()` from the request JWT to gate the spatial_can_edit_scan check.
 *
 * Env vars (set via `supabase secrets set`):
 *   SPATIAL_CONVERT_URL    — Cloud Run public URL (e.g. https://spatial-convert-...run.app)
 *   SPATIAL_CONVERT_TOKEN  — shared HMAC secret with the Cloud Run worker
 *   SUPABASE_URL           — auto-injected by the edge runtime
 *   SUPABASE_ANON_KEY      — auto-injected; used to validate the user JWT
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected; used for the SECURITY DEFINER probe
 */

// @ts-expect-error Deno-only import — resolved by the Supabase Edge runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
// @ts-expect-error Deno-only import — resolved by the Supabase Edge runtime.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

declare const Deno: {
  env: { get(name: string): string | undefined }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }

  const convertUrl = Deno.env.get('SPATIAL_CONVERT_URL')
  const convertToken = Deno.env.get('SPATIAL_CONVERT_TOKEN')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')
  const supabaseService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!convertUrl || !convertToken || !supabaseUrl || !supabaseAnon || !supabaseService) {
    return jsonResponse({ error: 'misconfigured' }, 500)
  }

  const auth = req.headers.get('authorization')
  if (!auth?.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let payload: { scanId?: string; usdzPath?: string }
  try {
    payload = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
  const scanId = String(payload.scanId ?? '')
  const usdzPath = String(payload.usdzPath ?? '')
  if (!scanId || !usdzPath) {
    return jsonResponse({ error: 'missing_field' }, 400)
  }
  if (!/^[0-9a-f-]{36}$/i.test(scanId)) {
    return jsonResponse({ error: 'invalid_scan_id' }, 400)
  }
  // Path-ownership guard — the source path MUST live in the storage namespace
  // of the scan we authorize below. The `project-scans` bucket schema is
  // `{userId}/{scanId}/{kind}/file.ext` (Block A.1 storage RLS), so the 2nd
  // path segment is the owning scan and the 3rd is the asset `kind`. Without
  // this binding an elevated worker would convert ANOTHER scan's (or user's)
  // USDZ onto this caller's scan, since the convert relay trusts `usdzPath`
  // verbatim. Reject path-traversal and any cross-scan / wrong-kind reference.
  const pathSegments = usdzPath.split('/')
  if (
    usdzPath.includes('..') ||
    pathSegments.length < 4 ||
    pathSegments[1] !== scanId ||
    pathSegments[2] !== 'usdz'
  ) {
    return jsonResponse({ error: 'path_scan_mismatch' }, 403)
  }

  // 1. Validate the caller via user-JWT and probe the edit-permission.
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data: userInfo, error: userError } = await userClient.auth.getUser()
  if (userError || !userInfo.user) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  const adminClient = createClient(supabaseUrl, supabaseService, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  // Use the wider `spatial_can_convert_scan` helper (migration 73): the
  // edit-helper revokes captured_by once status leaves draft|capturing,
  // which silently broke "Webansicht erzeugen" for the craftsman the
  // instant their scan reached `captured`.
  const { data: canConvert, error: probeError } = await adminClient.rpc(
    'spatial_can_convert_scan',
    { p_scan_id: scanId, p_uid: userInfo.user.id },
  )
  if (probeError) {
    return jsonResponse({ error: 'probe_failed', message: probeError.message }, 500)
  }
  if (canConvert !== true) {
    return jsonResponse({ error: 'forbidden' }, 403)
  }

  // 2. Sign + relay. Idempotency-key derived from (scanId, usdzPath) so two
  // clicks within the worker's 5-min memory window dedupe at the server.
  // A random UUID per request reduced this guard to zero coverage.
  const idempotencyKey = await sha256Hex(`${scanId}:${usdzPath}`)
  const bodyToSign = JSON.stringify({ scanId, usdzPath, idempotencyKey })
  const signature = await hmacHex(convertToken, bodyToSign)

  let workerResponse: Response
  try {
    workerResponse = await fetch(`${convertUrl}/convert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Spatial-Convert-Signature': signature,
      },
      body: bodyToSign,
    })
  } catch (err) {
    return jsonResponse({ error: 'worker_unreachable', message: String(err) }, 502)
  }
  const ack = await workerResponse.text()
  return new Response(ack, {
    status: workerResponse.status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
})
