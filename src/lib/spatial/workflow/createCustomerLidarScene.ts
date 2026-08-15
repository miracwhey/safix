/**
 * Spatial V1.6 · Phase 2 · Customer-LiDAR-Scene Workflow
 *
 * Single-shot orchestration for a Customer-driven LiDAR capture: walks the
 * Capacitor `RoomScanResult` payload through the full domain pipeline —
 *   1. RBAC — userId required.
 *   2. captureScan (ownerType='customer') — creates the scan row, persists
 *      device-meta + mesh-classification + USDZ via the Block B.5 pipeline.
 *      `autoQuality: false` because the Customer surface computes its own
 *      three-tier label (see step 3) rather than relying on the engine's
 *      four-bucket V1 output.
 *   3. Compute Customer quality via `computeCustomerScanQuality` on a
 *      `QualityInput` derived from the RoomScanResult (walls / openings /
 *      area / ceiling-height + mesh-classification when available).
 *   4. Persist score + label on the scan row (F1 columns).
 *   5. Upload the USDZ a second time to the dedicated `spatial-mesh-snapshots`
 *      bucket (F2). Customer surfaces stream from there with their own RLS
 *      policy; the HW pipeline keeps using `project-scans`.
 *
 * Each step has a typed failure: any throw upstream is converted into a
 * `Failure` result so the React hook can render the right toast. Successful
 * steps stay persisted on failure of later steps — by design, so the user
 * can retry the upload without re-capturing the room.
 *
 * Plan binding §6 — this file is NOT re-exported from
 * `src/lib/spatial/workflow/index.ts`. Consumers import directly via
 *
 *   import { createCustomerLidarScene }
 *     from '@/lib/spatial/workflow/createCustomerLidarScene'
 *
 * Rationale: barrel re-exports drag `session.ts`'s module-load
 * `onAuthStateChange` into every offline test (see
 * `feedback_spatial_barrel_no_session_imports`).
 */

import type { RoomScanResult, WallInfo, OpeningInfo } from '@fixup/capacitor-roomplan'

import { promoteScanToScene } from '../canonical/workflow/promoteScanToScene'
import { logError, logInfo } from '../../observability'
import {
  computeCustomerScanQuality,
  type CustomerQualityLabel,
} from '../quality/scanQualityScore'
import { meshSummaryFromClassification } from '../quality/meshSummaryFromClassification'
import type { QualityInput } from '../quality/rules'
import { getSpatialRepository } from '../repository/registry'
import type {
  Scan,
  ScanDeviceMeta,
  ScanMeasurement,
  ScanRoom,
  ScanSurface,
} from '../types'
import { captureScan } from './captureScan'

export type CreateCustomerLidarSceneFailureReason =
  /** Caller did not supply a userId — pre-DB guard. */
  | 'rbac_user_required'
  /** captureScan() threw — scan row may not exist, USDZ may or may not be uploaded. */
  | 'scan_creation_failed'
  /** scan exists, USDZ uploaded, but the F1 quality columns could not be persisted. */
  | 'quality_persist_failed'
  /** scan + quality persisted, but the dedicated mesh-snapshot upload failed. */
  | 'mesh_upload_failed'

export interface CreateCustomerLidarSceneSuccess {
  ok: true
  scanId: string
  /** Storage key of the mesh-snapshot in `spatial-mesh-snapshots` bucket. */
  meshSnapshotPath: string
  /** Computed Customer-Pill data. Persisted on the scan row. */
  quality: { score: number; label: CustomerQualityLabel }
  /**
   * Canonical scene-id wenn die Native-Konversion zu parametric.json
   * erfolgreich war. `null` wenn der Native-Converter nicht verfügbar war
   * (iOS<17 / Web) oder der Capture nicht convertierbar — Scan + USDZ +
   * Quality + Mesh-Snapshot bleiben in allen Fällen persistiert. Der Hub
   * locked dann die Dollhouse/Floorplan/Walk-Modi mit ehrlichem Toast,
   * Customer kann nach einem Re-Scan erneut die parametric-Welle bekommen.
   */
  sceneId: string | null
}

export interface CreateCustomerLidarSceneFailure {
  ok: false
  reason: CreateCustomerLidarSceneFailureReason
  message: string
  /** Raw cause for forensics (Sentry); not user-facing. */
  cause?: unknown
  /** Set when the scan row was created before the failure — lets the UI offer
   *  "retry upload" instead of "re-scan". */
  scanId?: string
}

export type CreateCustomerLidarSceneResult =
  | CreateCustomerLidarSceneSuccess
  | CreateCustomerLidarSceneFailure

export interface CreateCustomerLidarSceneInput {
  /** `auth.uid()` of the customer driving the capture. RLS enforces server-side. */
  userId: string
  /** Optional job anchor — Customer self-scan may be attached to a job (rare),
   *  or fully jobless (typical Phase-2 flow). Forwarded to captureScan. */
  jobId?: string | null
  /** Optional parent for the re-scan chain (B4-D7: re-scan = new scan row,
   *  old stays). */
  parentScanId?: string | null
  /** Full RoomPlan output — walls / openings / area / ceiling-height +
   *  optional `meshClassification` (LiDAR-only). */
  roomScan: RoomScanResult
  /** Captured USDZ blob. Passed separately from `roomScan.usdzPath` because
   *  the plugin's path is a native file handle; the bridge layer converts to a
   *  Blob before reaching the workflow. */
  usdzBlob: Blob
}

/**
 * Helper: project a RoomScanResult onto the Quality-Engine input shape.
 *
 * Exported (read-only) so unit tests can assert the projection independently
 * of the persistence pipeline. The mapping is intentionally minimal: it only
 * carries the fields the Customer-tier quality rules actually consume. The
 * IDs are synthetic ('roomscan-room' etc.) because the Quality Engine is a
 * pure function — it never reaches the DB to resolve them.
 */
export function roomScanToQualityInput(roomScan: RoomScanResult): QualityInput {
  const nowMs = Date.now()
  // Synthetic room — one room per scan in V1 (matches the engine's
  // `input.rooms[0]` indexing).
  const room: ScanRoom = {
    id: 'roomscan-room',
    scanId: 'roomscan-scan',
    name: null,
    areaM2Estimated: roomScan.floorAreaM2,
    areaM2Verified: null,
    ceilingHEstimated: roomScan.ceilingHeightM,
    ceilingHVerified: null,
    floorAnchor: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  }
  // Walls — confidence is omitted (Customer-LiDAR doesn't surface per-wall
  // confidence; R7 falls back to mesh-classification averageConfidence when
  // available, else surface-fallback which is null here = rule no-ops).
  const walls: ScanSurface[] = roomScan.walls.map((w: WallInfo, idx) =>
    minimalSurface({
      idx,
      kind: 'wall',
      width: w.widthM,
      height: w.heightM,
      now: nowMs,
    }),
  )
  const doors: ScanSurface[] = roomScan.doors.map((d: OpeningInfo, idx) =>
    minimalSurface({
      idx: idx + 100,
      kind: 'door',
      width: d.widthM,
      height: d.heightM,
      now: nowMs,
    }),
  )
  const windows: ScanSurface[] = roomScan.windows.map((w: OpeningInfo, idx) =>
    minimalSurface({
      idx: idx + 200,
      kind: 'window',
      width: w.widthM,
      height: w.heightM,
      now: nowMs,
    }),
  )
  const surfaces: ScanSurface[] = [...walls, ...doors, ...windows]
  // Phase 2 measurements are derived from RoomPlan walls/openings via the
  // capture pipeline, not from the live scan result — keep the array empty so
  // the rules that read measurements (currently none, but future R8/R9) treat
  // this as "no measurements yet".
  const measurements: ScanMeasurement[] = []
  return {
    rooms: [room],
    surfaces,
    measurements,
    meshSummary: meshSummaryFromClassification(roomScan.meshClassification),
    // Plugin's `ScanDeviceMeta` is a structural subset of the domain type
    // (same named fields, no open index signature). Widen here.
    deviceMeta: roomScan.deviceMeta as ScanDeviceMeta | undefined,
  }
}

function minimalSurface(args: {
  idx: number
  kind: ScanSurface['kind']
  width: number
  height: number
  now: number
}): ScanSurface {
  return {
    id: `roomscan-surface-${args.idx}`,
    roomId: 'roomscan-room',
    surfaceExternalId: `ext-${args.idx}`,
    kind: args.kind,
    dimWEstimated: args.width,
    dimHEstimated: args.height,
    dimWVerified: null,
    dimHVerified: null,
    transform: null,
    status: 'estimated_roomplan',
    confidence: null,
    createdAt: args.now,
    updatedAt: args.now,
  }
}

export async function createCustomerLidarScene(
  input: CreateCustomerLidarSceneInput,
): Promise<CreateCustomerLidarSceneResult> {
  // 1. RBAC — workflow-layer guard per CLAUDE.md architecture rule. RLS would
  // catch this server-side, but a typed failure here lets the UI render a
  // clean "please sign in" toast instead of a raw 401.
  if (!input.userId || input.userId.trim().length === 0) {
    return {
      ok: false,
      reason: 'rbac_user_required',
      message: 'Anmeldung erforderlich, um einen Scan zu speichern.',
    }
  }

  const repo = getSpatialRepository()

  // 2. captureScan with ownerType='customer'. autoConvert=false because the
  // Customer surface renders directly from the USDZ in `spatial-mesh-snapshots`;
  // no glb round-trip needed for Phase 2.
  let scan: Scan
  try {
    const captureResult = await captureScan({
      userId: input.userId,
      usdzBlob: input.usdzBlob,
      jobId: input.jobId ?? null,
      parentScanId: input.parentScanId ?? null,
      // Plugin's `ScanDeviceMeta` is a structural subset of the domain type
      // (same named fields, no open index signature). Widen at the boundary.
      deviceMeta: input.roomScan.deviceMeta as ScanDeviceMeta | undefined,
      fpsSample: input.roomScan.deviceMeta?.fpsSample,
      thermalState: input.roomScan.deviceMeta?.thermalState,
      durationSec: input.roomScan.deviceMeta?.durationSec,
      meshClassification: input.roomScan.meshClassification,
      ownerType: 'customer',
      // Customer surface computes its own three-tier label below — don't
      // double-run the engine via finishCapture's autoQuality.
      autoQuality: false,
      autoConvert: false,
    })
    scan = captureResult.scan
  } catch (err) {
    logError('spatial.customer_lidar.scan_creation_failed', err, {
      userId: input.userId,
      jobId: input.jobId ?? null,
    })
    return {
      ok: false,
      reason: 'scan_creation_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Scan konnte nicht angelegt werden.',
      cause: err,
    }
  }

  // 3. Compute Customer-Pill quality from the live RoomScanResult. Pure
  // function — no I/O, no throw (the engine clamps + handles edge cases).
  const qualityInput = roomScanToQualityInput(input.roomScan)
  const quality = computeCustomerScanQuality(qualityInput)

  // 4. Persist score + label on the scan row. F1 columns + DB CHECKs.
  try {
    await repo.updateScanQuality({
      scanId: scan.id,
      score: quality.score,
      label: quality.label,
    })
  } catch (err) {
    logError('spatial.customer_lidar.quality_persist_failed', err, {
      scanId: scan.id,
      score: quality.score,
      label: quality.label,
    })
    return {
      ok: false,
      reason: 'quality_persist_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Qualität konnte nicht gespeichert werden.',
      cause: err,
      scanId: scan.id,
    }
  }

  // 5. Upload the USDZ to the dedicated `spatial-mesh-snapshots` bucket.
  // Two uploads on purpose: `captureScan` lands the USDZ in `project-scans`
  // (HW pipeline / dedup / convert), and this second PUT mirrors it into the
  // Customer-RLS-scoped bucket so the Customer-side viewer can stream without
  // crossing the HW RLS boundary.
  let meshSnapshotPath: string
  try {
    const upload = await repo.uploadMeshSnapshot({
      scanId: scan.id,
      userId: input.userId,
      blob: input.usdzBlob,
    })
    meshSnapshotPath = upload.path
  } catch (err) {
    logError('spatial.customer_lidar.mesh_upload_failed', err, {
      scanId: scan.id,
      userId: input.userId,
    })
    return {
      ok: false,
      reason: 'mesh_upload_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Mesh-Snapshot konnte nicht hochgeladen werden.',
      cause: err,
      scanId: scan.id,
    }
  }

  // 6. Promote zu canonical scene (parametric.json) — Provider-Parität für
  // Customer-Scans. RoomPlan-Plugin hält die `CapturedRoom` bis zum nächsten
  // `startScan` im Cache, also greift `promoteScanToScene` direkt auf den
  // soeben abgeschlossenen Capture zu. Best-effort: wenn der Native-Converter
  // nicht verfügbar (iOS<17 / Web) oder convertierbar ist, bleibt der Scan
  // glb-only und der Customer-Hub sperrt die 3-Modi mit Toast — der USDZ +
  // Mesh-Snapshot + Quality sind in jedem Fall persistiert.
  let sceneId: string | null = null
  try {
    const promoted = await promoteScanToScene({
      scanId: scan.id,
      uploaderUserId: input.userId,
      jobId: input.jobId ?? undefined,
    })
    if (promoted.ok) {
      sceneId = promoted.scene.id
    } else {
      logInfo('spatial.customer_lidar.scene_promotion_skipped', {
        scanId: scan.id,
        reason: promoted.reason,
        message: promoted.message,
      })
    }
  } catch (err) {
    logError('spatial.customer_lidar.scene_promotion_threw', err, {
      scanId: scan.id,
    })
  }

  logInfo('spatial.customer_lidar.completed', {
    scanId: scan.id,
    jobId: input.jobId ?? null,
    score: quality.score,
    label: quality.label,
    meshSnapshotPath,
    sceneId,
  })

  return {
    ok: true,
    scanId: scan.id,
    meshSnapshotPath,
    quality,
    sceneId,
  }
}
