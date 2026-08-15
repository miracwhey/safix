/**
 * Spatial · Lane 2.5 · Stream A · Resume Pending Capture (Workflow)
 *
 * Re-uploads a USDZ blob that was cached locally by `captureScan()` but never
 * made it to Supabase Storage (network drop, tab kill, iOS app kill). The
 * Resume sheet at Hub mount surfaces each `pending|failed|aborted` cache row
 * and routes the user's "Hochladen & Weitermachen" tap through this workflow.
 *
 * Strategy — fresh scan, not in-place resume:
 *   The original `scans` row for the cached blob is almost always either
 *   `archived` (captureScan's catch path) or stuck in `capturing` (iOS app
 *   kill before catch ran). Neither state has an FSM edge that lets us simply
 *   re-upload against the same id; the scan FSM (migration 20260518000005)
 *   only forwards `draft→capturing→captured`. Recovering through the existing
 *   row would mean adding `archived→draft` or similar — a regression on the
 *   immutability the FSM gives us.
 *
 *   So instead, Resume kicks off a brand-new `captureScan()` cycle with the
 *   cached blob. The new scan owns:
 *     - a fresh `scans` row + scanId
 *     - its own (new) capture-cache entry, written by captureScan() and
 *       automatically `markUploaded()`-flagged on success
 *     - server-side conversion to glb via `autoConvert: true`
 *     - best-effort canonical-scene promotion (succeeds only if the user is
 *       resuming in the same tab as the original capture — the native plugin
 *       still has the CapturedRoom in memory; after a hard restart it does
 *       not, and the 3D viewer falls back to the glb produced by the convert
 *       pipeline)
 *
 *   The OLD cache entry is removed after the resume succeeds. The OLD scan
 *   row stays as an archived/orphan; ops can sweep it later. We do not try
 *   to delete it here because (a) RLS on scans is owner-only and we don't
 *   want to surprise the user with a delete, and (b) audit/forensics may
 *   want the trail of the failed attempt.
 *
 * Result-typed: every failure surfaces with a typed reason so the UI can
 * pick the right toast. No unhandled rejection.
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'

import { logError, logInfo, logWarning } from '../../observability'
import { getPresalesProjectRepository } from '../../presales/repository/registry'
import { promoteScanToScene } from '../canonical/workflow/promoteScanToScene'
import type { SpatialScene } from '../canonical/repository/SpatialSceneRepository'
import {
  type CaptureCacheEntry,
  removeCaptureCacheEntry,
} from '../storage'
import { captureScan } from './captureScan'

export type ResumePendingCaptureFailure =
  /** The cached entry no longer has a blob or is malformed. */
  | 'cache_invalid'
  /** Re-running captureScan() against the cached blob threw (network, RLS, …). */
  | 'capture_failed'

export type ResumePendingCaptureResult =
  | {
      ok: true
      newScanId: string
      /** Set iff the canonical-scene promote also succeeded (same-tab resume). */
      scene?: SpatialScene
      presalesProjectId: string | null
    }
  | {
      ok: false
      reason: ResumePendingCaptureFailure
      message: string
    }

/**
 * Run one Resume cycle for a cached entry. The caller has already confirmed
 * the user wants to retry — this workflow does not show toasts or sheets.
 */
export async function resumePendingCapture(
  entry: CaptureCacheEntry,
): Promise<ResumePendingCaptureResult> {
  if (!entry.usdzBlob || entry.usdzBlob.size === 0) {
    logWarning('spatial.resume.cache_invalid', {
      scanId: entry.scanId,
      bytes: entry.bytes,
    })
    return {
      ok: false,
      reason: 'cache_invalid',
      message: 'Der lokale Cache-Eintrag ist leer oder beschädigt.',
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
      presalesProjectId: entry.presalesProjectId,
      jobId: entry.jobId,
      projectId: entry.projectId,
      deviceMeta: entry.deviceMeta,
      meshClassification: meshClassification ?? undefined,
      // Mirror useStartRoomScan / useStartPresalesRoomScan: full Quality
      // + server-side glb conversion so the 3D viewer has an asset to
      // render even when the native promote-path is unavailable.
      autoQuality: true,
      autoConvert: true,
    })
    newScanId = result.scan.id
  } catch (err) {
    logError('spatial.resume.capture_failed', err, {
      cacheScanId: entry.scanId,
      presalesProjectId: entry.presalesProjectId,
      jobId: entry.jobId,
      projectId: entry.projectId,
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

  // Best-effort canonical-scene promote. Succeeds only when the user resumes
  // in the same tab/session as the original capture: the native plugin's
  // cached CapturedRoom is the AD-1 source-of-truth and it does not survive
  // a hard restart. The convert-pipeline (autoConvert above) covers the
  // hard-restart case by producing a glb.
  let scene: SpatialScene | undefined
  try {
    const promo = await promoteScanToScene({
      scanId: newScanId,
      uploaderUserId: entry.userId,
      jobId: entry.jobId ?? undefined,
      projectId: entry.projectId ?? undefined,
    })
    if (promo.ok) {
      scene = promo.scene
    } else {
      logInfo('spatial.resume.promote_skipped', {
        newScanId,
        reason: promo.reason,
      })
    }
  } catch (promoteErr) {
    logInfo('spatial.resume.promote_unavailable', {
      newScanId,
      message:
        promoteErr instanceof Error ? promoteErr.message : 'unknown',
    })
  }

  // Bump the presales project to 'scanned' on the same gate as
  // useStartPresalesRoomScan (Lane-1 F-06: only when canonical scene exists).
  // Without scene, the presales row stays in 'draft' and the Hub's recovery-
  // card path keeps offering "Scan jetzt starten".
  if (entry.presalesProjectId && scene) {
    try {
      await getPresalesProjectRepository().update(entry.presalesProjectId, {
        status: 'scanned',
        scannedAt: new Date().toISOString(),
      })
    } catch (err) {
      logError('spatial.resume.presales_mark_scanned_failed', err, {
        presalesProjectId: entry.presalesProjectId,
        newScanId,
      })
    }
  }

  // Drop the OLD cache entry. The NEW scan id has its own cache entry that
  // captureScan() already wrote + marked uploaded above.
  await removeCaptureCacheEntry(entry.scanId).catch((err) => {
    logWarning('spatial.resume.cache_cleanup_failed', {
      cacheScanId: entry.scanId,
      message: err instanceof Error ? err.message : 'unknown',
    })
  })

  logInfo('spatial.resume.completed', {
    cacheScanId: entry.scanId,
    newScanId,
    promoted: scene != null,
    presalesProjectId: entry.presalesProjectId,
  })

  return {
    ok: true,
    newScanId,
    scene,
    presalesProjectId: entry.presalesProjectId,
  }
}

/**
 * Discard a cached capture without uploading. Used by the "Verwerfen" action
 * in the Resume sheet. We log so a misclick is recoverable from forensics —
 * the user can re-scan, but the lost blob cannot be retrieved.
 */
export async function discardPendingCapture(
  entry: CaptureCacheEntry,
): Promise<void> {
  logInfo('spatial.resume.discarded_by_user', {
    cacheScanId: entry.scanId,
    presalesProjectId: entry.presalesProjectId,
    bytes: entry.bytes,
    status: entry.status,
  })
  await removeCaptureCacheEntry(entry.scanId)
}

function safeParse<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}
