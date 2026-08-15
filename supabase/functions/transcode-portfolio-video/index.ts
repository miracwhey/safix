/**
 * Edge Function `transcode-portfolio-video` — Block 0 transcoder skeleton.
 *
 * Invoked by a Supabase Database Webhook on INSERT into `provider_media`
 * where `media_type = 'video'`. The function uploads an H.264 .mp4
 * fallback for HEVC `.mov` originals and stores its public URL in
 * `provider_media.h264_url`. Renderers then pick the H.264 source via
 * `selectVideoSource(item)` on browsers that cannot decode HEVC.
 *
 * ── Auth ──────────────────────────────────────────────────────────────
 * `verify_jwt: false`. The trigger header `x-fixup-trigger-secret` must
 * match `Deno.env.get('FIXUP_TRANSCODE_SHARED_SECRET')`. Same pattern as
 * `notify-push`.
 *
 * ── Decision point (intentionally unwired) ───────────────────────────
 * The function shape and Storage round-trip are ready. The actual codec
 * conversion is delegated to an external service so the runtime stays
 * within Edge-Function memory + 60s wall-clock limits. The operator
 * picks ONE of the following before go-live:
 *
 *   A) Mux Video — `https://api.mux.com/video/v1/assets`
 *      Pros: 4K-aware, generous free tier (100 min/mo), polished
 *            encoding presets, JWT-signed playback URLs.
 *      Cons: Adds vendor SLA dependency. Pricing scales with delivery
 *            minutes; aggressive view counts on a hit reel can spike.
 *
 *   B) Cloudflare Stream — `https://api.cloudflare.com/.../stream`
 *      Pros: Bundled with Cloudflare account; flat $1/1k minutes
 *            stored + $1/1k delivered. Good worldwide CDN already.
 *      Cons: HLS-first, not direct .mp4. Need to render via
 *            HLS.js on Android Chromium for the fallback player.
 *
 *   C) Coconut.co — `https://api.coconut.co/v2/jobs`
 *      Pros: Pay-as-you-go ($0.03/min), straight `.mp4` output, no
 *            view-time billing.
 *      Cons: Smaller vendor.
 *
 *   D) Self-hosted FFmpeg worker (Fly.io / Render / Hetzner)
 *      Pros: Predictable cost; no per-minute fees.
 *      Cons: Operations burden (queue, retries, autoscale), opaque
 *            on incident days.
 *
 * Until the operator picks a provider this function returns 503 with
 * `{"reason":"transcode_provider_not_configured"}`. The schema +
 * client-side selector are already shipped so flipping the env var is
 * the only step required to start filling `h264_url`.
 *
 * ── Body shape (from the Database Webhook) ──────────────────────────
 *   {
 *     "type": "INSERT",
 *     "table": "provider_media",
 *     "record": {
 *       "id": "<media uuid>",
 *       "provider_id": "<uuid>",
 *       "media_type": "video",
 *       "storage_path": "portfolio/<provider>/<uuid>.mov",
 *       "public_url": "https://<project>.supabase.co/storage/v1/object/public/media/<path>",
 *       "h264_url": null,
 *       …
 *     },
 *     "schema": "public"
 *   }
 *
 * ── Env vars ─────────────────────────────────────────────────────────
 *   FIXUP_TRANSCODE_SHARED_SECRET  — shared secret with the trigger
 *   FIXUP_TRANSCODE_PROVIDER       — "mux" | "cloudflare" | "coconut" | "self"
 *   SUPABASE_URL                   — set automatically
 *   SUPABASE_SERVICE_ROLE_KEY      — set automatically
 *   (Plus per-provider credentials once the operator picks one.)
 *
 * ── Returns ──────────────────────────────────────────────────────────
 *   200 — `{ ok: true, h264Url: "…" }` (transcode succeeded + DB updated)
 *   202 — `{ ok: true, status: "queued", jobId: "…" }` (async provider — DB
 *         will be filled by the provider's webhook callback)
 *   401 — bad shared secret
 *   400 — malformed body / non-video record
 *   503 — `{ reason: "transcode_provider_not_configured" }` (default until
 *         operator picks one of A–D above)
 *   502 — `{ reason: "transcode_provider_failed", detail: "…" }`
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

type WebhookPayload = {
  type?: string
  table?: string
  record?: {
    id: string
    media_type: string | null
    storage_path: string | null
    public_url: string | null
    h264_url?: string | null
  }
}

const TRIGGER_SECRET_HEADER = 'x-fixup-trigger-secret'

// Constant-time secret comparison so a brute-force probe cannot recover the
// expected secret byte-by-byte from response-timing differences.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' })
  }

  const expected = Deno.env.get('FIXUP_TRANSCODE_SHARED_SECRET') ?? ''
  const provided = req.headers.get(TRIGGER_SECRET_HEADER) ?? ''
  if (!expected || !timingSafeEqual(provided, expected)) {
    return json(401, { error: 'unauthorized' })
  }

  let body: WebhookPayload
  try {
    body = (await req.json()) as WebhookPayload
  } catch {
    return json(400, { error: 'invalid_json' })
  }

  if (body.type !== 'INSERT' || body.table !== 'provider_media') {
    return json(400, { error: 'wrong_event' })
  }

  const record = body.record
  if (!record || record.media_type !== 'video') {
    // Image inserts hit the trigger too — silent OK is correct.
    return json(200, { ok: true, skipped: 'not_a_video' })
  }
  if (record.h264_url) {
    // Re-trigger / replay protection.
    return json(200, { ok: true, skipped: 'already_transcoded' })
  }
  if (!record.storage_path || !record.public_url) {
    return json(400, { error: 'record_missing_storage_fields' })
  }

  const provider = (Deno.env.get('FIXUP_TRANSCODE_PROVIDER') ?? '').toLowerCase()
  if (!provider) {
    return json(503, { reason: 'transcode_provider_not_configured' })
  }

  // The Supabase service-role client is wired up so the chosen provider
  // adapter only needs to call `setH264Url(mediaId, url)` after upload.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const ctx = {
    mediaId: record.id,
    storagePath: record.storage_path,
    publicUrl: record.public_url,
    setH264Url: async (h264Url: string) => {
      const { error } = await admin
        .from('provider_media')
        .update({ h264_url: h264Url })
        .eq('id', record.id)
      if (error) throw new Error(`db_update_failed: ${error.message}`)
    },
  }

  switch (provider) {
    case 'mux':
    case 'cloudflare':
    case 'coconut':
    case 'self':
      // Provider adapters intentionally not implemented here; flipping the
      // env var is meaningless until the operator wires one in. We return
      // a 503 with the chosen provider name to make the gap visible in
      // logs and dashboards.
      return json(503, {
        reason: 'transcode_provider_adapter_missing',
        provider,
        note: 'Wire the provider adapter to call ctx.setH264Url(...) after upload.',
        ctx_shape: { mediaId: ctx.mediaId, storagePath: ctx.storagePath, publicUrl: ctx.publicUrl },
      })
    default:
      return json(503, { reason: 'transcode_provider_unknown', provider })
  }
})

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
