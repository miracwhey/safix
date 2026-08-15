// Spatial Core · Block G.2 / J hotfix · Push on Convert-Done
//
// Edge Function invoked by the `spatial_notify_convert_done` Postgres trigger
// when a fresh `scan_assets` row with `kind = 'gltf'` lands (Block X convert
// pipeline). Inserts a `notification_signals` row that the existing push
// pipeline picks up and forwards to the user who owns the scan, telling them
// their 3D model is ready.
//
// Auth: HMAC-SHA256 signature in `x-spatial-convert-signature` over the raw
// body using the `spatial_convert_done_push.shared_secret` vault row.
// Service-role bearer is intentionally NOT used — it would leak in
// `net.http_request_queue.headers`.
//
// Trust-but-verify: even with a valid HMAC, the function rechecks that the
// scan exists and `scans.captured_by == payload.user_id` before emitting
// the notification. Prevents spoofing if the shared secret ever leaks.
//
// Phase 2 hotfix 2026-05-20: aligned the `notification_signals` INSERT to
// the live prod schema. Previous code wrote columns
// (user_id, kind, title, body, payload, delivered_at) that NEVER existed
// — the insert returned 42703 silently and the push surface was dead.
// The actual schema is (id, job_id NOT NULL, type, priority, read,
// occurred_at, recipient_role, entity_id, entity_type, action_type,
// role_target, expected_status, expires_at). `job_id` is required by the
// schema; for project-only scans (no job_id) the push is skipped because
// the existing notification pipeline is job-scoped.

// @ts-expect-error — Deno globals only available at edge runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
// @ts-expect-error — Deno-specific Supabase client URL.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

interface ConvertDonePayload {
  scan_id: string
  asset_id: string
  user_id: string
}

const SERVICE_ROLE_KEY = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(
  'SUPABASE_SERVICE_ROLE_KEY',
)
const SUPABASE_URL = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(
  'SUPABASE_URL',
)

let cachedSecret: { value: string; loadedAt: number } | null = null
const SECRET_CACHE_MS = 5 * 60 * 1000

async function getSharedSecret(client: ReturnType<typeof createClient>): Promise<string | null> {
  const now = Date.now()
  if (cachedSecret && now - cachedSecret.loadedAt < SECRET_CACHE_MS) {
    return cachedSecret.value
  }
  const { data, error } = await client.rpc('spatial_get_convert_push_secret')
  if (error || typeof data !== 'string' || data.length === 0) return null
  cachedSecret = { value: data, loadedAt: now }
  return cachedSecret.value
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacHex(secretHex: string, body: string): Promise<string> {
  // Trigger uses `extensions.hmac(body::bytea, secret::bytea, 'sha256')` with
  // the secret already in hex form. We sign the raw text body the same way
  // the trigger does: secret bytes are the literal hex string bytes, not the
  // decoded hex value. This matches pgcrypto's hmac(bytea, bytea).
  const keyBytes = new TextEncoder().encode(secretHex)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return bytesToHex(new Uint8Array(sig))
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (!SERVICE_ROLE_KEY || !SUPABASE_URL) {
    return new Response(JSON.stringify({ error: 'env_missing' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const sharedSecret = await getSharedSecret(client)
  if (!sharedSecret) {
    return new Response(JSON.stringify({ error: 'secret_unavailable' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const rawBody = await req.text()
  const providedSig = (req.headers.get('x-spatial-convert-signature') ?? '').trim()
  if (!providedSig) {
    return new Response(JSON.stringify({ error: 'unsigned' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  const expectedSig = await hmacHex(sharedSecret, rawBody)
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return new Response(JSON.stringify({ error: 'bad_signature' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  let payload: ConvertDonePayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (!payload.scan_id || !payload.user_id) {
    return new Response(JSON.stringify({ error: 'missing_fields' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Trust-but-verify: scan exists + ownership matches AND fetch job_id so
  // the notification_signals row carries the required FK.
  const { data: scan, error: scanErr } = await client
    .from('scans')
    .select('id, captured_by, job_id')
    .eq('id', payload.scan_id)
    .maybeSingle()

  if (scanErr) {
    return new Response(JSON.stringify({ error: scanErr.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (!scan || (scan as { captured_by: string | null }).captured_by !== payload.user_id) {
    return new Response(JSON.stringify({ error: 'scan_mismatch' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  const jobId = (scan as { job_id: string | null }).job_id
  if (!jobId) {
    // Project-scope scan (no job linkage). The notification_signals table
    // requires job_id NOT NULL — the existing push pipeline is job-scoped.
    // Return 200 with a no-op flag so the trigger sees success; the user
    // still sees the new glTF asset via realtime / hydration when they
    // open the project — push is just the convenience layer.
    return new Response(JSON.stringify({ ok: true, skipped: 'project_only_scan' }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  // Schema-aligned INSERT. `entity_id` carries the scan_id so the existing
  // pushRouteMap can resolve `type='spatial_convert_ready'` →
  // `/spatial/scan/{scan_id}` once the route mapping ships in PR #926 fix.
  const { error } = await client.from('notification_signals').insert({
    job_id: jobId,
    type: 'spatial_convert_ready',
    priority: 'low',
    read: false,
    occurred_at: Date.now(),
    recipient_role: 'craftsman',
    entity_id: payload.scan_id,
    entity_type: 'scan',
    action_type: 'open_viewer',
  })

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  })
})
