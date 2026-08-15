/**
 * Spatial V1.6.1 · Item #3 · Customer-LiDAR Resume-Detect (Hub-Mount)
 *
 * Surfaces the local capture-cache rows that BELONG to the calling customer
 * and were captured under `ownerType='customer'`. Two layered guards:
 *
 *   1. Local owner-filter — `entry.userId === callerUserId`. The cache is
 *      per-device, so a user switch on the same iPad must not see the
 *      previous account's leftovers.
 *   2. Server scan-row check — `repository.getScan(entry.scanId)?.ownerType`
 *      must equal `'customer'`. The repository is RLS-guarded (auth.uid()
 *      vs scan.captured_by + owner_type='customer' policy); a foreign-user
 *      entry that somehow leaked into the cache cannot surface here.
 *
 * The HW-side `useResumePendingCaptures` already covers craftsman scans via
 * the existing `ResumePendingScanSheet`. This file is the customer-only
 * counterpart so the Customer Hub never offers a HW-flavoured resume UI
 * (and vice versa — feedback_customer_skin_no_feature_loss enforces that
 * the customer skin has its own surface, not a re-skin of the HW one).
 *
 * Plan binding §6 — NOT re-exported from
 * `src/lib/spatial/workflow/index.ts`. Import directly:
 *
 *   import { listResumablePendingCustomerCaptures }
 *     from '@/lib/spatial/workflow/listResumablePendingCustomerCaptures'
 *
 * Rationale: barrel re-exports drag `session.ts`'s module-load
 * `onAuthStateChange` into every offline test (see
 * `feedback_spatial_barrel_no_session_imports`).
 */

import { logWarning } from '../../observability'
import { getSpatialRepository } from '../repository/registry'
import {
  type CaptureCacheEntry,
  listCaptureCache,
} from '../storage'
import type { Scan } from '../types'

export interface ResumableCustomerCapture {
  entry: CaptureCacheEntry
  /** Source scan row — used by the sheet to render the room label / started-at. */
  scan: Scan
}

/**
 * Return every resumable capture-cache row that the supplied customer should
 * see at Hub-Mount. Skips entries that:
 *
 *   - are already `uploaded` (terminal happy state)
 *   - belong to a different `userId` (cross-account guard)
 *   - reference a scan row that no longer exists or whose `ownerType !==
 *     'customer'` (HW scans live in their own sheet; orphans are dropped)
 *
 * Sorted oldest-first so the customer resolves the longest-pending one
 * first — matches the HW sheet ordering.
 *
 * Returns an empty array on any caller-validation failure (no userId, no
 * cache entries) so the hub-mount detection is null-safe.
 */
export async function listResumablePendingCustomerCaptures(
  callerUserId: string | null | undefined,
): Promise<ResumableCustomerCapture[]> {
  if (!callerUserId) return []

  const all = await listCaptureCache().catch((err) => {
    logWarning('spatial.customer_resume.list_cache_failed', {
      message: err instanceof Error ? err.message : 'unknown',
    })
    return [] as CaptureCacheEntry[]
  })

  // First layer — drop terminal + foreign-user rows before we round-trip to
  // the repository. Saves N getScan() calls per Hub-Mount when the cache is
  // mixed-tenant on a shared device.
  const candidates = all
    .filter((e) => e.status !== 'uploaded')
    .filter((e) => e.userId === callerUserId)

  if (candidates.length === 0) return []

  const repo = getSpatialRepository()
  const enriched: ResumableCustomerCapture[] = []

  // Sequential, not parallel: typical n is 0-2 (one cache entry per active
  // capture). A `Promise.all` here would burn 2-3 simultaneous RLS queries
  // for a feature most users hit once. Sequential keeps the network polite.
  for (const entry of candidates) {
    let scan: Scan | null = null
    try {
      scan = await repo.getScan(entry.scanId)
    } catch (err) {
      logWarning('spatial.customer_resume.scan_lookup_failed', {
        scanId: entry.scanId,
        message: err instanceof Error ? err.message : 'unknown',
      })
      continue
    }
    if (!scan) {
      // Cache entry references a scan row that the user can no longer see
      // (RLS deny) or that has been deleted. Skip — the user can still
      // re-scan; we don't try to backfill a missing parent here.
      continue
    }
    if (scan.ownerType !== 'customer') continue
    enriched.push({ entry, scan })
  }

  enriched.sort((a, b) => a.entry.capturedAt - b.entry.capturedAt)
  return enriched
}
