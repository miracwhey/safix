/**
 * Spatial · Canonical · Workflow · promoteScanToScene (Szenen-Produktion · B4)
 *
 * The one reusable orchestrator that turns a completed RoomPlan scan into a
 * persisted `spatial_scenes` row — the path that closes Ship-Blocker §4
 * (until now no code ever produced a scene). Customer self-scan (B5),
 * customer re-scan (B8), and worker-walk (B9) are all thin call-sites of this
 * function.
 *
 * Pipeline:
 *   1. Idempotency — `findBySourceScan` short-circuits a re-promotion.
 *   2. Native conversion — `RoomPlan.getCanonicalScene` (AD-1: authoritative).
 *   3. Validation — derive `validation_state` + the dual render/confirm flags
 *      from the document's `validation_report` (fallback: the L1 validator).
 *   4. Client-generated scene id (must exist before the Storage path).
 *   5. Encode — validate + stable-stringify + gzip + SHA the document.
 *   6. Upload — land the gzip blob in the `spatial-parametric` bucket.
 *   7. Insert — `spatial_create_scene` RPC creates the row transactionally.
 *
 * Result-typed: every failure surfaces as a typed {@link PromoteScanResult}
 * with a distinct reason (`convert_failed` / `upload_failed` / `insert_failed`)
 * — no unhandled rejection. A retry after a partial failure is safe: step 1's
 * pre-check plus the RPC's `source_scan_id` idempotency collapse it onto the
 * existing scene; a rare orphan blob (upload-ok / insert-fail) is swept by the
 * `storage-lifecycle` cron (migration 20260518000040).
 */

import { getCanonicalSceneFromNative } from '../bridge/getCanonicalScene.ts'
import { getSpatialSceneRepository } from '../repository/registry.ts'
import type {
  SpatialScene,
  SpatialSceneRepository,
} from '../repository/SpatialSceneRepository.ts'
import type { ValidationState } from '../repository/spatialSceneFsm.ts'
import { CURRENT_SCHEMA_VERSION } from '../schema/version-migration.ts'
import { encodeParametricBlob } from '../storage/parametric-storage.ts'
import {
  buildParametricPath,
  uploadParametricBlob,
} from '../storage/uploadParametricBlob.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import { emptyValidationReport, type ValidationReport } from '../types/validation.ts'
import { runValidator } from '../validator/run-validator.ts'

export interface PromoteScanToSceneInput {
  /** The completed scan to promote (`scans.id`). */
  scanId: string
  /**
   * The uploading user — MUST be the current `auth.uid()`. The parametric
   * blob's Storage path embeds it (bucket INSERT RLS: `foldername[1] = uid`).
   */
  uploaderUserId: string
  /** Optional job context — scene origin + stamped into the canonical document. */
  jobId?: string
  /** Optional project context — stamped into the canonical document metadata. */
  projectId?: string
  /**
   * Re-scan version linkage (D2 · B7). The predecessor scene this capture
   * supersedes. Records as `parent_scene_id` on the new scene (immutable
   * post-insert). When `rescanRequestId` is supplied as well, this parent
   * must match the request's `scene_id` — the RPC enforces it server-side.
   */
  parentSceneId?: string
  /**
   * Re-scan request fulfilled by this capture (D2 · B7). When set, the
   * `spatial_create_scene` RPC enforces request.status='accepted', verifies
   * the caller is the parent scene's customer, and atomically writes the
   * new scene id onto `spatial_rescan_requests.resulting_scene_id`. A request
   * that is already fulfilled short-circuits and returns the existing scene
   * without re-converting (Workflow Pre-Check 1.5).
   */
  rescanRequestId?: string
}

/** Why a {@link promoteScanToScene} call did not produce a scene. */
export type PromoteScanFailure =
  /** Native converter unavailable / no cached scan / converter or schema error. */
  | 'convert_failed'
  /** The parametric-blob upload to Storage failed. */
  | 'upload_failed'
  /** The `spatial_create_scene` RPC rejected the row (ownership / input). */
  | 'insert_failed'

export type PromoteScanResult =
  | { ok: true; scene: SpatialScene; alreadyExisted: boolean }
  | { ok: false; reason: PromoteScanFailure; message: string }

/**
 * Map a validation report onto the scene `validation_state` FSM. A fresh scene
 * starts at `pending`; this is the immediate post-conversion transition target
 * (`pending → passed | passed_with_warnings | blocked`).
 */
function deriveValidationState(report: ValidationReport): ValidationState {
  if (report.errors.length > 0) return 'blocked'
  if (report.warnings.length > 0) return 'passed_with_warnings'
  return 'passed'
}

/**
 * Hub-Card-Hydration (Ü-05): pull `computed_area_m2` + `category` off the
 * RoomScene at promote-time so the Provider-Hub can render them without
 * fetching + gunzipping every parametric blob. Type-guards on each field — a
 * malformed document yields an empty metadata object rather than poisoning
 * the row.
 */
function deriveHubMetadata(document: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const sceneGraph = document.scene_graph as Record<string, unknown> | undefined
  if (!sceneGraph || typeof sceneGraph !== 'object') return out
  if (typeof sceneGraph.computed_area_m2 === 'number' && Number.isFinite(sceneGraph.computed_area_m2)) {
    out.computed_area_m2 = sceneGraph.computed_area_m2
  }
  if (typeof sceneGraph.category === 'string' && sceneGraph.category.length > 0) {
    out.category = sceneGraph.category
  }
  return out
}

/** Structural guard — a plain object carrying the ValidationReport buckets. */
function isValidationReport(value: unknown): value is ValidationReport {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    Array.isArray(r.errors) &&
    Array.isArray(r.warnings) &&
    typeof r.is_renderable === 'boolean' &&
    typeof r.requires_user_confirmation === 'boolean'
  )
}

/**
 * Resolve the canonical validation report for a converter document: the
 * document's own `validation_report` when present + well-formed, otherwise a
 * fresh run of the pure L1 scene-validator over its `scene_graph`.
 */
function resolveValidationReport(
  document: Record<string, unknown>,
  scanId: string,
): ValidationReport {
  const embedded = document.validation_report
  if (isValidationReport(embedded)) return embedded
  // Fallback — the native converter normally emits validation_report; if it is
  // missing/malformed, run the pure validator over the scene graph.
  try {
    return runValidator(document.scene_graph as RoomScene)
  } catch {
    return emptyValidationReport(scanId, new Date().toISOString())
  }
}

/**
 * Promote a completed scan to a canonical scene. Pure result-type API —
 * never throws.
 *
 * @param input  scan + uploader + optional job/project context.
 * @param repo   scene repository — defaults to the registry-resolved one;
 *               inject an InMemory repository in tests.
 */
export async function promoteScanToScene(
  input: PromoteScanToSceneInput,
  repo: SpatialSceneRepository = getSpatialSceneRepository(),
): Promise<PromoteScanResult> {
  const { scanId, uploaderUserId, jobId, projectId, parentSceneId, rescanRequestId } =
    input

  // 1 · Idempotency — one scan → one scene. A re-promotion returns the
  //     existing scene rather than creating a duplicate.
  const existing = await repo.findBySourceScan(scanId)
  if (existing) {
    return { ok: true, scene: existing, alreadyExisted: true }
  }

  // 1.5 · Re-scan-request idempotency (D2 · B7). A request that already has
  //       a resulting scene short-circuits before we touch the native
  //       converter — saves the round-trip + avoids leaving an orphan blob
  //       in Storage. The RPC short-circuits server-side too, but doing it
  //       here also skips the convert/encode/upload work.
  if (rescanRequestId) {
    const request = await repo.findRescanRequestById(rescanRequestId)
    if (request?.resultingSceneId) {
      const linked = await repo.findById(request.resultingSceneId)
      if (linked) {
        return { ok: true, scene: linked, alreadyExisted: true }
      }
    }
  }

  // 2 · Native canonical conversion.
  const converted = await getCanonicalSceneFromNative({ scanId, jobId, projectId })
  if (!converted.ok) {
    return { ok: false, reason: 'convert_failed', message: converted.message }
  }
  const document = converted.document

  // 3 · Validation outcome → scene validation_state + dual render/confirm flags.
  const report = resolveValidationReport(document, scanId)
  const validationState = deriveValidationState(report)
  const schemaVersion =
    typeof document.schema_version === 'string'
      ? document.schema_version
      : CURRENT_SCHEMA_VERSION

  // 4 · Client-generated scene id — must exist before the Storage blob path.
  const sceneId = crypto.randomUUID()

  // 5 · Encode — schema-validate + stable-stringify + gzip + SHA. A
  //     schema-invalid document the converter produced surfaces here.
  let encoded: Awaited<ReturnType<typeof encodeParametricBlob>>
  try {
    encoded = await encodeParametricBlob(document)
  } catch (e) {
    return {
      ok: false,
      reason: 'convert_failed',
      message: e instanceof Error ? e.message : 'Aufmaß-Dokument ist ungültig.',
    }
  }

  // 6 · Upload the blob. The uploaded bytes' SHA is the same value recorded on
  //     the row below — `loadParametricBlob` verifies that content address.
  const path = buildParametricPath(uploaderUserId, sceneId, encoded.sha256)
  const uploaded = await uploadParametricBlob(path, encoded.bytes)
  if (!uploaded.ok) {
    return { ok: false, reason: 'upload_failed', message: uploaded.error }
  }

  // 7 · Create the scene row via the spatial_create_scene RPC (ownership +
  //     idempotency + owner-derivation server-side). parent_scene_id +
  //     rescan_request_id flow through to the RPC's D2 linkage logic.
  try {
    const scene = await repo.create({
      id: sceneId,
      sourceScanId: scanId,
      sourceJobId: jobId ?? null,
      parametricStoragePath: uploaded.path,
      parametricSha256: encoded.sha256,
      parametricSizeBytes: encoded.sizeBytes,
      schemaVersion,
      validationState,
      validationReport: report as unknown as Record<string, unknown>,
      isRenderable: report.is_renderable,
      requiresUserConfirmation: report.requires_user_confirmation,
      parentSceneId: parentSceneId ?? null,
      rescanRequestId: rescanRequestId ?? null,
      metadata: deriveHubMetadata(document),
    })
    return { ok: true, scene, alreadyExisted: false }
  } catch (e) {
    return {
      ok: false,
      reason: 'insert_failed',
      message: e instanceof Error ? e.message : 'Szene konnte nicht gespeichert werden.',
    }
  }
}
