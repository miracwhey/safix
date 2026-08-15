/**
 * Spatial V1.6 · Phase 2 · Customer-LiDAR Resume Pending Capture
 *
 * Customer-side mirror of `resumePendingCapture.ts`. Surfaces a cached
 * Customer-LiDAR USDZ blob (left over by a crash mid-scan or a force-kill
 * mid-upload) and re-runs the capture pipeline against the cached bytes —
 * yielding a brand-new `scans` row with `owner_type='customer'`.
 *
 * Differences vs. the HW variant:
 *   - `ownerType: 'customer'` on the resumed `captureScan` call (relaxes the
 *     anchor-required throw; matches the F1 migration CHECK).
 *   - No presales-project status bump (Customer Self-Scans are not anchored
 *     to a presales row by design).
 *   - No `promoteScanToScene` — Customer surfaces render directly from the
 *     `spatial-mesh-snapshots` bucket; canonical-scene promotion is deferred
 *     to Phase 5 (HW-Pull-Request) where the HW imports the Customer's scan
 *     into their own project.
 *
 * Plan binding §6 — NOT re-exported from
 * `src/lib/spatial/workflow/index.ts`. Import directly:
 *
 *   import { resumePendingCustomerCapture }
 *     from '@/lib/spatial/workflow/resumePendingCustomerCapture'
 *
 * Rationale: barrel re-exports drag `session.ts`'s module-load
 * `onAuthStateChange` into every offline test (see
 * `feedback_spatial_barrel_no_session_imports`).
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'

import { logError, logInfo, logWarning } from '../../observability'
import {
  type CaptureCacheEntry,
  removeCaptureCacheEntry,
} from '../storage'
import { captureScan } from './captureScan'

export type ResumePendingCustomerCaptureFailure =
  /** The cached entry no longer has a blob or is malformed. */
  | 'cache_invalid'
  /** Re-running captureScan() against the cached blob threw (network, RLS, …). */
  | 'capture_failed'
  /** The cached entry's `userId` does not match the supplied caller — guards
   *  against a different account picking up the previous user's leftover. */
  | 'rbac_user_mismatch'

export type ResumePendingCustomerCaptureResult =
  | {
      ok: true
      newScanId: string
      /** Echoed back so the caller can stay consistent with the HW result-type. */
      presalesProjectId: null
      jobId: string | null
    }
  | {
      ok: false
      reason: ResumePendingCustomerCaptureFailure
      message: string
    }

export interface ResumePendingCustomerCaptureArgs {
  /** Cached entry surfaced by `listResumableCaptures()` filtered to ownerType='customer'. */
  entry: CaptureCacheEntry
  /** Current `auth.uid()`. Guards against cross-account resume. */
  callerUserId: string
}

/**
 * Run one Customer-Resume cycle for a cached entry. The caller has already
 * confirmed the user wants to retry — this workflow does not show toasts or
 * sheets. Mirrors the HW variant's contract.
 */
export async function resumePendingCustomerCapture(
  args: ResumePendingCustomerCaptureArgs,
): Promise<ResumePendingCustomerCaptureResult> {
  const { entry, callerUserId } = args

  if (!entry.usdzBlob || entry.usdzBlob.size === 0) {
    logWarning('spatial.customer_resume.cache_invalid', {
      scanId: entry.scanId,
      bytes: entry.bytes,
    })
    return {
      ok: false,
      reason: 'cache_invalid',
      message: 'Der lokale Cache-Eintrag ist leer oder beschädigt.',
    }
  }

  // RBAC: a different account must not silently inherit the previous user's
  // cached blob. The cache is per-device, so this only happens after a user
  // switch on the same iPad.
  if (!callerUserId || entry.userId !== callerUserId) {
    logWarning('spatial.customer_resume.rbac_user_mismatch', {
      scanId: entry.scanId,
      entryUserId: entry.userId,
      callerUserId,
    })
    return {
      ok: false,
      reason: 'rbac_user_mismatch',
      message:
        'Dieser Scan gehört zu einem anderen Account und kann nicht wiederhergestellt werden.',
    }
  }

  const meshClassification = entry.meshClassificationJson
    ? safeParse<MeshClassification>(entry.meshClassificationJson)
    : undefined

  let newScanId: string
  try {
    const result = await captureScan({
      userId: entry.userId,
      usdzBlob: entry.usdzBlob,
      // Customer Self-Scans may have a job anchor, but the typical Phase-2
      // flow is jobless. Preserve whatever the original capture had.
      jobId: entry.jobId,
      projectId: entry.projectId,
      // Customer Self-Scans are not anchored to presales — even if the cache
      // entry carries a value (cross-flow contamination), force it to null.
      presalesProjectId: null,
      deviceMeta: entry.deviceMeta,
      meshClassification: meshClassification ?? undefined,
      ownerType: 'customer',
      // Customer surface computes its own three-tier label after resume in
      // a follow-up `updateScanQuality` (handled by the screen layer because
      // the cache does not retain the original `RoomScanResult`). Keep
      // autoQuality OFF here so the engine does not run with an incomplete
      // snapshot.
      autoQuality: false,
      autoConvert: false,
    })
    newScanId = result.scan.id
  } catch (err) {
    logError('spatial.customer_resume.capture_failed', err, {
      cacheScanId: entry.scanId,
      jobId: entry.jobId,
    })
    return {
      ok: false,
      reason: 'capture_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Wiederherstellung fehlgeschlagen — bitte später erneut versuchen.',
    }
  }

  // Drop the OLD cache entry. The NEW scan id has its own cache entry that
  // captureScan() already wrote + marked uploaded above.
  await removeCaptureCacheEntry(entry.scanId).catch((err) => {
    logWarning('spatial.customer_resume.cache_cleanup_failed', {
      cacheScanId: entry.scanId,
      message: err instanceof Error ? err.message : 'unknown',
    })
  })

  logInfo('spatial.customer_resume.completed', {
    cacheScanId: entry.scanId,
    newScanId,
    jobId: entry.jobId,
  })

  return {
    ok: true,
    newScanId,
    presalesProjectId: null,
    jobId: entry.jobId,
  }
}

function safeParse<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}
