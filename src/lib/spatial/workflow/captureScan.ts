/**
 * Spatial Core · Block B.5 · One-call Capture Helper
 *
 * Glue between the RoomPlan plugin / file pipeline and the Spatial domain.
 * Performs a full capture lifecycle in one workflow:
 *
 *   1. createScan (status='draft')
 *   2. cacheCapture (Lane-2.5 · Stream A) — persist blob to IDB before any
 *      network-bound step, so an app-kill mid-upload is recoverable.
 *   3. startCapture → 'capturing'
 *   4. uploadScanAsset (USDZ blob, content-addressed, dedup-safe)
 *   5. markCaptureUploaded (Lane-2.5 · Stream A) — flag the cache row.
 *   6. finishCapture → 'captured', stamps scanEndedAt + telemetry
 *
 * Any failure after createScan attempts to leave the scan in a recoverable
 * state — callers can retry uploadScanAsset alone, or archive the scan if
 * the user abandons the flow. Errors bubble up unchanged so the legacy
 * useRoomScan() path can still surface a friendly toast.
 *
 * Lane-2.5 Stream A: the IDB capture-cache mirror keeps a Blob alive across
 * a hard tab/app kill. On the next Hub mount, `listResumableCaptures()`
 * surfaces this entry to the ResumePendingScanSheet so the user can decide
 * to re-upload or discard. Cache writes are best-effort — a quota miss or
 * IDB failure logs a warning but does NOT abort the scan, because the
 * server-side `scans` row is still the source of truth.
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'

import { logError, logWarning } from '../../observability'
import type {
  CreateScanInput,
  Scan,
  ScanAsset,
  ScanDeviceMeta,
  ScanOwnerType,
} from '../types'
import { meshSummaryFromClassification } from '../quality/meshSummaryFromClassification'
import { getSpatialRepository } from '../repository/registry'
import {
  cacheCapture,
  markCaptureFailed,
  markCaptureUploaded,
  uploadMeshSummaryAsset,
  uploadScanAsset,
} from '../storage'
import {
  startCapture,
  finishCapture,
  archive,
  ScanWorkflowError,
} from './scanStateMachine'
import { enqueueConvertJob } from './enqueueConvert'

export interface CaptureScanInput {
  /** Linkage — at least one of jobId / projectId / presalesProjectId required (CHECK enforced). */
  projectId?: string | null
  jobId?: string | null
  /** Provider-presales-project anchor (V1.5). */
  presalesProjectId?: string | null
  /** auth.uid() of the user driving the capture. RLS enforces server-side. */
  userId: string
  /** USDZ payload from the RoomPlan plugin. */
  usdzBlob: Blob
  /** Plugin-reported device + sensor telemetry — persisted on scan + audit. */
  deviceMeta?: ScanDeviceMeta
  /** Optional capture telemetry for finishCapture audit payload. */
  fpsSample?: number
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical'
  durationSec?: number
  /** Optional parent scan for re-scan version chains. */
  parentScanId?: string | null
  /**
   * Block C.4: forwards to `finishCapture({ autoQuality })` — runs the
   * Quality Engine + transitions to `quality_checked` after upload. Default
   * false so the legacy "capture only" caller behaviour is preserved.
   */
  autoQuality?: boolean
  /**
   * Block X.3: when true, the captured USDZ is enqueued for server-side
   * conversion to glb via `spatial-enqueue-convert` immediately after the
   * upload completes. The glb appears asynchronously as a fresh
   * `scan_assets` row with `kind='gltf'` — `useScanConvertStatus(scanId)`
   * surfaces the state. Default false so call-sites that only need the
   * USDZ (e.g. iOS native viewer) don't pay the Cloud Run round-trip.
   */
  autoConvert?: boolean
  /**
   * Phase 2 · Hybrid mesh-classification aggregate from the harvester,
   * present on iOS 17+ LiDAR devices when `SPATIAL_HYBRID_MESH_ENABLED`
   * is on. When supplied:
   *   1. captureScan persists it as `mesh_summary.json` in storage
   *      (forensics + Hub thumbnail rendering).
   *   2. The derived `MeshSummary` is forwarded to `finishCapture()` →
   *      `runQualityEngine({ meshSummary })` so R6 (wall_coverage) +
   *      R7 (mesh-preference) evaluate against real data.
   * Absent on non-LiDAR / iOS<16 / flag-off — engine takes Plan B path.
   */
  meshClassification?: MeshClassification
  /**
   * Lane 3 V1.6 · Phase 2 · Owner discriminator.
   *
   * - `'craftsman'` (default) — existing HW-flow, anchored to a job /
   *   project / presales-project. Anchor-required throw stays active.
   * - `'customer'` — Customer Self-Scan (Phase 2 Customer-LiDAR-Capture).
   *   May be jobless (DB CHECK `scans_owner_anchor_chk` relaxed by
   *   migration `20260526131000_spatial_v16_phase_2_customer_scan_anchor.sql`).
   *
   * Forwarded to `repo.createScan({ ownerType })` so the row carries the
   * right discriminator for RLS + projection.
   */
  ownerType?: ScanOwnerType
}

export interface CaptureScanResult {
  scan: Scan
  usdzAsset: ScanAsset
  /** SHA-256 hex digest of the captured USDZ — usable for client-side display
   *  ("scan fingerprint") and for de-dup checks against previous captures. */
  sha256: string
}

export async function captureScan(input: CaptureScanInput): Promise<CaptureScanResult> {
  const repo = getSpatialRepository()
  const ownerType: ScanOwnerType = input.ownerType ?? 'craftsman'
  // HW-flow keeps the legacy anchor-required precondition. Customer-flow
  // accepts jobless scans (DB CHECK `scans_owner_anchor_chk` relaxed for
  // owner_type='customer' by Phase 2 Block-1 migration). Customer-jobId is
  // still allowed when the scan is later attached to a job.
  if (
    ownerType !== 'customer' &&
    !input.projectId &&
    !input.jobId &&
    !input.presalesProjectId
  ) {
    throw new Error('captureScan: projectId OR jobId OR presalesProjectId required (DB CHECK).')
  }
  const created = await repo.createScan({
    projectId: input.projectId ?? null,
    jobId: input.jobId ?? null,
    presalesProjectId: input.presalesProjectId ?? null,
    parentScanId: input.parentScanId ?? null,
    source: 'roomplan',
    capturedBy: input.userId,
    deviceMeta: input.deviceMeta ?? {},
    scanStartedAt: Date.now(),
    ownerType,
  } satisfies CreateScanInput)

  // Lane-2.5 · Stream A · IDB pre-upload cache. Best-effort: if the cache
  // write throws (full quota / IDB disabled / private mode), we log + skip;
  // the rest of the capture path is unchanged so the server-side scan row
  // remains the source of truth. Recoverability is degraded in this case
  // (a tab kill would lose the blob), but the user can always retry by
  // running the scan again — same UX as before this cache existed.
  await cacheCapture({
    scanId: created.id,
    presalesProjectId: input.presalesProjectId ?? null,
    jobId: input.jobId ?? null,
    projectId: input.projectId ?? null,
    userId: input.userId,
    usdzBlob: input.usdzBlob,
    deviceMeta: input.deviceMeta,
    meshClassificationJson: input.meshClassification
      ? safeStringify(input.meshClassification)
      : null,
  }).catch((cacheErr) => {
    logWarning('spatial.capture_cache.write_skipped', {
      scanId: created.id,
      message: cacheErr instanceof Error ? cacheErr.message : 'unknown',
    })
  })

  try {
    await startCapture(created.id)
    const uploaded = await uploadScanAsset({
      scanId: created.id,
      userId: input.userId,
      kind: 'usdz',
      blob: input.usdzBlob,
    })
    // Upload succeeded — flag the cache row so the Resume sheet no longer
    // offers a retry for this scan. Best-effort: a failed mark just leaves
    // the row in 'pending' until purgeStaleUploaded / the next sign-out
    // cleanup. Sentry still sees the upload-success breadcrumb via
    // uploadScanAsset's own observability layer.
    void markCaptureUploaded(created.id).catch((markErr) => {
      logWarning('spatial.capture_cache.mark_uploaded_failed', {
        scanId: created.id,
        message: markErr instanceof Error ? markErr.message : 'unknown',
      })
    })
    // Phase 2 · persist mesh aggregate alongside the USDZ. Non-fatal: the
    // upload retry is bounded by uploadScanAsset's own logic, and a failed
    // mesh upload still lets finishCapture run with the in-memory derivation
    // below (Quality Engine receives meshSummary from the live capture, not
    // from storage). We log the failure as a `quality_run` audit later via
    // the meshSummaryUsed flag.
    if (input.meshClassification) {
      await uploadMeshSummaryAsset({
        scanId: created.id,
        userId: input.userId,
        meshClassification: input.meshClassification,
      }).catch(err => {
        // Forensics-only upload — Quality Engine still receives the in-memory
        // meshSummary below regardless of storage outcome. Log so Sentry +
        // Phase 4 Hub diagnostics see the failure; do NOT throw because the
        // capture itself is still valid (USDZ already persisted).
        logError('spatial.mesh_summary_upload_failed', err as Error, {
          scanId: created.id,
        })
      })
    }
    const finished = await finishCapture({
      scanId: created.id,
      fpsSample: input.fpsSample,
      thermalState: input.thermalState,
      durationSec: input.durationSec,
      autoQuality: input.autoQuality,
      meshSummary: meshSummaryFromClassification(input.meshClassification),
    })
    if (input.autoConvert) {
      // Fire-and-forget enqueue. Convert failure is non-fatal because the USDZ
      // is already persisted and viewable via Apple AR Quick Look; the glb is
      // a web-viewer convenience that can always be re-enqueued by an operator.
      void enqueueConvertJob({
        scanId: created.id,
        usdzPath: uploaded.asset.storagePath,
      })
    }
    return {
      scan: finished,
      usdzAsset: uploaded.asset,
      sha256: uploaded.sha256,
    }
  } catch (err) {
    // Flag the cache row first — preserves a recoverable entry the user can
    // resume from the Hub even if the archive() below succeeds. (archive
    // moves the scan to 'archived', and a resume from an archived scan
    // starts a fresh scan-row with the cached blob — see
    // `resumePendingCapture()`.)
    void markCaptureFailed(created.id, err).catch((markErr) => {
      logWarning('spatial.capture_cache.mark_failed_failed', {
        scanId: created.id,
        message: markErr instanceof Error ? markErr.message : 'unknown',
      })
    })
    // Recovery: archive so the scan is not stranded in `capturing` or `draft`.
    // Migration 20260518000072 added the `draft→archived`, `capturing→archived`,
    // and `captured→archived` FSM edges specifically so this recovery path
    // works in all three failure windows (startCapture, upload, finishCapture).
    await archive({
      scanId: created.id,
      reason: 'captureScan_failed',
    }).catch((archiveErr) => {
      // V1.5 hotfix K-4: pre-hotfix this swallowed the V1.5-presales RLS
      // 42501 silently and left orphan `capturing`-rows in prod. Stream-A's
      // helper-fix removes that root-cause; the catch is now reachable
      // only on rare scan-deleted-by-race scenarios. We log so ops can see
      // them in Sentry instead of inferring them from orphan-row counts.
      logError('spatial.capture.archive_recovery_failed', archiveErr as Error, {
        scanId: created.id,
        presalesProjectId: input.presalesProjectId ?? null,
        jobId: input.jobId ?? null,
        projectId: input.projectId ?? null,
      })
    })
    if (err instanceof ScanWorkflowError) throw err
    throw new ScanWorkflowError({
      scanId: created.id,
      action: 'captured',
      message: 'captureScan failed; scan archived (or attempt logged for cleanup)',
      cause: err,
    })
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}
