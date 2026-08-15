/**
 * transcode-portfolio-video Edge Function — source contract (Block 0).
 *
 * The function holds the wire-up for the asynchronous H.264 transcode
 * pipeline. The actual transcoding is delegated to an external provider
 * (Mux / Cloudflare Stream / Coconut / self-hosted FFmpeg) that the
 * operator picks at deploy time. We freeze the function shape so:
 *  - the trigger header name matches the (yet-to-be-written) DB webhook
 *  - the payload guards reject malformed bodies before any side effect
 *  - the no-op short-circuits (image items, already-transcoded rows)
 *    return 200 so a webhook replay does not page on success
 *  - the "no provider configured" default returns 503 with a stable
 *    reason key the deploy-readiness dashboard can match on
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(
    repoRoot,
    'supabase/functions/transcode-portfolio-video/index.ts',
  ),
  'utf-8',
)

describe('transcode-portfolio-video: trigger contract', () => {
  it('exports Deno.serve with a POST guard', () => {
    expect(source).toContain('Deno.serve')
    expect(source).toMatch(/req\.method !== 'POST'/)
  })

  it('uses the canonical trigger-secret header name', () => {
    expect(source).toContain("'x-fixup-trigger-secret'")
    expect(source).toContain('FIXUP_TRANSCODE_SHARED_SECRET')
  })

  it('rejects without the shared secret', () => {
    expect(source).toMatch(/return json\(401, \{ error: 'unauthorized' \}\)/)
  })
})

describe('transcode-portfolio-video: payload guards', () => {
  it('parses JSON defensively and returns 400 on bad bodies', () => {
    expect(source).toContain("'invalid_json'")
  })

  it('only acts on INSERT events into provider_media', () => {
    expect(source).toMatch(/body\.type !== 'INSERT'/)
    expect(source).toMatch(/body\.table !== 'provider_media'/)
  })

  it('skips image inserts with 200 (silent success — webhook hits all rows)', () => {
    expect(source).toContain("skipped: 'not_a_video'")
  })

  it('skips already-transcoded rows for replay protection', () => {
    expect(source).toContain("skipped: 'already_transcoded'")
  })

  it('rejects records missing storage_path / public_url', () => {
    expect(source).toContain("'record_missing_storage_fields'")
  })
})

describe('transcode-portfolio-video: provider routing', () => {
  it('reads the operator-chosen provider from env', () => {
    expect(source).toContain('FIXUP_TRANSCODE_PROVIDER')
  })

  it('returns 503 with a stable reason key when no provider is configured', () => {
    expect(source).toContain("reason: 'transcode_provider_not_configured'")
  })

  it('lists Mux / Cloudflare / Coconut / self as accepted provider keys', () => {
    expect(source).toMatch(/case 'mux':[\s\S]*case 'cloudflare':[\s\S]*case 'coconut':[\s\S]*case 'self':/)
  })

  it('exposes a setH264Url(mediaId, url) callback that updates provider_media via service-role', () => {
    expect(source).toContain("from('provider_media')")
    expect(source).toMatch(/\.update\(\{\s*h264_url:\s*h264Url\s*\}\)/)
    expect(source).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('returns 503 with provider name when an adapter is missing (visible in logs)', () => {
    expect(source).toContain("reason: 'transcode_provider_adapter_missing'")
  })
})
