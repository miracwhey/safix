/**
 * Spatial Core · Block X.3 · Client-side convert enqueue
 *
 * Triggered immediately after `uploadScanAsset({kind: 'usdz'})` lands so the
 * Cloud Run worker can start producing the glb while the user is still in
 * the success screen.
 *
 * The actual heavy lifting (HMAC + relay) lives in the edge function
 * `spatial-enqueue-convert`. This helper just invokes it and surfaces a
 * structured result so the workflow layer can decide whether to surface a
 * toast, retry, or swallow.
 *
 * Lane-2.5 · Stream A5 — manual retry path: when a user taps the
 * "3D-Modell hängt — erneut versuchen" CTA on a stuck scan, the call-site
 * forwards `retryCount` so Sentry breadcrumbs distinguish autoConvert-on-
 * capture from a deliberate user retry. The Edge Function itself is
 * idempotent (HMAC + scan_id key) so re-firing is safe.
 */

import * as Sentry from '@sentry/react'

import { supabase } from '../../supabase'
import { logInfo } from '../../observability'

export interface EnqueueConvertArgs {
  scanId: string
  usdzPath: string
  /**
   * Lane-2.5 Stream A5: how many manual retries preceded this call. 0 for
   * the original autoConvert post-capture call (default). Increments on each
   * user-triggered "Retry". Persisted only in the Sentry breadcrumb
   * (`spatial.convert.user_retry`) — there is no DB column for it, so a
   * page-reload resets the counter back to 0. That's intentional: the user
   * can retry afresh after coming back, and Cloud Run's dedup makes the
   * extra call cheap.
   */
  retryCount?: number
}

export interface EnqueueConvertResult {
  ok: boolean
  status: number
  message?: string
  dedup?: boolean
}

export async function enqueueConvertJob(args: EnqueueConvertArgs): Promise<EnqueueConvertResult> {
  const retryCount = args.retryCount ?? 0
  Sentry.addBreadcrumb({
    category: 'spatial.convert',
    level: 'info',
    message: 'enqueue_convert',
    data: {
      scanId: args.scanId,
      retryCount,
    },
  })
  if (retryCount > 0) {
    logInfo('spatial.convert.user_retry', { scanId: args.scanId, retryCount })
  }
  try {
    const { data, error } = await supabase.functions.invoke<{ ok: boolean; dedup?: boolean }>(
      'spatial-enqueue-convert',
      {
        body: { scanId: args.scanId, usdzPath: args.usdzPath },
      },
    )
    if (error) {
      return { ok: false, status: 500, message: error.message }
    }
    return { ok: !!data?.ok, status: 200, dedup: data?.dedup }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
